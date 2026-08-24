import { getLogger } from "@opnory/observability";
import { v4 as uuidv4 } from "uuid";
import {
  AccessRequest,
  ApprovedAccessRequest,
  ApprovalDecision,
  AccessRequestStatus,
  canTransition,
  transitionOrThrow,
  toApprovedAccessRequest,
} from "@opnory/access-types";
import {
  AuditEventStore,
  InMemoryAuditEventStore,
  AuditEventType,
  recordAuditEvent,
} from "@opnory/access-audit";

const logger = getLogger().child({ component: "access-approval" });

// ============================================================================
// Approval Store
// ============================================================================

export class InMemoryApprovalStore {
  private requests: Map<string, AccessRequest> = new Map();

  async create(request: AccessRequest): Promise<void> {
    this.requests.set(request.id, request);
  }

  async getById(id: string): Promise<AccessRequest | undefined> {
    return this.requests.get(id);
  }

  async update(
    request: AccessRequest,
    expectedVersion?: number,
  ): Promise<void> {
    const existing = this.requests.get(request.id);
    if (!existing) {
      throw new Error(`Access request ${request.id} not found`);
    }
    if (expectedVersion !== undefined && existing.version !== expectedVersion) {
      throw new Error(
        `Optimistic concurrency conflict: expected version ${expectedVersion}, found ${existing.version}`,
      );
    }
    this.requests.set(request.id, request);
  }

  async getAll(): Promise<AccessRequest[]> {
    return Array.from(this.requests.values());
  }
}

// ============================================================================
// Approval Service
// ============================================================================

export interface ApprovalResult {
  request: AccessRequest;
  duplicate?: boolean;
}

export class ApprovalService {
  private store: InMemoryApprovalStore;
  private auditStore: AuditEventStore;

  constructor(store?: InMemoryApprovalStore, auditStore?: AuditEventStore) {
    this.store = store || new InMemoryApprovalStore();
    this.auditStore = auditStore || new InMemoryAuditEventStore();
  }

  async requestApproval(
    request: AccessRequest,
    correlationId: string,
  ): Promise<void> {
    // Record audit event
    await recordAuditEvent(this.auditStore, {
      eventId: uuidv4(),
      requestId: request.id,
      correlationId,
      actor: request.requesterId,
      timestamp: new Date().toISOString(),
      type: "APPROVAL_REQUESTED",
      metadata: {
        entitlementId: request.entitlement.id,
        entitlementName: request.entitlement.name,
        requiredApprovers: request.metadata?.requiredApprovers,
      },
    });

    logger.info({ requestId: request.id }, "Approval requested");
  }

  async approve(
    requestId: string,
    decision: ApprovalDecision,
    correlationId: string,
  ): Promise<ApprovalResult> {
    const request = await this.store.getById(requestId);
    if (!request) {
      throw new Error(`Access request ${requestId} not found`);
    }

    // Check if request has expired
    if (request.expiresAt && new Date(request.expiresAt) < new Date()) {
      // Transition to CANCELLED with optimistic concurrency
      transitionOrThrow(request.status, "CANCELLED", {
        expectedVersion: request.version,
        actualVersion: request.version,
      });

      const cancelledRequest: AccessRequest = {
        ...request,
        status: "CANCELLED",
        updatedAt: new Date().toISOString(),
        version: request.version + 1,
      };

      await this.store.update(cancelledRequest, request.version);

      await recordAuditEvent(this.auditStore, {
        eventId: uuidv4(),
        requestId,
        correlationId,
        actor: "system",
        timestamp: new Date().toISOString(),
        type: "ACCESS_REQUEST_CANCELLED",
        metadata: {
          reason: "Approval window expired",
          expiredAt: request.expiresAt,
        },
      });

      logger.info({ requestId }, "Access request cancelled due to expiration");
      throw new Error("Access request has expired");
    }
    if (decision.approverId === request.requesterId) {
      await recordAuditEvent(this.auditStore, {
        eventId: uuidv4(),
        requestId,
        correlationId,
        actor: decision.approverId,
        timestamp: new Date().toISOString(),
        type: "SELF_APPROVAL_ATTEMPT",
        metadata: {
          decision: "REJECTED",
          reason: "Requester cannot approve their own request",
        },
      });

      throw new Error("Requester cannot approve their own request");
    }

    // Check if request is governed by external authority - local approval cannot override
    if (
      request.governanceAuthority &&
      request.governanceAuthority !== "local"
    ) {
      await recordAuditEvent(this.auditStore, {
        eventId: uuidv4(),
        requestId,
        correlationId,
        actor: decision.approverId,
        timestamp: new Date().toISOString(),
        type: "EXTERNAL_AUTHORITY_APPROVAL_ATTEMPT",
        metadata: {
          governanceAuthority: request.governanceAuthority,
          decision: "REJECTED",
          reason: "External authority owns approval",
        },
      });

      throw new Error("External authority owns approval");
    }

    // Handle duplicate/already-processed approvals idempotently
    if (request.status === "APPROVED") {
      // Already approved - check if same approver (idempotent) or different (conflict)
      if (request.approvedBy === decision.approverId) {
        // Same approver - idempotent success
        await recordAuditEvent(this.auditStore, {
          eventId: uuidv4(),
          requestId,
          correlationId,
          actor: decision.approverId,
          timestamp: new Date().toISOString(),
          type: "ACCESS_REQUEST_APPROVED",
          metadata: {
            approverEmail: decision.approverEmail,
            reason: decision.reason,
            duplicate: true,
          },
        });
        logger.info(
          { requestId, approver: decision.approverId, duplicate: true },
          "Duplicate approval (idempotent)",
        );
        return { request, duplicate: true };
      } else {
        // Different approver trying to approve again - conflict
        await recordAuditEvent(this.auditStore, {
          eventId: uuidv4(),
          requestId,
          correlationId,
          actor: decision.approverId,
          timestamp: new Date().toISOString(),
          type: "ACCESS_REQUEST_APPROVED",
          metadata: {
            approverEmail: decision.approverEmail,
            reason: decision.reason,
            conflict: true,
            originalApprover: request.approvedBy,
          },
        });
        throw new Error(`Request already approved by ${request.approvedBy}`);
      }
    }

    if (request.status === "FAILED") {
      // Retry fulfillment from FAILED state - transition directly to FULFILLING
      if (decision.decision === "APPROVE") {
        transitionOrThrow(request.status, "FULFILLING", {
          expectedVersion: request.version,
          actualVersion: request.version,
        });

        const retryingRequest: AccessRequest = {
          ...request,
          status: "FULFILLING",
          updatedAt: new Date().toISOString(),
          version: request.version + 1,
          expirationAttemptCount: (request.expirationAttemptCount || 0) + 1,
          expirationLastAttemptAt: new Date().toISOString(),
        };

        await this.store.update(retryingRequest, request.version);

        await recordAuditEvent(this.auditStore, {
          eventId: uuidv4(),
          requestId,
          correlationId,
          actor: decision.approverId,
          timestamp: decision.timestamp,
          type: "RETRY_FULFILLMENT",
          metadata: {
            approverEmail: decision.approverEmail,
            reason: decision.reason,
            previousError: request.fulfillmentError,
          },
        });

        logger.info(
          { requestId, approver: decision.approverId },
          "Retrying fulfillment from FAILED state",
        );
        return { request: retryingRequest, duplicate: false };
      } else {
        // Cannot deny a failed request
        await recordAuditEvent(this.auditStore, {
          eventId: uuidv4(),
          requestId,
          correlationId,
          actor: decision.approverId,
          timestamp: new Date().toISOString(),
          type: "CONFLICTING_DECISION",
          metadata: {
            attemptedDecision: "DENY",
            currentStatus: "FAILED",
            previousError: request.fulfillmentError,
          },
        });
        throw new Error("Cannot deny a failed request; use approve to retry");
      }
    }

    if (request.status === "DENIED") {
      // Conflict: trying to approve a denied request
      await recordAuditEvent(this.auditStore, {
        eventId: uuidv4(),
        requestId,
        correlationId,
        actor: decision.approverId,
        timestamp: new Date().toISOString(),
        type: "CONFLICTING_DECISION",
        metadata: {
          attemptedDecision: "APPROVE",
          currentStatus: "DENIED",
          deniedBy: request.deniedBy,
          deniedReason: request.deniedReason,
        },
      });
      throw new Error("Cannot approve a denied request");
    }

    if (request.status === "FULFILLED") {
      // Already fulfilled - idempotent only for same decision type
      if (
        request.approvedBy === decision.approverId &&
        decision.decision === "APPROVE"
      ) {
        await recordAuditEvent(this.auditStore, {
          eventId: uuidv4(),
          requestId,
          correlationId,
          actor: decision.approverId,
          timestamp: new Date().toISOString(),
          type: "ACCESS_REQUEST_APPROVED",
          metadata: {
            approverEmail: decision.approverEmail,
            reason: decision.reason,
            duplicate: true,
            fulfilled: true,
          },
        });
        logger.info(
          {
            requestId,
            approver: decision.approverId,
            duplicate: true,
            fulfilled: true,
          },
          "Duplicate approval on fulfilled request (idempotent)",
        );
        return { request, duplicate: true };
      } else {
        // Different decision type (DENY on FULFILLED) or different approver - conflict
        await recordAuditEvent(this.auditStore, {
          eventId: uuidv4(),
          requestId,
          correlationId,
          actor: decision.approverId,
          timestamp: new Date().toISOString(),
          type: "CONFLICTING_DECISION",
          metadata: {
            attemptedDecision: decision.decision,
            currentStatus: "FULFILLED",
            originalApprover: request.approvedBy,
          },
        });
        throw new Error(`Request already fulfilled`);
      }
    }

    if (decision.decision === "APPROVE") {
      // Transition to APPROVED with optimistic concurrency
      transitionOrThrow(request.status, "APPROVED", {
        expectedVersion: request.version,
        actualVersion: request.version,
      });

      const updatedRequest: AccessRequest = {
        ...request,
        status: "APPROVED",
        approvedAt: decision.timestamp,
        approvedBy: decision.approverId,
        updatedAt: decision.timestamp,
        version: request.version + 1,
      };

      await this.store.update(updatedRequest, request.version);

      await recordAuditEvent(this.auditStore, {
        eventId: uuidv4(),
        requestId,
        correlationId,
        actor: decision.approverId,
        timestamp: decision.timestamp,
        type: "ACCESS_REQUEST_APPROVED",
        metadata: {
          approverEmail: decision.approverEmail,
          reason: decision.reason,
        },
      });

      logger.info(
        { requestId, approver: decision.approverId },
        "Access request approved",
      );
      return { request: updatedRequest, duplicate: false };
    } else {
      // Transition to DENIED with optimistic concurrency
      transitionOrThrow(request.status, "DENIED", {
        expectedVersion: request.version,
        actualVersion: request.version,
      });

      const updatedRequest: AccessRequest = {
        ...request,
        status: "DENIED",
        deniedAt: decision.timestamp,
        deniedBy: decision.approverId,
        deniedReason: decision.reason,
        updatedAt: decision.timestamp,
        version: request.version + 1,
      };

      await this.store.update(updatedRequest, request.version);

      await recordAuditEvent(this.auditStore, {
        eventId: uuidv4(),
        requestId,
        correlationId,
        actor: decision.approverId,
        timestamp: decision.timestamp,
        type: "ACCESS_REQUEST_DENIED",
        metadata: {
          approverEmail: decision.approverEmail,
          reason: decision.reason,
        },
      });

      logger.info(
        { requestId, approver: decision.approverId },
        "Access request denied",
      );
      return { request: updatedRequest, duplicate: false };
    }
  }

  async deny(
    requestId: string,
    decision: ApprovalDecision,
    correlationId: string,
  ): Promise<ApprovalResult> {
    // Similar logic for deny, but with DENY decision
    const request = await this.store.getById(requestId);
    if (!request) {
      throw new Error(`Access request ${requestId} not found`);
    }

    // Check if request has expired
    if (request.expiresAt && new Date(request.expiresAt) < new Date()) {
      // Transition to CANCELLED with optimistic concurrency
      transitionOrThrow(request.status, "CANCELLED", {
        expectedVersion: request.version,
        actualVersion: request.version,
      });

      const cancelledRequest: AccessRequest = {
        ...request,
        status: "CANCELLED",
        updatedAt: new Date().toISOString(),
        version: request.version + 1,
      };

      await this.store.update(cancelledRequest, request.version);

      await recordAuditEvent(this.auditStore, {
        eventId: uuidv4(),
        requestId,
        correlationId,
        actor: "system",
        timestamp: new Date().toISOString(),
        type: "ACCESS_REQUEST_CANCELLED",
        metadata: {
          reason: "Approval window expired",
          expiredAt: request.expiresAt,
        },
      });

      logger.info({ requestId }, "Access request cancelled due to expiration");
      throw new Error("Access request has expired");
    }

    // Security check: requester cannot deny their own request
    if (decision.approverId === request.requesterId) {
      await recordAuditEvent(this.auditStore, {
        eventId: uuidv4(),
        requestId,
        correlationId,
        actor: decision.approverId,
        timestamp: new Date().toISOString(),
        type: "SELF_DENIAL_ATTEMPT",
        metadata: {
          decision: "REJECTED",
          reason: "Requester cannot deny their own request",
        },
      });
      throw new Error("Requester cannot deny their own request");
    }

    // Handle duplicate/already-processed denials idempotently
    if (request.status === "DENIED") {
      if (request.deniedBy === decision.approverId) {
        await recordAuditEvent(this.auditStore, {
          eventId: uuidv4(),
          requestId,
          correlationId,
          actor: decision.approverId,
          timestamp: new Date().toISOString(),
          type: "ACCESS_REQUEST_DENIED",
          metadata: {
            approverEmail: decision.approverEmail,
            reason: decision.reason,
            duplicate: true,
          },
        });
        logger.info(
          { requestId, approver: decision.approverId, duplicate: true },
          "Duplicate denial on already denied request (idempotent)",
        );
        return { request, duplicate: true };
      } else {
        await recordAuditEvent(this.auditStore, {
          eventId: uuidv4(),
          requestId,
          correlationId,
          actor: decision.approverId,
          timestamp: new Date().toISOString(),
          type: "CONFLICTING_DECISION",
          metadata: {
            attemptedDecision: "DENY",
            currentStatus: "DENIED",
            originalDenier: request.deniedBy,
          },
        });
        throw new Error(`Request already denied by ${request.deniedBy}`);
      }
    }

    if (
      request.status === "APPROVED" ||
      request.status === "FULFILLING" ||
      request.status === "FULFILLED"
    ) {
      await recordAuditEvent(this.auditStore, {
        eventId: uuidv4(),
        requestId,
        correlationId,
        actor: decision.approverId,
        timestamp: new Date().toISOString(),
        type: "CONFLICTING_DECISION",
        metadata: {
          attemptedDecision: "DENY",
          currentStatus: request.status,
        },
      });
      throw new Error(`Cannot deny request in status: ${request.status}`);
    }

    // Transition to DENIED with optimistic concurrency
    transitionOrThrow(request.status, "DENIED", {
      expectedVersion: request.version,
      actualVersion: request.version,
    });

    const updatedRequest: AccessRequest = {
      ...request,
      status: "DENIED",
      deniedAt: decision.timestamp,
      deniedBy: decision.approverId,
      deniedReason: decision.reason,
      updatedAt: decision.timestamp,
      version: request.version + 1,
    };

    await this.store.update(updatedRequest, request.version);

    await recordAuditEvent(this.auditStore, {
      eventId: uuidv4(),
      requestId,
      correlationId,
      actor: decision.approverId,
      timestamp: decision.timestamp,
      type: "ACCESS_REQUEST_DENIED",
      metadata: {
        approverEmail: decision.approverEmail,
        reason: decision.reason,
      },
    });

    logger.info(
      { requestId, approver: decision.approverId },
      "Access request denied",
    );
    return { request: updatedRequest, duplicate: false };
  }

  async getApprovedRequest(
    requestId: string,
  ): Promise<ApprovedAccessRequest | null> {
    const request = await this.store.getById(requestId);
    if (!request || request.status !== "APPROVED") {
      return null;
    }
    return toApprovedAccessRequest(request);
  }
}
