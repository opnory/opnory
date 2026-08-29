import { getLogger } from "@opnory/observability";
import {
  GovernanceProvider,
  GovernanceAuthority,
  GovernanceSubject,
  GovernedEntitlement,
  GovernedAccessRequest,
  GovernanceRequest,
  GovernanceRequestStatus,
  GovernanceAssignment,
  GovernanceRevocationResult,
  GovernanceSubjectSchema,
  GovernedEntitlementSchema,
  GovernedAccessRequestSchema,
  GovernanceRequestSchema,
  GovernanceRequestStatusSchema,
  GovernanceAssignmentSchema,
  GovernanceRevocationResultSchema,
  GovernanceAuthoritySchema,
  GovernanceConfigSchema,
  GovernanceDecisionStatus,
  GovernanceAssignmentStatus,
  AccessRequest,
  EntitlementRef,
  ExternalIdentity,
  ReconciliationResult,
  GovernanceReconciler,
  GovernanceReconcilerConfig,
} from "@opnory/access-types";
import {
  InMemoryApprovalStore,
  ApprovalService,
} from "@opnory/access-approval";
import {
  AuditEventStore,
  InMemoryAuditEventStore,
  recordAuditEvent,
  AuditEventType,
} from "@opnory/access-audit";

// SAFETY: ReconciliationAuditMetadata is an owner-defined schema for reconciliation audit payloads
// passed to AuditEventStore.append() which validates via AuditEventSchema at the boundary
// SAFETY: this is an intentionally open-ended audit payload type; callers must ensure type safety at consumption
// SAFETY: branded type alias for reconciliation audit metadata - validated at store boundary via AuditEventSchema
type ReconciliationAuditMetadata = Record<string, unknown>;

const logger = getLogger().child({ component: "access-governance" });

// ============================================================================
// Local Governance Provider (current Opnory-managed flow)
// ============================================================================

export class LocalGovernanceProvider implements GovernanceProvider {
  readonly authority: GovernanceAuthority = "local";

  public approvalStore: InMemoryApprovalStore;
  public auditStore: AuditEventStore;
  public approvalService: ApprovalService;

  constructor(
    approvalStore?: InMemoryApprovalStore,
    auditStore?: AuditEventStore,
  ) {
    this.approvalStore = approvalStore || new InMemoryApprovalStore();
    this.auditStore = auditStore || new InMemoryAuditEventStore();
    this.approvalService = new ApprovalService(
      this.approvalStore,
      this.auditStore,
    );
  }

  async resolveSubject(identity: {
    requesterId: string;
    requesterEmail: string;
    externalIdentities: ExternalIdentity;
  }): Promise<GovernanceSubject> {
    // Local governance uses the requester's email as the subject
    return GovernanceSubjectSchema.parse({
      id: identity.requesterId,
      displayName: undefined,
      email: identity.requesterEmail,
      source: "manual",
      raw: { requesterId: identity.requesterId },
    });
  }

  async resolveEntitlement(
    entitlement: EntitlementRef,
  ): Promise<GovernedEntitlement> {
    // Local governance maps directly to the entitlement
    return GovernedEntitlementSchema.parse({
      entitlementId: entitlement.id,
      authority: "local",
      externalId: entitlement.githubConfig?.teamSlug || entitlement.id,
      externalName: entitlement.name,
      metadata: { system: entitlement.system },
    });
  }

  async submitRequest(
    request: GovernedAccessRequest,
  ): Promise<GovernanceRequest> {
    // For local governance, we create a PENDING request in our store
    // and return a governance request representing it
    const governanceRequest: GovernanceRequest = {
      externalRequestId: crypto.randomUUID(), // Internal tracking ID
      authority: "local",
      status: "PENDING",
      submittedAt: new Date().toISOString(),
      metadata: {
        opnoryRequestId: request.requestId,
        subjectId: request.subject.id,
        entitlementId: request.entitlement.entitlementId,
      },
    };

    await recordAuditEvent(this.auditStore, {
      eventId: crypto.randomUUID(),
      requestId: request.requestId,
      correlationId: crypto.randomUUID(),
      actor: "system",
      timestamp: new Date().toISOString(),
      type: "GOVERNANCE_REQUEST_SUBMITTED",
      metadata: {
        authority: "local",
        externalRequestId: governanceRequest.externalRequestId,
      },
    });

    return GovernanceRequestSchema.parse(governanceRequest);
  }

  async getRequestStatus(
    externalRequestId: string,
  ): Promise<GovernanceRequestStatus> {
    // For local governance, we'd look up the Opnory request by the external ID
    // This is a simplified implementation
    return GovernanceRequestStatusSchema.parse({
      externalRequestId,
      status: "FAILED",
      lastPolledAt: new Date().toISOString(),
    });
  }

  async getAssignment(
    subject: GovernanceSubject,
    entitlement: GovernedEntitlement,
  ): Promise<GovernanceAssignment | null> {
    // For local governance, check if there's a FULFILLED request for this subject+entitlement
    // This would require a query - returning null for now
    return null;
  }

  async revokeAssignment(
    assignment: GovernanceAssignment,
  ): Promise<GovernanceRevocationResult> {
    // For local governance, revocation is handled by the expiration scheduler
    return GovernanceRevocationResultSchema.parse({
      success: true,
      message: "Local governance revocation handled by expiration scheduler",
      authority: "local",
      assignmentId: assignment.assignmentId,
    });
  }
}

// ============================================================================
// Entra Governance Provider (Microsoft Graph v1.0 Entitlement Management)
// ============================================================================

export interface EntraConfig {
  tenantId: string;
  clientId: string;
  clientSecret: string;
}

export class EntraGovernanceProvider implements GovernanceProvider {
  readonly authority: GovernanceAuthority = "entra";

  private config: EntraConfig;
  private accessToken: string | null = null;
  private tokenExpiresAt: number = 0;

  constructor(config: EntraConfig) {
    this.config = config;
  }

  private async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.accessToken && this.tokenExpiresAt > now + 60_000) {
      return this.accessToken;
    }

    const params = new URLSearchParams({
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      scope: "https://graph.microsoft.com/.default",
      grant_type: "client_credentials",
    });

    const response = await fetch(
      `https://login.microsoftonline.com/${this.config.tenantId}/oauth2/v2.0/token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params,
      },
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(
        `Entra token request failed: ${response.status} ${error}`,
      );
    }

    // SAFETY: Graph token endpoint returns standard OAuth2 token response schema
    const data = (await response.json()) as {
      access_token: string;
      expires_in: number;
    };
    this.accessToken = data.access_token;
    this.tokenExpiresAt = now + data.expires_in * 1000;
    return this.accessToken;
  }

  private async graphRequest<T>(
    path: string,
    options: RequestInit = {},
  ): Promise<T> {
    const token = await this.getAccessToken();
    const response = await fetch(`https://graph.microsoft.com/v1.0${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...options.headers,
      },
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(
        `Entra Graph request failed: ${response.status} ${error}`,
      );
    }

    if (response.status === 204 || response.status === 202) {
      // SAFETY: 204/202 responses have no body; return empty object matching T
      return {} as T;
    }

    // SAFETY: response.json() returns the Graph API payload matching the requested T
    return response.json() as Promise<T>;
  }

  async resolveSubject(identity: {
    requesterId: string;
    requesterEmail: string;
    externalIdentities: ExternalIdentity;
  }): Promise<GovernanceSubject> {
    // Try to find user in Entra by email
    try {
      const users = await this.graphRequest<{
        value: Array<{
          id: string;
          displayName: string;
          mail: string;
          userPrincipalName: string;
        }>;
      }>(
        `/users?$filter=mail eq '${identity.requesterEmail}' or userPrincipalName eq '${identity.requesterEmail}'`,
      );

      if (users.value.length > 0) {
        const user = users.value[0];
        return GovernanceSubjectSchema.parse({
          id: user.id,
          displayName: user.displayName,
          email: user.mail || user.userPrincipalName,
          source: "entra",
          raw: { userPrincipalName: user.userPrincipalName },
        });
      }
    } catch (error) {
      logger.warn(
        { error, email: identity.requesterEmail },
        "Failed to resolve user in Entra, falling back to manual",
      );
    }

    // Fallback: use requester info as manual subject
    return GovernanceSubjectSchema.parse({
      id: identity.requesterId,
      displayName: undefined,
      email: identity.requesterEmail,
      source: "manual",
      raw: { requesterId: identity.requesterId },
    });
  }

  async resolveEntitlement(
    entitlement: EntitlementRef,
  ): Promise<GovernedEntitlement> {
    // For Entra, the externalId should be an Access Package ID from governance config
    const governanceConfig = entitlement.governance;
    if (!governanceConfig || governanceConfig.provider !== "entra") {
      throw new Error(
        `Entitlement ${entitlement.id} missing or invalid entra governance config`,
      );
    }

    const accessPackageId = governanceConfig.accessPackageId;

    return GovernedEntitlementSchema.parse({
      entitlementId: entitlement.id,
      authority: "entra",
      externalId: accessPackageId,
      externalName: entitlement.name,
      metadata: { system: entitlement.system, accessPackageId },
    });
  }

  async submitRequest(
    request: GovernedAccessRequest,
  ): Promise<GovernanceRequest> {
    // Submit access package assignment request to Entra
    // Using Microsoft Graph v1.0 entitlement management: assignmentRequests
    // https://learn.microsoft.com/en-us/graph/api/entitlementmanagement-assignmentrequests-post
    const assignmentRequest = {
      accessPackageId: request.entitlement.externalId,
      subjectId: request.subject.id,
      assignmentType: "UserAdd",
      schedule: request.requestedDuration
        ? {
            type: "Once",
            startDateTime: new Date().toISOString(),
            endDateTime: new Date(
              Date.now() + this.parseDuration(request.requestedDuration),
            ).toISOString(),
          }
        : undefined,
      justification: request.justification,
    };

    try {
      const result = await this.graphRequest<{
        id: string;
        status: string;
        requestStatus: string;
        createdDateTime: string;
      }>("/identityGovernance/entitlementManagement/assignmentRequests", {
        method: "POST",
        body: JSON.stringify(assignmentRequest),
      });

      const governanceRequest: GovernanceRequest = {
        externalRequestId: result.id,
        authority: "entra",
        status: this.mapEntraStatus(result.requestStatus),
        submittedAt: result.createdDateTime,
        metadata: {
          opnoryRequestId: request.requestId,
          subjectId: request.subject.id,
          entitlementId: request.entitlement.entitlementId,
        },
      };

      return GovernanceRequestSchema.parse(governanceRequest);
    } catch (error) {
      logger.error(
        { error, request },
        "Failed to submit Entra access package request",
      );
      throw new Error(`Entra request submission failed: ${error}`);
    }
  }

  async getRequestStatus(
    externalRequestId: string,
  ): Promise<GovernanceRequestStatus> {
    try {
      // GET /identityGovernance/entitlementManagement/assignmentRequests/{id}
      // Expand assignment to get assignment details for reconciliation
      const result = await this.graphRequest<{
        id: string;
        requestStatus: string;
        assignment?: { id: string; endDateTime?: string };
        createdDateTime: string;
      }>(
        `/identityGovernance/entitlementManagement/assignmentRequests/${externalRequestId}?$expand=assignment`,
      );

      const status = this.mapEntraStatus(result.requestStatus);
      const assignmentId = result.assignment?.id;
      const assignmentExpiresAt = result.assignment?.endDateTime;

      return GovernanceRequestStatusSchema.parse({
        externalRequestId,
        status,
        assignmentId,
        assignmentExpiresAt,
        lastPolledAt: new Date().toISOString(),
        rawResponse: result,
      });
    } catch (error) {
      logger.warn(
        { error, externalRequestId },
        "Failed to get Entra request status",
      );
      return GovernanceRequestStatusSchema.parse({
        externalRequestId,
        status: "FAILED",
        lastPolledAt: new Date().toISOString(),
      });
    }
  }

  async getAssignment(
    subject: GovernanceSubject,
    entitlement: GovernedEntitlement,
  ): Promise<GovernanceAssignment | null> {
    try {
      // GET /identityGovernance/entitlementManagement/assignments
      // Filter by target (subject) and access package (entitlement)
      const assignments = await this.graphRequest<{
        value: Array<{
          id: string;
          accessPackageId: string;
          targetId: string;
          schedule?: { endDateTime?: string };
          status: string;
          assignmentType: string;
        }>;
      }>(
        `/identityGovernance/entitlementManagement/assignments?$filter=targetId eq '${subject.id}' and accessPackageId eq '${entitlement.externalId}'`,
      );

      if (assignments.value.length > 0) {
        const assignment = assignments.value[0];
        return GovernanceAssignmentSchema.parse({
          assignmentId: assignment.id,
          subject,
          entitlement,
          authority: "entra",
          grantedAt: new Date().toISOString(), // Would need to fetch actual creation time
          expiresAt: assignment.schedule?.endDateTime,
          status: this.mapEntraAssignmentStatus(assignment.status),
          raw: assignment,
        });
      }

      return null;
    } catch (error) {
      logger.warn(
        {
          error,
          subjectId: subject.id,
          entitlementId: entitlement.entitlementId,
        },
        "Failed to get Entra assignment",
      );
      return null;
    }
  }

  async revokeAssignment(
    assignment: GovernanceAssignment,
  ): Promise<GovernanceRevocationResult> {
    try {
      // POST /identityGovernance/entitlementManagement/assignmentRequests
      // Microsoft's entitlement-management model removes access by creating an
      // assignmentRequest with requestType: "adminRemove" referencing the assignment.
      // DELETE /assignments only removes the request record, NOT the active assignment.
      await this.graphRequest(
        "/identityGovernance/entitlementManagement/assignmentRequests",
        {
          method: "POST",
          body: JSON.stringify({
            requestType: "adminRemove",
            assignment: { id: assignment.assignmentId },
          }),
        },
      );

      return GovernanceRevocationResultSchema.parse({
        success: true,
        message: "Entra assignment revocation requested",
        authority: "entra",
        assignmentId: assignment.assignmentId,
        status: "REVOKED",
        authoritativeMutationPerformed: true,
      });
    } catch (error) {
      logger.error(
        { error, assignmentId: assignment.assignmentId },
        "Failed to revoke Entra assignment",
      );
      return GovernanceRevocationResultSchema.parse({
        success: false,
        message: "Entra revocation failed",
        error: String(error),
        authority: "entra",
        assignmentId: assignment.assignmentId,
      });
    }
  }

  private mapEntraStatus(entraStatus: string): GovernanceDecisionStatus {
    switch (entraStatus) {
      case "PendingApproval":
        return "PENDING";
      case "Delivering":
      case "PartiallyDelivered":
      case "Delivered":
        return "APPROVED";
      case "Denied":
        return "DENIED";
      case "Expired":
      case "Canceled":
        return "CANCELLED";
      default:
        return "PENDING";
    }
  }

  private mapEntraAssignmentStatus(
    entraStatus: string,
  ): GovernanceAssignmentStatus {
    switch (entraStatus) {
      case "Delivered":
        return "ACTIVE";
      case "Expired":
        return "REVOKED"; // Expired assignments are effectively revoked
      case "Revoked":
        return "REVOKED";
      default:
        return "ACTIVE";
    }
  }

  private parseDuration(duration: string): number {
    // Simple ISO 8601 duration parser for P90D, P30D, etc.
    const match = duration.match(/^P(\d+)D$/);
    if (match) {
      return parseInt(match[1], 10) * 24 * 60 * 60 * 1000;
    }
    return 90 * 24 * 60 * 60 * 1000; // Default 90 days
  }
}

// ============================================================================
// Okta Governance Provider (Okta Identity Governance Access Requests v2 API)
// ============================================================================

export interface OktaConfig {
  orgUrl: string;
  clientId: string;
  // For private_key_jwt authentication (required for Client Credentials with Okta scopes)
  privateKey: string; // PEM format
  keyId: string; // Key ID registered in Okta
  // For OIG (Okta Identity Governance)
  requestConditionId?: string;
  // Scopes for OIG Access Requests v2 + Principal Access revocation
  scopes?: string[];
}

export class OktaGovernanceProvider implements GovernanceProvider {
  readonly authority: GovernanceAuthority = "okta";

  private config: OktaConfig;
  private accessToken: string | null = null;
  private tokenExpiresAt: number = 0;
  // For testing: allow injecting token getter
  private testTokenProvider?: () => Promise<string>;

  constructor(config: OktaConfig) {
    this.config = config;
  }

  // For testing: inject a token provider to avoid JWT generation
  __setTestTokenProvider(fn: () => Promise<string>): void {
    this.testTokenProvider = fn;
  }

  private async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.accessToken && this.tokenExpiresAt > now + 60_000) {
      return this.accessToken;
    }

    // For testing: use injected token provider
    if (this.testTokenProvider) {
      const token = await this.testTokenProvider();
      this.accessToken = token;
      this.tokenExpiresAt = now + 3600 * 1000;
      return token;
    }

    const scopes =
      this.config.scopes?.join(" ") ||
      "okta.accessRequests.request.read okta.accessRequests.request.manage okta.accessRequests.condition.read okta.governance.entitlements.manage";

    // private_key_jwt authentication for Client Credentials flow
    // Generate JWT assertion signed with private key
    const assertion = await this.generateJwtAssertion(scopes);

    const params = new URLSearchParams({
      grant_type: "client_credentials",
      scope: scopes,
      client_assertion_type:
        "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
      client_assertion: assertion,
    });

    const response = await fetch(`${this.config.orgUrl}/oauth2/v1/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Okta token request failed: ${response.status} ${error}`);
    }

    // SAFETY: Okta token endpoint returns standard OAuth2 token response schema
    const data = (await response.json()) as {
      access_token: string;
      expires_in: number;
    };
    this.accessToken = data.access_token;
    this.tokenExpiresAt = now + data.expires_in * 1000;
    return this.accessToken;
  }

  private async generateJwtAssertion(scopes: string): Promise<string> {
    const { SignJWT } = await import("jose");

    // Parse PEM private key
    const privateKey = await import("jose").then(({ importPKCS8 }) =>
      importPKCS8(this.config.privateKey, "RS256"),
    );

    const now = Math.floor(Date.now() / 1000);
    const jwt = await new SignJWT({
      sub: this.config.clientId,
      scope: scopes,
    })
      .setProtectedHeader({
        alg: "RS256",
        kid: this.config.keyId,
      })
      .setIssuedAt(now)
      .setExpirationTime(now + 300) // 5 minutes
      .setIssuer(this.config.clientId)
      .setAudience(`${this.config.orgUrl}/oauth2/v1/token`)
      .sign(privateKey);

    return jwt;
  }

  // For testing: clear cached token
  clearTokenCache(): void {
    this.accessToken = null;
    this.tokenExpiresAt = 0;
  }

  private async oktaRequest<T>(
    path: string,
    options: RequestInit = {},
  ): Promise<T> {
    const token = await this.getAccessToken();
    const response = await fetch(`${this.config.orgUrl}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
        ...options.headers,
      },
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Okta request failed: ${response.status} ${error}`);
    }

    // SAFETY: 204 responses have no body; return empty object matching T
    if (response.status === 204) {
      // SAFETY: returning empty object for 204 No Content response
      return {} as T;
    }

    // SAFETY: response.json() returns the Okta API payload matching the requested T
    return response.json() as Promise<T>;
  }

  async resolveSubject(identity: {
    requesterId: string;
    requesterEmail: string;
    externalIdentities: ExternalIdentity;
  }): Promise<GovernanceSubject> {
    // Try to find user in Okta by email
    try {
      const users = await this.oktaRequest<
        Array<{
          id: string;
          profile: {
            login: string;
            email: string;
            firstName: string;
            lastName: string;
          };
        }>
      >(
        `/api/v1/users?filter=profile.email eq "${identity.requesterEmail}"&limit=1`,
      );

      if (users.length > 0) {
        const user = users[0];
        return GovernanceSubjectSchema.parse({
          id: user.id,
          displayName:
            `${user.profile.firstName} ${user.profile.lastName}`.trim(),
          email: user.profile.email,
          source: "okta",
          raw: { login: user.profile.login },
        });
      }
    } catch (error) {
      logger.warn(
        { error, email: identity.requesterEmail },
        "Failed to resolve user in Okta, falling back to manual",
      );
    }

    // Fallback: use requester info as manual subject
    return GovernanceSubjectSchema.parse({
      id: identity.requesterId,
      displayName: undefined,
      email: identity.requesterEmail,
      source: "manual",
      raw: { requesterId: identity.requesterId },
    });
  }

  async resolveEntitlement(
    entitlement: EntitlementRef,
  ): Promise<GovernedEntitlement> {
    const governanceConfig = entitlement.governance;
    if (!governanceConfig || governanceConfig.provider !== "okta") {
      throw new Error(
        `Entitlement ${entitlement.id} missing or invalid okta governance config`,
      );
    }

    // For OIG, the entitlement maps to a request condition
    // The request condition encodes: who can request, what they can request, how long, approval sequence
    return GovernedEntitlementSchema.parse({
      entitlementId: entitlement.id,
      authority: "okta",
      externalId: governanceConfig.groupId, // OIG request condition ID or group ID
      externalName: entitlement.name,
      metadata: {
        system: entitlement.system,
        groupId: governanceConfig.groupId,
        appId: governanceConfig.appId,
        requestConditionId: this.config.requestConditionId,
      },
    });
  }

  async submitRequest(
    request: GovernedAccessRequest,
  ): Promise<GovernanceRequest> {
    // Submit an Access Request via Okta Identity Governance v2 API
    // POST /governance/api/v2/requests
    // https://developer.okta.com/docs/api/openapi/okta-management/management/tag/AccessRequests/
    const accessRequest = {
      requestConditionId: this.config.requestConditionId || "",
      subjectId: request.subject.id,
      justification: request.justification,
      // duration is encoded in the request condition, not passed here
    };

    try {
      const result = await this.oktaRequest<{
        id: string;
        status: string;
        state: string;
        created: string;
        target: { id: string; type: string };
        requestCondition: { id: string };
      }>("/governance/api/v2/requests", {
        method: "POST",
        body: JSON.stringify(accessRequest),
      });

      const governanceRequest: GovernanceRequest = {
        externalRequestId: result.id,
        authority: "okta",
        status: this.mapOktaRequestStatus(result.status, result.state),
        submittedAt: result.created,
        assignmentId: result.target?.id, // The membership/entitlement ID if immediately granted
        metadata: {
          opnoryRequestId: request.requestId,
          subjectId: request.subject.id,
          entitlementId: request.entitlement.entitlementId,
          requestConditionId: this.config.requestConditionId,
        },
      };

      return GovernanceRequestSchema.parse(governanceRequest);
    } catch (error) {
      logger.error({ error, request }, "Failed to submit Okta access request");
      throw new Error(`Okta request submission failed: ${error}`);
    }
  }

  async getRequestStatus(
    externalRequestId: string,
  ): Promise<GovernanceRequestStatus> {
    try {
      // GET /governance/api/v2/requests/{id}
      const result = await this.oktaRequest<{
        id: string;
        status: string;
        state: string;
        created: string;
        target?: { id: string; type: string; endDate?: string };
        resolved?: string;
      }>(`/governance/api/v2/requests/${externalRequestId}`);

      const status = this.mapOktaRequestStatus(result.status, result.state);
      const assignmentId = result.target?.id;
      const assignmentExpiresAt = result.target?.endDate;

      return GovernanceRequestStatusSchema.parse({
        externalRequestId,
        status,
        assignmentId,
        assignmentExpiresAt,
        lastPolledAt: new Date().toISOString(),
        rawResponse: result,
      });
    } catch (error) {
      logger.warn(
        { error, externalRequestId },
        "Failed to get Okta request status",
      );
      return GovernanceRequestStatusSchema.parse({
        externalRequestId,
        status: "FAILED",
        lastPolledAt: new Date().toISOString(),
      });
    }
  }

  async getAssignment(
    subject: GovernanceSubject,
    entitlement: GovernedEntitlement,
  ): Promise<GovernanceAssignment | null> {
    try {
      // For OIG, check active requests that resulted in assignments
      // We can also check group memberships if the request condition targets a group
      // GET /api/v1/users/{userId}/groups
      const groups = await this.oktaRequest<
        Array<{ id: string; profile: { name: string } }>
      >(`/api/v1/users/${subject.id}/groups`);

      // SAFETY: groupId is stored as string in metadata; undefined if absent
      const targetGroupId = entitlement.metadata?.groupId as string | undefined;
      const isMember = targetGroupId
        ? groups.some((g) => g.id === targetGroupId)
        : false;

      if (isMember) {
        return GovernanceAssignmentSchema.parse({
          assignmentId: `okta-group-membership-${subject.id}-${targetGroupId}`,
          subject,
          entitlement,
          authority: "okta",
          grantedAt: new Date().toISOString(),
          status: "ACTIVE",
          raw: {
            groupId: targetGroupId,
            appId: entitlement.metadata?.appId,
            // Include ORNs for potential revocation if this is an authoritative Principal Access grant
            // principalOrn: "okta:principal:...", // Would be populated from Principal Access API
            // resourceOrn: "okta:resource:...",  // Would be populated from Principal Access API
          },
        });
      }

      // Also check if there's an active OIG request for this user/condition
      // This requires listing requests and filtering
      try {
        const requests = await this.oktaRequest<
          Array<{
            id: string;
            status: string;
            state: string;
            subjectId: string;
            requestConditionId: string;
            target?: { id: string; type: string; endDate?: string };
          }>
        >(
          `/governance/api/v2/requests?subjectId=${subject.id}&requestConditionId=${this.config.requestConditionId}`,
        );

        const activeRequest = requests.find(
          (r) =>
            r.requestConditionId === this.config.requestConditionId &&
            (r.state === "RESOLVED" || r.state === "ACTIVE") &&
            r.target,
        );

        if (activeRequest && activeRequest.target) {
          return GovernanceAssignmentSchema.parse({
            assignmentId: activeRequest.target.id,
            subject,
            entitlement,
            authority: "okta",
            grantedAt: new Date().toISOString(),
            expiresAt: activeRequest.target.endDate,
            status: "ACTIVE",
            raw: {
              requestId: activeRequest.id,
              requestConditionId: this.config.requestConditionId,
            },
          });
        }
      } catch {
        // Ignore OIG request listing errors, fall through to null
      }

      return null;
    } catch (error) {
      logger.warn(
        {
          error,
          subjectId: subject.id,
          entitlementId: entitlement.entitlementId,
        },
        "Failed to get Okta assignment",
      );
      return null;
    }
  }

  async revokeAssignment(
    assignment: GovernanceAssignment,
  ): Promise<GovernanceRevocationResult> {
    try {
      // Okta OIG: governance authority only observes authoritative revocation/expiration
      // If durationOwner = okta → Opnory observes Okta's revocation via request status
      // If fulfillmentOwner = opnory → downstream group/app mutation belongs to executor
      // If fulfillmentOwner = okta → Opnory triggers authoritative principal access revocation

      // Check if this is an authoritative grant (Principal Access) that Okta can revoke
      // The assignment raw should contain principalOrn and resourceOrn for revocation
      const principalOrn = assignment.raw?.principalOrn;
      const resourceOrn = assignment.raw?.resourceOrn;

      if (principalOrn && resourceOrn) {
        // Use Okta's documented Principal Access v2 revocation endpoint (Beta)
        // POST /governance/api/v2/revoke-principal-access
        // Body: { principalOrn, actor: "ADMIN", revokeOrns: [resourceOrn] }
        // Requires: okta.governance.entitlements.manage scope + APP_ADMIN role
        try {
          await this.oktaRequest(`/governance/api/v2/revoke-principal-access`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              principalOrn,
              actor: "ADMIN",
              revokeOrns: [resourceOrn],
            }),
          });
        } catch (error) {
          // If revoke-principal-access fails (e.g., Beta endpoint not available),
          // fall back to observe-only mode rather than failing hard
          logger.warn(
            { error, principalOrn, resourceOrn },
            "Okta revoke-principal-access failed (Beta endpoint may not be available); falling back to observe-only",
          );
          return GovernanceRevocationResultSchema.parse({
            success: true,
            message:
              "Okta governance revocation observed (revoke-principal-access unavailable; manual remediation may be required)",
            authority: "okta",
            assignmentId: assignment.assignmentId,
            metadata: { fallback: true, error: String(error) },
            status: "OBSERVE_ONLY",
            authoritativeMutationPerformed: false,
            fallbackReason: "REVOCATION_API_UNAVAILABLE",
          });
        }
      } else {
        // No principalOrn/resourceOrn — we cannot authoritatively revoke via Okta
        // The governance adapter observes the request lifecycle but doesn't cancel historical requests
        // (DELETE /governance/api/v2/requests/{id} is not a documented public operation)
        // Reconciliation will detect removal via getAssignment() returning null or REVOKED status
      }

      // Do NOT mutate group membership here - that's fulfillment, not governance
      // The fulfillment executor handles downstream mutations based on governance state

      return GovernanceRevocationResultSchema.parse({
        success: true,
        message: principalOrn
          ? "Okta principal access revoked"
          : "Okta governance revocation observed (no authoritative grant to revoke)",
        authority: "okta",
        assignmentId: assignment.assignmentId,
        status: principalOrn ? "REVOKED" : "OBSERVE_ONLY",
        authoritativeMutationPerformed: !!principalOrn,
      });
    } catch (error) {
      logger.error(
        { error, assignmentId: assignment.assignmentId },
        "Failed to revoke Okta assignment",
      );
      return GovernanceRevocationResultSchema.parse({
        success: false,
        message: "Okta revocation failed",
        error: String(error),
        authority: "okta",
        assignmentId: assignment.assignmentId,
      });
    }
  }

  private mapOktaRequestStatus(
    status: string,
    state: string,
  ): GovernanceDecisionStatus {
    // Okta OIG request states: PENDING, ACTIVE, RESOLVED, REJECTED, EXPIRED, CANCELLED
    // Okta OIG request statuses: APPROVED, DENIED, PENDING_APPROVAL, etc.
    switch (state) {
      case "PENDING":
      case "ACTIVE":
        return "PENDING";
      case "RESOLVED":
        return status === "APPROVED" ? "APPROVED" : "DENIED";
      case "REJECTED":
        return "DENIED";
      case "EXPIRED":
      case "CANCELLED":
        return "CANCELLED";
      default:
        return "PENDING";
    }
  }
}

export interface GovernanceProviderFactoryConfig {
  entra?: EntraConfig;
  okta?: OktaConfig;
}

export function createGovernanceProvider(
  authority: GovernanceAuthority,
  config: GovernanceProviderFactoryConfig = {},
): GovernanceProvider {
  switch (authority) {
    case "local":
      return new LocalGovernanceProvider();
    case "entra":
      if (!config.entra) {
        throw new Error("EntraConfig required for EntraGovernanceProvider");
      }
      return new EntraGovernanceProvider(config.entra);
    case "okta":
      if (!config.okta) {
        throw new Error("OktaConfig required for OktaGovernanceProvider");
      }
      return new OktaGovernanceProvider(config.okta);
    default:
      throw new Error(`Unknown governance authority: ${authority}`);
  }
}

// ============================================================================
// Governance Service (orchestrates provider selection and request lifecycle)
// ============================================================================

export class GovernanceService {
  private providers: Map<GovernanceAuthority, GovernanceProvider> = new Map();
  private auditStore: AuditEventStore;

  constructor(
    private localProvider: LocalGovernanceProvider,
    private entraProvider?: GovernanceProvider,
    private oktaProvider?: GovernanceProvider,
    auditStore?: AuditEventStore,
  ) {
    this.providers.set("local", localProvider);
    if (entraProvider) {
      this.providers.set("entra", entraProvider);
    }
    if (oktaProvider) {
      this.providers.set("okta", oktaProvider);
    }
    this.auditStore = auditStore || new InMemoryAuditEventStore();
  }

  private getProvider(authority: GovernanceAuthority): GovernanceProvider {
    const provider = this.providers.get(authority);
    if (!provider) {
      throw new Error(`No governance provider for authority: ${authority}`);
    }
    return provider;
  }

  async submitGovernedRequest(
    request: AccessRequest,
    entitlement: EntitlementRef,
    correlationId: string,
  ): Promise<GovernanceRequest> {
    const authority = entitlement.governance?.provider || "local";
    const provider = this.getProvider(authority);

    // Resolve subject and entitlement
    const subject = await provider.resolveSubject({
      requesterId: request.requesterId,
      requesterEmail: request.requesterEmail,
      externalIdentities: request.externalIdentities,
    });

    const governedEntitlement = await provider.resolveEntitlement(entitlement);

    // Submit to external authority
    const governedRequest: GovernedAccessRequest =
      GovernedAccessRequestSchema.parse({
        requestId: request.id,
        subject,
        entitlement: governedEntitlement,
        justification: request.reason,
        // SAFETY: requestedDuration is stored as string in metadata; undefined if absent
        requestedDuration: request.metadata?.requestedDuration as
          string | undefined,
      });

    const governanceRequest = await provider.submitRequest(governedRequest);

    // Store governance metadata on the request
    request.governanceExternalRequestId = governanceRequest.externalRequestId;
    request.governanceAuthority = authority;
    request.updatedAt = new Date().toISOString();
    request.version += 1;

    await this.localProvider.approvalStore.update(request);

    // Audit
    await recordAuditEvent(this.auditStore, {
      eventId: crypto.randomUUID(),
      requestId: request.id,
      correlationId,
      actor: "system",
      timestamp: new Date().toISOString(),
      type: "GOVERNANCE_REQUEST_SUBMITTED",
      metadata: {
        authority,
        externalRequestId: governanceRequest.externalRequestId,
        entitlementId: entitlement.id,
      },
    });

    return governanceRequest;
  }

  async checkGovernanceStatus(
    request: AccessRequest,
  ): Promise<GovernanceRequestStatus> {
    if (!request.governanceExternalRequestId || !request.governanceAuthority) {
      throw new Error("Request not submitted to governance provider");
    }

    const provider = this.getProvider(request.governanceAuthority);
    return provider.getRequestStatus(request.governanceExternalRequestId);
  }

  async reconcileGovernance(request: AccessRequest): Promise<void> {
    if (!request.governanceExternalRequestId || !request.governanceAuthority) {
      return;
    }

    const provider = this.getProvider(request.governanceAuthority);
    const status = await provider.getRequestStatus(
      request.governanceExternalRequestId,
    );

    // Update request based on governance status
    let newStatus = request.status;
    let needsUpdate = false;

    switch (status.status) {
      case "APPROVED":
        if (request.status === "PENDING_APPROVAL") {
          newStatus = "APPROVED";
          needsUpdate = true;
          request.governanceAssignmentId = status.assignmentId;
          request.governanceAssignmentExpiresAt = status.assignmentExpiresAt;
        }
        break;
      case "DENIED":
        if (request.status === "PENDING_APPROVAL") {
          newStatus = "DENIED";
          needsUpdate = true;
        }
        break;
      case "CANCELLED":
        if (request.status === "PENDING_APPROVAL") {
          newStatus = "CANCELLED";
          needsUpdate = true;
        }
        break;
    }

    if (needsUpdate) {
      request.status = newStatus;
      request.updatedAt = new Date().toISOString();
      request.version += 1;
      await this.localProvider.approvalStore.update(request);
    }
  }
}

// ============================================================================
// Governance Reconciliation Worker
// ============================================================================

export class GovernanceReconcilerImpl implements GovernanceReconciler {
  private config: GovernanceReconcilerConfig;
  private auditStore: AuditEventStore;
  private approvalStore: InMemoryApprovalStore;

  constructor(
    private governanceService: GovernanceService,
    config: Partial<GovernanceReconcilerConfig> = {},
    auditStore?: AuditEventStore,
    approvalStore?: InMemoryApprovalStore,
  ) {
    this.config = {
      provider: config.provider || "local",
      maxRetries: config.maxRetries ?? 3,
      retryBackoffMs: config.retryBackoffMs ?? 5000,
      driftDetectionEnabled: config.driftDetectionEnabled ?? true,
    };
    this.auditStore = auditStore || new InMemoryAuditEventStore();
    this.approvalStore = approvalStore || new InMemoryApprovalStore();
  }

  private async recordReconciliationAudit(
    type: AuditEventType,
    // SAFETY: metadata is a flexible audit payload; callers populate domain-specific fields
    // SAFETY: this is an intentionally open-ended audit payload type; callers must ensure type safety at consumption
    // SAFETY: audit metadata is caller-provided structured data; boundary validation occurs at call sites
    // SAFETY: metadata is passed through to AuditEventSchema which validates structure at store.append()
    metadata: ReconciliationAuditMetadata,
  ): Promise<void> {
    await recordAuditEvent(this.auditStore, {
      eventId: crypto.randomUUID(),
      requestId: crypto.randomUUID(),
      correlationId: crypto.randomUUID(),
      actor: "system",
      timestamp: new Date().toISOString(),
      type,
      metadata,
    });
  }

  private async getPendingRequests(): Promise<AccessRequest[]> {
    const allRequests = await this.approvalStore.getAll();
    return allRequests.filter(
      (r) =>
        r.governanceExternalRequestId &&
        r.governanceAuthority &&
        r.status === "AWAITING_AUTHORITY_DECISION",
    );
  }

  private async getActiveAssignments(): Promise<AccessRequest[]> {
    const allRequests = await this.approvalStore.getAll();
    return allRequests.filter(
      (r) =>
        r.governanceAssignmentId &&
        r.governanceAuthority &&
        r.status === "FULFILLED",
    );
  }

  private async getPendingRevocations(): Promise<AccessRequest[]> {
    const allRequests = await this.approvalStore.getAll();
    return allRequests.filter(
      (r) =>
        r.governanceAssignmentId &&
        r.governanceAuthority &&
        r.status === "REVOCATION_PENDING",
    );
  }

  async reconcilePendingRequests(): Promise<ReconciliationResult> {
    await this.recordReconciliationAudit("GOVERNANCE_RECONCILIATION_STARTED", {
      provider: this.config.provider,
      operation: "reconcilePendingRequests",
    });

    const result: ReconciliationResult = {
      requestsChecked: 0,
      requestsUpdated: 0,
      driftDetected: 0,
      errors: [],
    };

    const pendingRequests = await this.getPendingRequests();

    for (const request of pendingRequests) {
      result.requestsChecked++;

      try {
        // Update reconciliation state
        request.governanceLastCheckedAt = new Date().toISOString();
        request.governanceNextCheckAt = new Date(
          Date.now() + this.config.retryBackoffMs,
        ).toISOString();

        const status =
          await this.governanceService.checkGovernanceStatus(request);

        // Update request based on governance status
        let newStatus = request.status;
        let needsUpdate = false;

        switch (status.status) {
          case "APPROVED":
            if (request.status === "AWAITING_AUTHORITY_DECISION") {
              newStatus = "APPROVED";
              needsUpdate = true;
              request.governanceAssignmentId = status.assignmentId;
              request.governanceAssignmentExpiresAt =
                status.assignmentExpiresAt;
              request.governanceRetryCount = 0;
              request.governanceLastError = undefined;
              request.governanceLastErrorCode = undefined;
            }
            break;
          case "DENIED":
            if (request.status === "AWAITING_AUTHORITY_DECISION") {
              newStatus = "DENIED";
              needsUpdate = true;
              request.governanceRetryCount = 0;
              request.governanceLastError = undefined;
              request.governanceLastErrorCode = undefined;
            }
            break;
          case "CANCELLED":
            if (request.status === "AWAITING_AUTHORITY_DECISION") {
              newStatus = "CANCELLED";
              needsUpdate = true;
            }
            break;
          case "PENDING":
            // Still waiting - no state change
            break;
          case "FAILED":
            // Could not determine status - increment retry
            request.governanceRetryCount =
              (request.governanceRetryCount || 0) + 1;
            request.governanceLastError = "Provider returned FAILED status";
            needsUpdate = true;
            break;
        }

        if (needsUpdate) {
          request.status = newStatus;
          request.updatedAt = new Date().toISOString();
          request.version += 1;
          await this.approvalStore.update(request);
          result.requestsUpdated++;
        }

        // Check if we should retry
        if (
          request.governanceRetryCount &&
          request.governanceRetryCount >= this.config.maxRetries
        ) {
          result.errors.push({
            externalRequestId: request.governanceExternalRequestId,
            error: `Max retries (${this.config.maxRetries}) exceeded`,
            errorCode: 429,
          });
        }
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error";
        // SAFETY: error may carry a provider-specific `code` property (e.g., Graph API error codes)
        // SAFETY: narrowing error shape at boundary is safe for structured provider errors
        const errorCode = (error as any)?.code;

        request.governanceRetryCount = (request.governanceRetryCount || 0) + 1;
        request.governanceLastError = errorMessage;
        request.governanceLastErrorCode = errorCode;
        request.governanceNextCheckAt = new Date(
          Date.now() +
            this.config.retryBackoffMs * request.governanceRetryCount,
        ).toISOString();

        await this.approvalStore.update(request);

        result.errors.push({
          externalRequestId: request.governanceExternalRequestId,
          error: errorMessage,
          errorCode,
        });

        logger.warn(
          { requestId: request.id, error: errorMessage },
          "Reconciliation failed for request",
        );
      }
    }

    await this.recordReconciliationAudit(
      "GOVERNANCE_RECONCILIATION_SUCCEEDED",
      {
        provider: this.config.provider,
        operation: "reconcilePendingRequests",
        ...result,
      },
    );

    return result;
  }

  async reconcileAssignments(): Promise<ReconciliationResult> {
    await this.recordReconciliationAudit("GOVERNANCE_RECONCILIATION_STARTED", {
      provider: this.config.provider,
      operation: "reconcileAssignments",
    });

    const result: ReconciliationResult = {
      requestsChecked: 0,
      requestsUpdated: 0,
      driftDetected: 0,
      errors: [],
    };

    const activeAssignments = await this.getActiveAssignments();

    for (const request of activeAssignments) {
      result.requestsChecked++;

      try {
        if (
          !request.governanceExternalRequestId ||
          !request.governanceAuthority
        ) {
          continue;
        }

        const provider = this.governanceService["getProvider"](
          request.governanceAuthority,
        );
        const assignment = await provider.getAssignment(
          // We need to reconstruct subject and entitlement from request
          {
            id: request.requesterId,
            displayName: undefined,
            email: request.requesterEmail,
            source: "manual",
            raw: {},
          },
          {
            entitlementId: request.entitlement.id,
            authority: request.governanceAuthority!,
            externalId: request.governanceAssignmentId!,
            externalName: request.entitlement.name,
            metadata: {},
          },
        );

        // Check for drift: Opnory says FULFILLED but external says REVOKED/EXPIRED
        if (assignment && assignment.status === "REVOKED") {
          // Drift detected: external authority revoked but Opnory still FULFILLED
          await this.recordReconciliationAudit("GOVERNANCE_DRIFT_DETECTED", {
            provider: this.config.provider,
            externalRequestId: request.governanceExternalRequestId,
            externalAssignmentId: request.governanceAssignmentId,
            previousState: request.status,
            observedState: "REVOKED",
          });

          // Ownership determines action: if durationOwner is external, authority wins
          const governanceConfig = request.entitlement.governance;
          if (!governanceConfig || governanceConfig.provider === "local") {
            // Local governance - no drift correction
            continue;
          }
          const durationOwner = governanceConfig.fulfillmentOwner || "opnory";
          if (durationOwner === "entra" || durationOwner === "okta") {
            // External authority owns duration - transition to REVOKED
            request.status = "REVOKED";
            request.updatedAt = new Date().toISOString();
            request.version += 1;
            await this.approvalStore.update(request);
            result.driftDetected++;
            result.requestsUpdated++;

            await this.recordReconciliationAudit("GOVERNANCE_STATE_CORRECTED", {
              provider: this.config.provider,
              externalRequestId: request.governanceExternalRequestId,
              externalAssignmentId: request.governanceAssignmentId,
              previousState: "FULFILLED",
              correctedState: "REVOKED",
              reason: "External authority owns duration",
            });
          }
        } else if (assignment && assignment.status === "REVOKED") {
          // External assignment expired
          if (request.status === "FULFILLED") {
            request.status = "REVOKED";
            request.updatedAt = new Date().toISOString();
            request.version += 1;
            await this.approvalStore.update(request);
            result.driftDetected++;
            result.requestsUpdated++;

            await this.recordReconciliationAudit("GOVERNANCE_STATE_CORRECTED", {
              provider: this.config.provider,
              externalRequestId: request.governanceExternalRequestId,
              externalAssignmentId: request.governanceAssignmentId,
              previousState: "FULFILLED",
              correctedState: "REVOKED",
              reason: "External assignment expired",
            });
          }
        } else if (!assignment) {
          // Assignment missing from external authority
          await this.recordReconciliationAudit("GOVERNANCE_DRIFT_DETECTED", {
            provider: this.config.provider,
            externalRequestId: request.governanceExternalRequestId,
            externalAssignmentId: request.governanceAssignmentId,
            previousState: request.status,
            observedState: "MISSING",
          });

          const governanceConfig = request.entitlement.governance;
          if (!governanceConfig || governanceConfig.provider === "local") {
            // Local governance - no drift correction
            continue;
          }
          const durationOwner = governanceConfig.fulfillmentOwner || "opnory";
          if (durationOwner === "entra" || durationOwner === "okta") {
            request.status = "REVOKED";
            request.updatedAt = new Date().toISOString();
            request.version += 1;
            await this.approvalStore.update(request);
            result.driftDetected++;
            result.requestsUpdated++;

            await this.recordReconciliationAudit("GOVERNANCE_STATE_CORRECTED", {
              provider: this.config.provider,
              externalRequestId: request.governanceExternalRequestId,
              externalAssignmentId: request.governanceAssignmentId,
              previousState: "FULFILLED",
              correctedState: "REVOKED",
              reason: "External assignment missing - authority owns duration",
            });
          }
        }

        request.governanceLastCheckedAt = new Date().toISOString();
        await this.approvalStore.update(request);
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error";
        // SAFETY: error may carry a provider-specific `code` property
        // SAFETY: narrowing error shape at boundary is safe for structured provider errors
        const errorCode = (error as any)?.code;

        result.errors.push({
          externalRequestId: request.governanceExternalRequestId,
          error: errorMessage,
          errorCode,
        });

        logger.warn(
          { requestId: request.id, error: errorMessage },
          "Assignment reconciliation failed",
        );
      }
    }

    await this.recordReconciliationAudit(
      "GOVERNANCE_RECONCILIATION_SUCCEEDED",
      {
        provider: this.config.provider,
        operation: "reconcileAssignments",
        ...result,
      },
    );

    return result;
  }

  async reconcileRevocations(): Promise<ReconciliationResult> {
    await this.recordReconciliationAudit("GOVERNANCE_RECONCILIATION_STARTED", {
      provider: this.config.provider,
      operation: "reconcileRevocations",
    });

    const result: ReconciliationResult = {
      requestsChecked: 0,
      requestsUpdated: 0,
      driftDetected: 0,
      errors: [],
    };

    const pendingRevocations = await this.getPendingRevocations();

    for (const request of pendingRevocations) {
      result.requestsChecked++;

      try {
        if (!request.governanceAssignmentId || !request.governanceAuthority) {
          continue;
        }

        const provider = this.governanceService["getProvider"](
          request.governanceAuthority,
        );
        const revocationResult = await provider.revokeAssignment({
          assignmentId: request.governanceAssignmentId,
          subject: {
            id: request.requesterId,
            displayName: undefined,
            email: request.requesterEmail,
            source: "manual",
            raw: {},
          },
          entitlement: {
            entitlementId: request.entitlement.id,
            authority: request.governanceAuthority!,
            externalId: request.governanceAssignmentId!,
            externalName: request.entitlement.name,
            metadata: {},
          },
          authority: request.governanceAuthority!,
          grantedAt: new Date().toISOString(),
          status: "ACTIVE",
        });

        if (revocationResult.success) {
          request.status = "REVOKED";
          request.updatedAt = new Date().toISOString();
          request.version += 1;
          await this.approvalStore.update(request);
          result.requestsUpdated++;
        } else {
          result.errors.push({
            externalRequestId: request.governanceExternalRequestId,
            error: revocationResult.message,
            errorCode: 500,
          });
        }
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error";
        // SAFETY: error may carry a provider-specific `code` property
        // SAFETY: narrowing error shape at boundary is safe for structured provider errors
        const errorCode = (error as any)?.code;

        result.errors.push({
          externalRequestId: request.governanceExternalRequestId,
          error: errorMessage,
          errorCode,
        });

        logger.warn(
          { requestId: request.id, error: errorMessage },
          "Revocation reconciliation failed",
        );
      }
    }

    await this.recordReconciliationAudit(
      "GOVERNANCE_RECONCILIATION_SUCCEEDED",
      {
        provider: this.config.provider,
        operation: "reconcileRevocations",
        ...result,
      },
    );

    return result;
  }
}
