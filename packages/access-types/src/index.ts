import { z } from "zod";
import { getLogger } from "@opnory/observability";

const logger = getLogger().child({ component: "access-types" });

// ============================================================================
// Access Request State Machine
// ============================================================================

export const AccessRequestStatusSchema = z.enum([
  "PENDING_APPROVAL",
  "APPROVED",
  "DENIED",
  "FULFILLING",
  "FULFILLED",
  "FAILED",
  "CANCELLED",
  "AWAITING_EXTERNAL_ACCEPTANCE",
  "REVOCATION_PENDING",
  "REVOKED",
  "RETRY", // Expiration retry state (retryable failure, waiting for next attempt)
  "REVOCATION_FAILED", // Terminal expiration failure state
]);

export type AccessRequestStatus = z.infer<typeof AccessRequestStatusSchema>;

// Valid status transitions
export const VALID_TRANSITIONS: Record<AccessRequestStatus, AccessRequestStatus[]> = {
  PENDING_APPROVAL: ["APPROVED", "DENIED", "CANCELLED"],
  APPROVED: ["FULFILLING", "CANCELLED", "AWAITING_EXTERNAL_ACCEPTANCE"],
  DENIED: ["CANCELLED"],
  FULFILLING: ["FULFILLED", "FAILED"],
  FULFILLED: ["REVOCATION_PENDING", "CANCELLED", "RETRY", "REVOCATION_FAILED"],
  FAILED: ["FULFILLING", "CANCELLED", "FULFILLED", "AWAITING_EXTERNAL_ACCEPTANCE"],
  CANCELLED: [],
  AWAITING_EXTERNAL_ACCEPTANCE: ["FULFILLED", "FAILED", "CANCELLED", "REVOCATION_PENDING"],
  REVOCATION_PENDING: ["REVOKED", "FAILED"],
  REVOKED: [],
  RETRY: ["REVOCATION_PENDING", "RETRY", "REVOCATION_FAILED", "FULFILLED"], // Retry can go to pending, retry again, terminal, or extension
  REVOCATION_FAILED: ["RETRY", "REVOCATION_PENDING"], // Manual recovery can retry
};

export function canTransition(from: AccessRequestStatus, to: AccessRequestStatus): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

export function transitionOrThrow(
  from: AccessRequestStatus,
  to: AccessRequestStatus,
  options?: { expectedVersion?: number; actualVersion?: number }
): void {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid status transition: ${from} -> ${to}`);
  }
  if (options?.expectedVersion !== undefined && options?.actualVersion !== undefined) {
    if (options.expectedVersion !== options.actualVersion) {
      throw new Error(`Optimistic concurrency conflict: expected version ${options.expectedVersion}, found ${options.actualVersion}`);
    }
  }
}

// ============================================================================
// Entitlement Reference (from catalog)
// ============================================================================

export const EntitlementRefSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  system: z.string(),
  githubConfig: z
    .object({
      organization: z.string().min(1),
      teamSlug: z.string().min(1),
      teamRole: z.enum(["member", "maintainer"]).default("member"),
    })
    .optional(),
});

export type EntitlementRef = z.infer<typeof EntitlementRefSchema>;

// ============================================================================
// External Identity (verified external system identities)
// ============================================================================

export const ExternalIdentitySchema = z.object({
  github: z
    .object({
      login: z.string().min(1),
      verified: z.boolean().default(false),
      verifiedAt: z.string().datetime().optional(),
      source: z.enum(["admin", "github", "idp"]).default("admin"),
    })
    .optional(),
  // Future: slack, google, entra, okta, etc.
});

export type ExternalIdentity = z.infer<typeof ExternalIdentitySchema>;

// ============================================================================
// Access Request
// ============================================================================

export const AccessRequestSchema = z.object({
  id: z.string().uuid(),
  correlationId: z.string().uuid(),
  requesterId: z.string().min(1),
  requesterEmail: z.string().email(),
  externalIdentities: ExternalIdentitySchema,
  entitlement: EntitlementRefSchema,
  reason: z.string().min(1),
  status: AccessRequestStatusSchema,
  version: z.number().int().nonnegative().default(0),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  expiresAt: z.string().datetime().optional(),
  accessExpiresAt: z.string().datetime().optional(),
  approvedAt: z.string().datetime().optional(),
  approvedBy: z.string().optional(),
  deniedAt: z.string().datetime().optional(),
  deniedBy: z.string().optional(),
  deniedReason: z.string().optional(),
  fulfilledAt: z.string().datetime().optional(),
  fulfillmentError: z.string().optional(),
  externalId: z.string().optional(),
  idempotencyKey: z.string(),
  metadata: z.record(z.unknown()).optional().default({}),
  // Expiration retry fields
  expirationAttemptCount: z.number().int().nonnegative().optional().default(0),
  expirationNextAttemptAt: z.string().datetime().optional(),
  expirationMaxRetries: z.number().int().nonnegative().optional().default(3),
  expirationLastError: z.string().optional(),
  expirationLastErrorCode: z.number().optional(),
  expirationLastAttemptAt: z.string().datetime().optional(),
  // Lease fields for distributed workers
  leaseOwner: z.string().optional(),
  leaseUntil: z.string().datetime().optional(),
  leaseAcquiredAt: z.string().datetime().optional(),
});

export type AccessRequest = z.infer<typeof AccessRequestSchema>;

// ============================================================================
// Approved Access Request (for executor - type-safe boundary)
// ============================================================================

export const ApprovedAccessRequestSchema = AccessRequestSchema.extend({
  status: z.literal("APPROVED"),
  approvedAt: z.string().datetime(),
  approvedBy: z.string(),
});

export type ApprovedAccessRequest = z.infer<typeof ApprovedAccessRequestSchema>;

// Type guard to ensure only approved requests can be executed
export function toApprovedAccessRequest(request: AccessRequest): ApprovedAccessRequest {
  if (request.status !== "APPROVED") {
    throw new Error(`Cannot execute request in status: ${request.status}. Must be APPROVED.`);
  }
  if (!request.approvedAt || !request.approvedBy) {
    throw new Error("Approved request missing approval metadata");
  }
  return request as ApprovedAccessRequest;
}

// ============================================================================
// Fulfilled Access Request (for revocation - type-safe boundary)
// ============================================================================

export const FulfilledAccessRequestSchema = AccessRequestSchema.extend({
  status: z.literal("FULFILLED"),
  fulfilledAt: z.string().datetime(),
  externalId: z.string(),
});

export type FulfilledAccessRequest = z.infer<typeof FulfilledAccessRequestSchema>;

// Type guard to ensure only fulfilled requests can be revoked
export function toFulfilledAccessRequest(request: AccessRequest): FulfilledAccessRequest {
  if (request.status !== "FULFILLED") {
    throw new Error(`Cannot revoke request in status: ${request.status}. Must be FULFILLED.`);
  }
  if (!request.fulfilledAt || !request.externalId) {
    throw new Error("Fulfilled request missing fulfillment metadata");
  }
  return request as FulfilledAccessRequest;
}

// ============================================================================
// Revocation Result
// ============================================================================

export const RevocationResultSchema = z.object({
  success: z.boolean(),
  message: z.string(),
  error: z.string().optional(),
  reason: z.string().optional(), // e.g., "REVOCATION_RECONCILIATION_FAILED", "EXTERNAL_AUTHORITY_MANAGED"
  authority: z.string().optional(), // e.g., "github-team-sync"
});

export type RevocationResult = z.infer<typeof RevocationResultSchema>;

// ============================================================================
// Access Executor Interface (shared to break circular dependency)
// ============================================================================

export interface AccessExecutor {
  grant(request: ApprovedAccessRequest): Promise<ExecutionResult>;
  revoke(request: FulfilledAccessRequest): Promise<RevocationResult>;
}

// ============================================================================
// Approval Decision
// ============================================================================

export const ApprovalDecisionSchema = z.object({
  decision: z.enum(["APPROVE", "DENY"]),
  approverId: z.string(),
  approverEmail: z.string().email(),
  reason: z.string().max(2000).optional(),
  timestamp: z.string().datetime().default(() => new Date().toISOString()),
});

export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;

// ============================================================================
// Policy Evaluation Result
// ============================================================================

export const PolicyDecisionSchema = z.enum(["APPROVAL_REQUIRED", "DENY", "ALLOW"]);

export type PolicyDecision = z.infer<typeof PolicyDecisionSchema>;

export const PolicyEvaluationResultSchema = z.object({
  decision: PolicyDecisionSchema,
  requiredApprovers: z.array(z.string()).default([]),
  reason: z.string(),
  policyId: z.string(),
  metadata: z.record(z.unknown()).optional().default({}),
});

export type PolicyEvaluationResult = z.infer<typeof PolicyEvaluationResultSchema>;

// ============================================================================
// Execution Result
// ============================================================================

export const ExecutionResultSchema = z.object({
  success: z.boolean(),
  externalId: z.string().optional(), // e.g., GitHub team membership ID
  message: z.string(),
  error: z.string().optional(),
  status: z.string().optional(), // e.g., "AWAITING_EXTERNAL_ACCEPTANCE"
  reason: z.string().optional(), // e.g., "EXTERNAL_AUTHORITY_MANAGED"
  authority: z.string().optional(), // e.g., "github-team-sync"
});

export type ExecutionResult = z.infer<typeof ExecutionResultSchema>;