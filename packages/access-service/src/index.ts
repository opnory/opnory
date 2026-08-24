import { getLogger } from "@opnory/observability";
import { v4 as uuidv4 } from "uuid";
import {
  EntitlementCatalog,
  canonicalEngineeringContributorEntitlement,
  ENGINEERING_CONTRIBUTOR_ENTITLEMENT_ID,
} from "@opnory/access-entitlements";
import {
  PolicyEngine,
  evaluateAccessPolicy,
  PolicyContext,
} from "@opnory/access-policy";
import {
  ApprovalService,
  InMemoryApprovalStore,
} from "@opnory/access-approval";
import {
  FakeGitHubAccessExecutor,
  InMemoryIdempotencyStore,
} from "@opnory/access-executor";
import {
  AuditEventStore,
  InMemoryAuditEventStore,
  recordAuditEvent,
  AuditEventType,
} from "@opnory/access-audit";
import {
  AccessRequest,
  ApprovedAccessRequest,
  ApprovalDecision,
  AccessRequestStatus,
  EntitlementRef,
  canTransition,
  toApprovedAccessRequest,
  toRetryFulfillmentRequest,
  ExecutionResult,
  ExternalIdentity,
} from "@opnory/access-types";

const logger = getLogger().child({ component: "access-service" });

// Per-request locks to serialize concurrent decisions on the same request
const requestLocks = new Map<string, Promise<unknown>>();

async function withRequestLock<T>(
  requestId: string,
  fn: () => Promise<T>,
): Promise<T> {
  // Wait for any in-flight operation on this request to complete
  const existingLock = requestLocks.get(requestId);
  if (existingLock) {
    await existingLock;
  }

  // Create new lock for this operation
  let resolveLock: () => void;
  const lockPromise = new Promise<void>((resolve) => {
    resolveLock = resolve;
  });
  requestLocks.set(requestId, lockPromise);

  try {
    return await fn();
  } finally {
    // Release lock
    requestLocks.delete(requestId);
    resolveLock!();
  }
}

// ============================================================================
// Access Service Configuration
// ============================================================================

export interface AccessServiceConfig {
  catalog?: EntitlementCatalog;
  approvalStore?: InMemoryApprovalStore;
  auditStore?: AuditEventStore;
  executor?: FakeGitHubAccessExecutor;
  idempotencyStore?: InMemoryIdempotencyStore;
}

// ============================================================================
// Access Request Service (Orchestrator)
// ============================================================================

export class AccessRequestService {
  private catalog: EntitlementCatalog;
  private policyEngine: PolicyEngine;
  private approvalService: ApprovalService;
  private executor: FakeGitHubAccessExecutor;
  private auditStore: AuditEventStore;
  private idempotencyStore: InMemoryIdempotencyStore;

  constructor(config: AccessServiceConfig = {}) {
    this.catalog =
      config.catalog ||
      new EntitlementCatalog([canonicalEngineeringContributorEntitlement]);
    this.policyEngine = new PolicyEngine(this.catalog);
    this.auditStore = config.auditStore || new InMemoryAuditEventStore();
    this.approvalService = new ApprovalService(
      config.approvalStore,
      this.auditStore,
    );
    this.idempotencyStore =
      config.idempotencyStore || new InMemoryIdempotencyStore();
    this.executor =
      config.executor ||
      new FakeGitHubAccessExecutor(this.idempotencyStore, this.auditStore);
  }

  // ============================================================================
  // Create Access Request (from user intent)
  // ============================================================================

  async createAccessRequest(params: {
    requesterId: string;
    requesterEmail: string;
    externalIdentities?: ExternalIdentity;
    entitlementIdOrName: string;
    reason: string;
    correlationId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<AccessRequest> {
    const correlationId = params.correlationId || uuidv4();

    // Generate requestId early for audit trail consistency
    const requestId = uuidv4();

    // Identify entitlement from catalog
    let entitlement = this.catalog.getById(params.entitlementIdOrName);
    if (!entitlement) {
      entitlement = this.catalog.findByName(params.entitlementIdOrName);
    }
    if (!entitlement) {
      // Try partial match
      const matches = this.catalog.findByPartialMatch(
        params.entitlementIdOrName,
      );
      if (matches.length === 1) {
        entitlement = matches[0];
      } else if (matches.length > 1) {
        throw new Error(
          `Ambiguous entitlement: "${params.entitlementIdOrName}" matches ${matches.length} entitlements`,
        );
      }
    }

    if (!entitlement) {
      await recordAuditEvent(this.auditStore, {
        eventId: uuidv4(),
        requestId,
        correlationId,
        actor: params.requesterId,
        timestamp: new Date().toISOString(),
        type: "ENTITLEMENT_IDENTIFIED",
        metadata: {
          query: params.entitlementIdOrName,
          result: "NOT_FOUND",
        },
      });

      throw new Error(`Entitlement not found: ${params.entitlementIdOrName}`);
    }

    const entitlementRef: EntitlementRef = {
      id: entitlement.id,
      name: entitlement.name,
      system: entitlement.system,
      githubConfig: entitlement.githubConfig,
      metadata: entitlement.metadata || {},
      governance: entitlement.governance,
    };

    // Audit: entitlement identified
    await recordAuditEvent(this.auditStore, {
      eventId: uuidv4(),
      requestId,
      correlationId,
      actor: params.requesterId,
      timestamp: new Date().toISOString(),
      type: "ENTITLEMENT_IDENTIFIED",
      metadata: {
        entitlementId: entitlement.id,
        entitlementName: entitlement.name,
        result: "FOUND",
      },
    });

    // Evaluate policy
    const policyContext: PolicyContext = {
      requesterId: params.requesterId,
      requesterEmail: params.requesterEmail,
      entitlement: entitlementRef,
      metadata: params.metadata,
    };

    const policyResult = this.policyEngine.evaluate(policyContext);

    // Audit: policy evaluated
    await recordAuditEvent(this.auditStore, {
      eventId: uuidv4(),
      requestId,
      correlationId,
      actor: "system",
      timestamp: new Date().toISOString(),
      type: "POLICY_EVALUATED",
      metadata: {
        decision: policyResult.decision,
        policyId: policyResult.policyId,
        requiredApprovers: policyResult.requiredApprovers,
        reason: policyResult.reason,
      },
    });

    // For this slice, we only support APPROVAL_REQUIRED
    if (policyResult.decision !== "APPROVAL_REQUIRED") {
      throw new Error(
        `Policy decision not supported in this slice: ${policyResult.decision}`,
      );
    }

    const idempotencyKey = `${requestId}:${entitlement.id}:${params.requesterId}`;

    // Set expiration to 7 days from now for approval window
    const expiresAt = new Date(
      Date.now() + 7 * 24 * 60 * 60 * 1000,
    ).toISOString();

    const request: AccessRequest = {
      id: requestId,
      correlationId,
      requesterId: params.requesterId,
      requesterEmail: params.requesterEmail,
      externalIdentities: params.externalIdentities || {},
      entitlement: entitlementRef,
      reason: params.reason,
      status: "PENDING_APPROVAL",
      version: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      expiresAt,
      idempotencyKey,
      metadata: {
        requiredApprovers: policyResult.requiredApprovers,
        policyId: policyResult.policyId,
        ...params.metadata,
      },
      expirationAttemptCount: 0,
      expirationMaxRetries: 3,
      // Governance fields
      governanceExternalRequestId: undefined,
      governanceAuthority: undefined,
      governanceAssignmentId: undefined,
      governanceAssignmentExpiresAt: undefined,
      // Reconciliation state fields
      governanceLastCheckedAt: undefined,
      governanceNextCheckAt: undefined,
      governanceRetryCount: 0,
      governanceLastError: undefined,
      governanceLastErrorCode: undefined,
      // Governance lease fields
      governanceLeaseOwner: undefined,
      governanceLeaseUntil: undefined,
      governanceLeaseAcquiredAt: undefined,
      governanceAttemptCount: 0,
      governanceNextAttemptAt: undefined,
      governanceLastAttemptAt: undefined,
    };

    // Store request
    await this.approvalService["store"].create(request);

    // Request approval (audits APPROVAL_REQUESTED)
    await this.approvalService.requestApproval(request, correlationId);

    // Audit: access request created
    await recordAuditEvent(this.auditStore, {
      eventId: uuidv4(),
      requestId,
      correlationId,
      actor: params.requesterId,
      timestamp: new Date().toISOString(),
      type: "ACCESS_REQUEST_CREATED",
      metadata: {
        entitlementId: entitlement.id,
        entitlementName: entitlement.name,
        status: "PENDING_APPROVAL",
      },
    });

    logger.info(
      { requestId, entitlementId: entitlement.id },
      "Access request created",
    );
    return request;
  }

  // ============================================================================
  // Approve/Deny Access Request
  // ============================================================================

  async decideAccessRequest(
    requestId: string,
    decision: ApprovalDecision,
    correlationId: string,
  ): Promise<AccessRequest> {
    return withRequestLock(requestId, async () => {
      // This will audit APPROVED/DENIED and validate self-approval
      const result = await this.approvalService.approve(
        requestId,
        decision,
        correlationId,
      );
      const updatedRequest = result.request;

      // If approved or retrying from FAILED, start fulfillment and wait for completion
      if (
        updatedRequest.status === "APPROVED" ||
        updatedRequest.status === "FULFILLING"
      ) {
        await this.fulfillRequest(updatedRequest, correlationId);
        // Return the final state after fulfillment
        return this.approvalService["store"].getById(
          requestId,
        ) as Promise<AccessRequest>;
      }

      return updatedRequest;
    });
  }

  // ============================================================================
  // Fulfill Approved Request
  // ============================================================================

  private async fulfillRequest(
    approvedRequest: AccessRequest,
    correlationId: string,
  ): Promise<void> {
    // Transition to FULFILLING with optimistic concurrency
    const currentRequest = await this.approvalService["store"].getById(
      approvedRequest.id,
    );
    if (!currentRequest) {
      throw new Error(`Request ${approvedRequest.id} not found`);
    }

    let fulfillingRequest: AccessRequest | undefined;

    // If already in FULFILLING (from retry), proceed directly to execution
    if (currentRequest.status !== "FULFILLING") {
      if (!canTransition(currentRequest.status, "FULFILLING")) {
        throw new Error(
          `Cannot fulfill request in status: ${currentRequest.status}`,
        );
      }

      fulfillingRequest = {
        ...currentRequest,
        status: "FULFILLING",
        updatedAt: new Date().toISOString(),
        version: currentRequest.version + 1,
      };

      await this.approvalService["store"].update(
        fulfillingRequest,
        currentRequest.version,
      );
    }

    // Convert to ApprovedAccessRequest for executor (type-safe)
    // Use toRetryFulfillmentRequest if already FULFILLING (from retry), otherwise toApprovedAccessRequest
    const executorRequest =
      currentRequest.status === "FULFILLING"
        ? toRetryFulfillmentRequest(currentRequest)
        : toApprovedAccessRequest(approvedRequest);

    // Execute via executor (defense in depth: executor verifies approval)
    const result = await this.executor.grant(executorRequest);

    if (result.success) {
      // Transition to FULFILLED
      const baseRequest =
        currentRequest.status === "FULFILLING"
          ? currentRequest
          : fulfillingRequest!;
      const fulfilledRequest: AccessRequest = {
        ...baseRequest,
        status: "FULFILLED",
        fulfilledAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        metadata: {
          ...baseRequest.metadata,
          externalId: result.externalId,
        },
      };

      await this.approvalService["store"].update(
        fulfilledRequest,
        baseRequest.version,
      );
      logger.info(
        { requestId: approvedRequest.id },
        "Access request fulfilled",
      );
    } else {
      // Transition to FAILED
      const baseRequest =
        currentRequest.status === "FULFILLING"
          ? currentRequest
          : fulfillingRequest!;
      const failedRequest: AccessRequest = {
        ...baseRequest,
        status: "FAILED",
        fulfillmentError: result.error,
        updatedAt: new Date().toISOString(),
      };

      await this.approvalService["store"].update(
        failedRequest,
        baseRequest.version,
      );
      logger.error(
        { requestId: approvedRequest.id, error: result.error },
        "Access request fulfillment failed",
      );
    }
  }

  // ============================================================================
  // Getters
  // ============================================================================

  async getRequestById(id: string): Promise<AccessRequest | undefined> {
    return this.approvalService["store"].getById(id);
  }

  async getRequestsByRequester(requesterId: string): Promise<AccessRequest[]> {
    const allRequests = await this.approvalService["store"].getAll();
    return allRequests.filter(
      (r: AccessRequest) => r.requesterId === requesterId,
    );
  }

  async getAuditTrail(
    requestId: string,
  ): Promise<import("@opnory/access-audit").AuditEvent[]> {
    return this.auditStore.getByRequestId(requestId);
  }

  // Audit unauthorized approval attempt
  async auditUnauthorizedApprovalAttempt(
    requestId: string,
    actorId: string,
  ): Promise<void> {
    const request = await this.getRequestById(requestId);
    const correlationId = uuidv4();

    await recordAuditEvent(this.auditStore, {
      eventId: uuidv4(),
      requestId,
      correlationId,
      actor: actorId,
      timestamp: new Date().toISOString(),
      type: "UNAUTHORIZED_APPROVAL_ATTEMPT",
      metadata: {
        reason: "Actor is not the assigned approver for this request",
        requiredApprover:
          (request?.metadata?.requiredApprovers as string[])?.[0] || "unknown",
      },
    });
  }

  // Expose for testing
  getExecutor(): FakeGitHubAccessExecutor {
    return this.executor;
  }
}

// ============================================================================
// Default Service Factory
// ============================================================================

let defaultService: AccessRequestService | null = null;

export function getAccessService(
  config?: AccessServiceConfig,
): AccessRequestService {
  if (!defaultService) {
    defaultService = new AccessRequestService(config);
  }
  return defaultService;
}

export function resetAccessService(): void {
  defaultService = null;
}
