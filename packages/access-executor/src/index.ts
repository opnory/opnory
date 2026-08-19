import { getLogger } from "@opnory/observability";
import { v4 as uuidv4 } from "uuid";
import { ApprovedAccessRequest, ExecutionResult, ExternalIdentity } from "@opnory/access-types";
import { AuditEventStore, InMemoryAuditEventStore, recordAuditEvent } from "@opnory/access-audit";
import { Octokit } from "@octokit/rest";
import { createAppAuth } from "@octokit/auth-app";

const logger = getLogger().child({ component: "access-executor" });

// ============================================================================
// Access Executor Interface
// ============================================================================

export interface AccessExecutor {
  grant(request: ApprovedAccessRequest): Promise<ExecutionResult>;
  revoke?(request: ApprovedAccessRequest): Promise<ExecutionResult>;
}

// ============================================================================
// Idempotency Store
// ============================================================================

export class InMemoryIdempotencyStore {
  private fulfilledKeys: Set<string> = new Set();

  checkAndMark(key: string): boolean {
    if (this.fulfilledKeys.has(key)) {
      return false; // Already fulfilled
    }
    this.fulfilledKeys.add(key);
    return true; // First time
  }

  isFulfilled(key: string): boolean {
    return this.fulfilledKeys.has(key);
  }

  clear(key: string): void {
    this.fulfilledKeys.delete(key);
  }
}

// ============================================================================
// Fake GitHub Access Executor (for testing)
// ============================================================================

export class FakeGitHubAccessExecutor implements AccessExecutor {
  private idempotencyStore: InMemoryIdempotencyStore;
  private auditStore: AuditEventStore;
  private shouldFail: boolean = false;
  private failReason: string = "Simulated failure";

  constructor(
    idempotencyStore?: InMemoryIdempotencyStore,
    auditStore?: AuditEventStore
  ) {
    this.idempotencyStore = idempotencyStore || new InMemoryIdempotencyStore();
    this.auditStore = auditStore || new InMemoryAuditEventStore();
  }

  setFailureMode(shouldFail: boolean, reason?: string): void {
    this.shouldFail = shouldFail;
    if (reason) this.failReason = reason;
  }

  async grant(request: ApprovedAccessRequest): Promise<ExecutionResult> {
    // Build idempotency key: accessRequestId + entitlementId + subjectId
    const idempotencyKey = `${request.id}:${request.entitlement.id}:${request.requesterId}`;

    logger.info({ requestId: request.id, idempotencyKey }, "Executing access grant");

    // Check idempotency
    const isFirstAttempt = this.idempotencyStore.checkAndMark(idempotencyKey);
    if (!isFirstAttempt) {
      logger.info({ requestId: request.id, idempotencyKey }, "Idempotency check: already fulfilled");
      await recordAuditEvent(this.auditStore, {
        eventId: uuidv4(),
        requestId: request.id,
        correlationId: request.correlationId,
        actor: "system",
        timestamp: new Date().toISOString(),
        type: "IDEMPOTENCY_CHECK",
        metadata: {
          idempotencyKey,
          result: "DUPLICATE",
          message: "Fulfillment already completed for this request",
        },
      });

      return {
        success: true,
        externalId: `github-membership-${request.requesterId}`,
        message: "Access already granted (idempotent)",
      };
    }

    // Record fulfillment started
    await recordAuditEvent(this.auditStore, {
      eventId: uuidv4(),
      requestId: request.id,
      correlationId: request.correlationId,
      actor: "system",
      timestamp: new Date().toISOString(),
      type: "FULFILLMENT_STARTED",
      metadata: {
        entitlementId: request.entitlement.id,
        entitlementName: request.entitlement.name,
        idempotencyKey,
      },
    });

    // Simulate execution delay
    await new Promise((resolve) => setTimeout(resolve, 100));

    if (this.shouldFail) {
      const error = this.failReason;
      const isReconciliationFailure = error.toLowerCase().includes("reconciliation") || error.toLowerCase().includes("verification");

      await recordAuditEvent(this.auditStore, {
        eventId: uuidv4(),
        requestId: request.id,
        correlationId: request.correlationId,
        actor: "system",
        timestamp: new Date().toISOString(),
        type: "FULFILLMENT_FAILED",
        metadata: {
          entitlementId: request.entitlement.id,
          error,
          reconciliation: isReconciliationFailure,
        },
      });

      logger.error({ requestId: request.id, error }, "Fulfillment failed");
      return {
        success: false,
        message: "Failed to grant access",
        error,
      };
    }

    // Simulate successful GitHub API call
    const externalId = `github-membership-${request.requesterId}-${request.entitlement.id.slice(0, 8)}`;

    await recordAuditEvent(this.auditStore, {
      eventId: uuidv4(),
      requestId: request.id,
      correlationId: request.correlationId,
      actor: "system",
      timestamp: new Date().toISOString(),
      type: "FULFILLMENT_SUCCEEDED",
      metadata: {
        entitlementId: request.entitlement.id,
        externalId,
        entitlementName: request.entitlement.name,
      },
    });

    logger.info({ requestId: request.id, externalId }, "Access granted successfully");

    return {
      success: true,
      externalId,
      message: `Successfully granted ${request.entitlement.name} access`,
    };
  }

  async revoke(request: ApprovedAccessRequest): Promise<ExecutionResult> {
    // Build idempotency key for revocation
    const idempotencyKey = `revoke:${request.id}:${request.entitlement.id}:${request.requesterId}`;

    logger.info({ requestId: request.id, idempotencyKey }, "Executing access revocation");

    const isFirstAttempt = this.idempotencyStore.checkAndMark(idempotencyKey);
    if (!isFirstAttempt) {
      return {
        success: true,
        message: "Access already revoked (idempotent)",
      };
    }

    await recordAuditEvent(this.auditStore, {
      eventId: uuidv4(),
      requestId: request.id,
      correlationId: request.correlationId,
      actor: "system",
      timestamp: new Date().toISOString(),
      type: "FULFILLMENT_SUCCEEDED",
      metadata: {
        entitlementId: request.entitlement.id,
        action: "revoke",
      },
    });

    return {
      success: true,
      message: `Successfully revoked ${request.entitlement.name} access`,
    };
  }
}

// ============================================================================
// GitHub Team Membership Types
// ============================================================================

export interface GitHubTeamMembership {
  url: string;
  role: "member" | "maintainer";
  state: "active" | "pending";
  user: {
    login: string;
    id: number;
  };
}

export interface GitHubExecutorConfig {
  appId: string;
  installationId: string;
  privateKey: string;
  // Allowlist - independent of entitlement data
  allowedOrganizations: string[];
  allowedTeams: string[];
}

// ============================================================================
// Real GitHub Access Executor (with reconciliation)
// ============================================================================

export class GitHubAccessExecutor implements AccessExecutor {
  private config: GitHubExecutorConfig;
  private idempotencyStore: InMemoryIdempotencyStore;
  private auditStore: AuditEventStore;
  private octokit: Octokit;

  constructor(
    config: GitHubExecutorConfig,
    idempotencyStore?: InMemoryIdempotencyStore,
    auditStore?: AuditEventStore,
    octokit?: Octokit // For testing: inject mock Octokit
  ) {
    this.config = config;
    this.idempotencyStore = idempotencyStore || new InMemoryIdempotencyStore();
    this.auditStore = auditStore || new InMemoryAuditEventStore();

    // Initialize Octokit with GitHub App installation authentication
    // Allow injection for testing
    if (octokit) {
      this.octokit = octokit;
    } else {
      this.octokit = new Octokit({
        authStrategy: createAppAuth,
        auth: {
          appId: config.appId,
          privateKey: config.privateKey,
          installationId: config.installationId,
        },
      });
    }
  }

  /**
   * Validates that the entitlement's org/team is in the allowlist
   * This prevents a compromised/malformed entitlement from targeting arbitrary orgs/teams
   */
  private validateAllowlist(org: string, teamSlug: string): void {
    if (!this.config.allowedOrganizations.includes(org)) {
      throw new Error(`Organization '${org}' is not in the allowlist: ${this.config.allowedOrganizations.join(", ")}`);
    }
    if (!this.config.allowedTeams.includes(teamSlug)) {
      throw new Error(`Team '${teamSlug}' is not in the allowlist: ${this.config.allowedTeams.join(", ")}`);
    }
  }

  /**
   * Pre-flight checks before any mutation
   * Validates installation auth, allowlist, and verified identity
   */
  private async preflightChecks(request: ApprovedAccessRequest): Promise<{ org: string; teamSlug: string; teamRole: "member" | "maintainer"; githubLogin: string }> {
    // Extract GitHub-specific config from entitlement
    const githubConfig = request.entitlement.githubConfig;
    if (!githubConfig) {
      throw new Error("Entitlement missing githubConfig");
    }

    const org = githubConfig.organization;
    const teamSlug = githubConfig.teamSlug;
    const teamRole = githubConfig.teamRole;

    // 1. Validate against allowlist (fail fast - no API calls)
    this.validateAllowlist(org, teamSlug);

    // 2. Get verified GitHub login from externalIdentities
    const githubLogin = this.getGitHubLogin(request);

    // 3. Verify installation authentication works (GET /app/installations/{installation_id})
    // This confirms the installation resolves to the expected org
    try {
      const installation = await this.octokit.request("GET /app/installations/{installation_id}", {
        installation_id: Number(this.config.installationId),
      });
      const account = installation.data.account;
      // account can be User or Organization, both have login
      const accountLogin = (account as { login: string })?.login;
      if (accountLogin !== org) {
        throw new Error(`Installation ${this.config.installationId} belongs to ${accountLogin}, not ${org}`);
      }
      logger.info({ installationId: this.config.installationId, accountLogin }, "Installation verified");
    } catch (error) {
      if (error instanceof Error && error.message.includes("belongs to")) {
        throw error;
      }
      throw new Error(`Failed to verify installation: ${error instanceof Error ? error.message : "Unknown error"}`);
    }

    logger.info({ org, teamSlug, githubLogin, teamRole }, "Pre-flight checks passed");
    return { org, teamSlug, teamRole, githubLogin };
  }

  /**
   * Validates and extracts the verified GitHub username from the request
   * The request must contain a verified github identity in externalIdentities
   */
  private getGitHubLogin(request: ApprovedAccessRequest): string {
    const githubIdentity = request.externalIdentities?.github;
    if (!githubIdentity) {
      throw new Error("Request missing github identity in externalIdentities");
    }
    if (!githubIdentity.verified) {
      throw new Error("GitHub identity not verified - cannot provision");
    }
    if (!githubIdentity.login || typeof githubIdentity.login !== "string" || githubIdentity.login.trim() === "") {
      throw new Error("GitHub identity missing login");
    }
    return githubIdentity.login.trim();
  }

  /**
   * GET existing team membership
   * Uses team-slug endpoint: GET /orgs/{org}/teams/{team_slug}/memberships/{username}
   */
  private async getTeamMembership(org: string, teamSlug: string, username: string): Promise<{ membership: GitHubTeamMembership | null; exists: boolean }> {
    try {
      const response = await this.octokit.request("GET /orgs/{org}/teams/{team_slug}/memberships/{username}", {
        org,
        team_slug: teamSlug,
        username,
      });

      return {
        membership: response.data as GitHubTeamMembership,
        exists: true,
      };
    } catch (error: unknown) {
      if (error && typeof error === "object" && "status" in error && (error as { status: number }).status === 404) {
        return { membership: null, exists: false };
      }
      throw error;
    }
  }

  /**
   * PUT team membership (add or update)
   * Uses team-slug endpoint: PUT /orgs/{org}/teams/{team_slug}/memberships/{username}
   */
  private async putTeamMembership(org: string, teamSlug: string, username: string, role: "member" | "maintainer"): Promise<GitHubTeamMembership> {
    const response = await this.octokit.request("PUT /orgs/{org}/teams/{team_slug}/memberships/{username}", {
      org,
      team_slug: teamSlug,
      username,
      role,
    });

    return response.data as GitHubTeamMembership;
  }

  /**
   * DELETE team membership (revoke)
   * Uses team-slug endpoint: DELETE /orgs/{org}/teams/{team_slug}/memberships/{username}
   */
  private async deleteTeamMembership(org: string, teamSlug: string, username: string): Promise<void> {
    await this.octokit.request("DELETE /orgs/{org}/teams/{team_slug}/memberships/{username}", {
      org,
      team_slug: teamSlug,
      username,
    });
  }

  async grant(request: ApprovedAccessRequest): Promise<ExecutionResult> {
    const idempotencyKey = `${request.id}:${request.entitlement.id}:${request.requesterId}`;

    logger.info({ requestId: request.id, idempotencyKey }, "Executing GitHub access grant");

    const isFirstAttempt = this.idempotencyStore.checkAndMark(idempotencyKey);
    if (!isFirstAttempt) {
      logger.info({ requestId: request.id, idempotencyKey }, "Idempotency check: already fulfilled");
      await recordAuditEvent(this.auditStore, {
        eventId: uuidv4(),
        requestId: request.id,
        correlationId: request.correlationId,
        actor: "system",
        timestamp: new Date().toISOString(),
        type: "IDEMPOTENCY_CHECK",
        metadata: {
          idempotencyKey,
          result: "DUPLICATE",
          message: "Fulfillment already completed for this request",
        },
      });

      return {
        success: true,
        externalId: `github-team-membership-${request.requesterId}`,
        message: "Access already granted (idempotent)",
      };
    }

    await recordAuditEvent(this.auditStore, {
      eventId: uuidv4(),
      requestId: request.id,
      correlationId: request.correlationId,
      actor: "system",
      timestamp: new Date().toISOString(),
      type: "FULFILLMENT_STARTED",
      metadata: {
        entitlementId: request.entitlement.id,
        entitlementName: request.entitlement.name,
        idempotencyKey,
        executor: "github",
      },
    });

    try {
      // Pre-flight checks (installation auth, allowlist, verified identity)
      const { org, teamSlug, teamRole, githubLogin } = await this.preflightChecks(request);

      // Step 1: Check existing membership
      const existingMembership = await this.getTeamMembership(org, teamSlug, githubLogin);

      if (existingMembership.exists && existingMembership.membership) {
        // Already a member - check if role matches
        if (existingMembership.membership.state === "active" && existingMembership.membership.role === teamRole) {
          // Idempotent success - already in correct state
          await recordAuditEvent(this.auditStore, {
            eventId: uuidv4(),
            requestId: request.id,
            correlationId: request.correlationId,
            actor: "system",
            timestamp: new Date().toISOString(),
            type: "FULFILLMENT_SUCCEEDED",
            metadata: {
              entitlementId: request.entitlement.id,
              externalId: `github-team-membership-${githubLogin}-${org}-${teamSlug}`,
              entitlementName: request.entitlement.name,
              reconciled: true,
              idempotent: true,
              membershipState: "active",
              membershipRole: teamRole,
            },
          });

          logger.info({ requestId: request.id, githubLogin, org, teamSlug }, "Already member with correct role - idempotent success");
          return {
            success: true,
            externalId: `github-team-membership-${githubLogin}-${org}-${teamSlug}`,
            message: `Already member of ${teamSlug} with role ${teamRole}`,
          };
        }

        if (existingMembership.membership?.state === "pending") {
          // Membership is pending - transition to AWAITING_EXTERNAL_ACCEPTANCE
          await recordAuditEvent(this.auditStore, {
            eventId: uuidv4(),
            requestId: request.id,
            correlationId: request.correlationId,
            actor: "system",
            timestamp: new Date().toISOString(),
            type: "FULFILLMENT_SUCCEEDED",
            metadata: {
              entitlementId: request.entitlement.id,
              externalId: `github-team-membership-${githubLogin}-${org}-${teamSlug}`,
              entitlementName: request.entitlement.name,
              reconciled: true,
              membershipState: "pending",
              awaitingExternalAcceptance: true,
            },
          });

          logger.info({ requestId: request.id, githubLogin, org, teamSlug }, "Membership pending - awaiting external acceptance");
          return {
            success: true,
            externalId: `github-team-membership-${githubLogin}-${org}-${teamSlug}`,
            message: "Membership invitation sent - awaiting user acceptance",
            status: "AWAITING_EXTERNAL_ACCEPTANCE",
          };
        }
      }

      // Step 2: PUT team membership (add or update)
      const membership = await this.putTeamMembership(org, teamSlug, githubLogin, teamRole);

      // Step 3: RECONCILIATION - Read back membership to verify
      // Note: GitHub may return immediately, but we verify the state
      const verification = await this.getTeamMembership(org, teamSlug, githubLogin);

      if (!verification.exists) {
        throw new Error("Membership not found after PUT - reconciliation failed");
      }

      const reconciledMembership = verification.membership!;

      // Check the membership state AND role match
      if (reconciledMembership.state === "active" && reconciledMembership.role === teamRole) {
        // Success - verified active membership with correct role
        const externalId = `github-team-membership-${githubLogin}-${org}-${teamSlug}`;

        await recordAuditEvent(this.auditStore, {
          eventId: uuidv4(),
          requestId: request.id,
          correlationId: request.correlationId,
          actor: "system",
          timestamp: new Date().toISOString(),
          type: "FULFILLMENT_SUCCEEDED",
          metadata: {
            entitlementId: request.entitlement.id,
            externalId,
            entitlementName: request.entitlement.name,
            reconciled: true,
            membershipState: "active",
            membershipRole: reconciledMembership.role,
            githubUserId: reconciledMembership.user.id,
            // Safe diagnostic metadata
            provider: "github",
            organization: org,
            teamSlug: teamSlug,
            githubLogin: githubLogin,
            requestedRole: teamRole,
            reconciledState: "active",
            reconciledRole: reconciledMembership.role,
          },
        });

        logger.info({ requestId: request.id, githubLogin, org, teamSlug, role: reconciledMembership.role }, "Access granted and verified successfully");
        return {
          success: true,
          externalId,
          message: `Successfully granted ${request.entitlement.name} access (verified)`,
        };
      } else if (reconciledMembership.state === "active" && reconciledMembership.role !== teamRole) {
        // Role mismatch - reconciliation succeeded but role doesn't match requested
        const errorMessage = `Reconciliation role mismatch: requested ${teamRole}, got ${reconciledMembership.role}`;

        await recordAuditEvent(this.auditStore, {
          eventId: uuidv4(),
          requestId: request.id,
          correlationId: request.correlationId,
          actor: "system",
          timestamp: new Date().toISOString(),
          type: "FULFILLMENT_FAILED",
          metadata: {
            entitlementId: request.entitlement.id,
            error: errorMessage,
            reason: "RECONCILIATION_MISMATCH",
            provider: "github",
            organization: org,
            teamSlug: teamSlug,
            githubLogin: githubLogin,
            requestedRole: teamRole,
            reconciledState: "active",
            reconciledRole: reconciledMembership.role,
          },
        });

        logger.warn({ requestId: request.id, githubLogin, org, teamSlug, requestedRole: teamRole, actualRole: reconciledMembership.role }, "Reconciliation role mismatch");
        return {
          success: false,
          message: errorMessage,
          error: errorMessage,
          status: "FAILED",
          reason: "RECONCILIATION_MISMATCH",
        };
      } else if (reconciledMembership.state === "pending") {
        // Membership is pending - user needs to accept invitation
        const externalId = `github-team-membership-${githubLogin}-${org}-${teamSlug}`;

        await recordAuditEvent(this.auditStore, {
          eventId: uuidv4(),
          requestId: request.id,
          correlationId: request.correlationId,
          actor: "system",
          timestamp: new Date().toISOString(),
          type: "FULFILLMENT_SUCCEEDED",
          metadata: {
            entitlementId: request.entitlement.id,
            externalId,
            entitlementName: request.entitlement.name,
            reconciled: true,
            membershipState: "pending",
            awaitingExternalAcceptance: true,
            githubUserId: reconciledMembership.user.id,
          },
        });

        logger.info({ requestId: request.id, githubLogin, org, teamSlug }, "Membership pending - awaiting external acceptance");
        return {
          success: true,
          externalId,
          message: "Membership invitation sent - awaiting user acceptance",
          status: "AWAITING_EXTERNAL_ACCEPTANCE",
        };
      } else {
        throw new Error(`Unexpected membership state: ${reconciledMembership.state}`);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      
      // More precise detection of externally managed team (team-sync)
      // GitHub returns specific error for team-sync: "Team is managed by an external identity provider"
      const isExternalAuthorityManaged = errorMessage.includes("team_sync") || 
        errorMessage.includes("managed by external") ||
        errorMessage.includes("managed by an external identity provider");

      await recordAuditEvent(this.auditStore, {
        eventId: uuidv4(),
        requestId: request.id,
        correlationId: request.correlationId,
        actor: "system",
        timestamp: new Date().toISOString(),
        type: "FULFILLMENT_FAILED",
        metadata: {
          entitlementId: request.entitlement.id,
          error: errorMessage,
          externalAuthorityManaged: isExternalAuthorityManaged,
          authority: isExternalAuthorityManaged ? "github-team-sync" : undefined,
          // Safe diagnostic metadata (no tokens, no PEM, no auth headers)
          provider: "github",
          organization: request.entitlement.githubConfig?.organization,
          teamSlug: request.entitlement.githubConfig?.teamSlug,
          requestedRole: request.entitlement.githubConfig?.teamRole,
          githubLogin: request.externalIdentities?.github?.login,
        },
      });

      if (isExternalAuthorityManaged) {
        logger.warn({ requestId: request.id, error: errorMessage }, "Team membership managed by external authority (e.g., Okta/Entra ID)");
        return {
          success: false,
          message: "Team membership is managed by an external identity provider (e.g., Okta/Entra ID). Cannot modify via GitHub API.",
          error: errorMessage,
          reason: "EXTERNAL_AUTHORITY_MANAGED",
          authority: "github-team-sync",
        };
      }

      logger.error({ requestId: request.id, error: errorMessage }, "GitHub fulfillment failed");
      return {
        success: false,
        message: "Failed to grant access",
        error: errorMessage,
      };
    }
  }

  async revoke(request: ApprovedAccessRequest): Promise<ExecutionResult> {
    const idempotencyKey = `revoke:${request.id}:${request.entitlement.id}:${request.requesterId}`;

    logger.info({ requestId: request.id, idempotencyKey }, "Executing GitHub access revocation");

    const isFirstAttempt = this.idempotencyStore.checkAndMark(idempotencyKey);
    if (!isFirstAttempt) {
      return {
        success: true,
        message: "Access already revoked (idempotent)",
      };
    }

    try {
      // Pre-flight checks (installation auth, allowlist, verified identity)
      const { org, teamSlug, githubLogin } = await this.preflightChecks(request);

      // Delete team membership
      await this.deleteTeamMembership(org, teamSlug, githubLogin);

      // Verify revocation by checking membership
      const verification = await this.getTeamMembership(org, teamSlug, githubLogin);
      
      if (verification.exists && verification.membership?.state === "active") {
        // If still active, something went wrong
        throw new Error("Revocation verification failed - user still has active membership");
      }

      await recordAuditEvent(this.auditStore, {
        eventId: uuidv4(),
        requestId: request.id,
        correlationId: request.correlationId,
        actor: "system",
        timestamp: new Date().toISOString(),
        type: "FULFILLMENT_SUCCEEDED",
        metadata: {
          entitlementId: request.entitlement.id,
          action: "revoke",
          reconciled: true,
          org,
          teamSlug,
          githubLogin,
        },
      });

      return {
        success: true,
        message: `Successfully revoked ${request.entitlement.name} access`,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      logger.error({ requestId: request.id, error: errorMessage }, "Revocation failed");
      return {
        success: false,
        message: "Failed to revoke access",
        error: errorMessage,
      };
    }
  }
}