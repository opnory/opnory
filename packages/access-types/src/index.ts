import { z } from "zod";
import { getLogger } from "@opnory/observability";

const logger = getLogger().child({ component: "access-types" });

// ============================================================================
// Governance Provider Type
// ============================================================================

export const GovernanceProviderTypeSchema = z.enum(["local", "entra", "okta"]);

export type GovernanceProviderType = z.infer<
  typeof GovernanceProviderTypeSchema
>;

// ============================================================================
// Governance Authority (who decides)
// ============================================================================

export const GovernanceAuthoritySchema = z.enum(["local", "entra", "okta"]);

export type GovernanceAuthority = z.infer<typeof GovernanceAuthoritySchema>;

// ============================================================================
// Governance Ownership (who owns what)
// ============================================================================

export const GovernanceOwnerSchema = z.enum(["opnory", "entra", "okta"]);

export type GovernanceOwner = z.infer<typeof GovernanceOwnerSchema>;

export const GovernanceOwnershipSchema = z.object({
  authority: GovernanceAuthoritySchema,
  approvalOwner: GovernanceOwnerSchema,
  fulfillmentOwner: GovernanceOwnerSchema,
  expirationOwner: GovernanceOwnerSchema,
});

export type GovernanceOwnership = z.infer<typeof GovernanceOwnershipSchema>;

// ============================================================================
// Typed Governance Configuration (replaces metadata for governance)
// ============================================================================

export const LocalGovernanceConfigSchema = z.object({
  provider: z.literal("local"),
});

export const EntraGovernanceConfigSchema = z.object({
  provider: z.literal("entra"),
  tenantId: z.string().min(1),
  accessPackageId: z.string().min(1),
  assignmentPolicyId: z.string().min(1),
  fulfillmentOwner: z.enum(["opnory", "entra", "okta"]).default("entra"),
  expirationOwner: z.enum(["opnory", "entra", "okta"]).default("entra"),
});

export const OktaGovernanceConfigSchema = z.object({
  provider: z.literal("okta"),
  orgUrl: z.string().url(),
  appId: z.string().min(1),
  groupId: z.string().min(1),
  fulfillmentOwner: z.enum(["opnory", "entra", "okta"]).default("okta"),
  expirationOwner: z.enum(["opnory", "entra", "okta"]).default("okta"),
});

export const GovernanceConfigSchema = z.discriminatedUnion("provider", [
  LocalGovernanceConfigSchema,
  EntraGovernanceConfigSchema,
  OktaGovernanceConfigSchema,
]);

export type GovernanceConfig = z.infer<typeof GovernanceConfigSchema>;

// ============================================================================
// Governance Subject (resolved user identity in target authority system)
// ============================================================================

export const GovernanceSubjectSchema = z.object({
  id: z.string().min(1), // e.g., Entra objectId, Okta user ID, GitHub user ID
  displayName: z.string().optional(),
  email: z.string().email().optional(),
  source: z.enum(["entra", "okta", "github", "manual"]),
  raw: z.record(z.unknown()).optional(), // Preserve original resolution data
});

export type GovernanceSubject = z.infer<typeof GovernanceSubjectSchema>;

// ============================================================================
// Governed Entitlement (entitlement mapped to external authority)
// ============================================================================

export const GovernedEntitlementSchema = z.object({
  entitlementId: z.string().uuid(), // Opnory entitlement ID
  authority: GovernanceAuthoritySchema,
  externalId: z.string().min(1), // e.g., Entra access package ID, Okta group/app ID, GitHub team slug
  externalName: z.string().optional(),
  metadata: z.record(z.unknown()).optional().default({}),
});

export type GovernedEntitlement = z.infer<typeof GovernedEntitlementSchema>;

// ============================================================================
// Governed Access Request (request submitted to external authority)
// ============================================================================

export const GovernedAccessRequestSchema = z.object({
  requestId: z.string().uuid(), // Opnory request ID
  subject: GovernanceSubjectSchema,
  entitlement: GovernedEntitlementSchema,
  justification: z.string().min(1),
  requestedDuration: z.string().optional(), // ISO 8601 duration, e.g., "P90D"
  metadata: z.record(z.unknown()).optional().default({}),
});

export type GovernedAccessRequest = z.infer<typeof GovernedAccessRequestSchema>;

// ============================================================================
// Normalized Provider Result Types (authority-agnostic)
// ============================================================================

export const GovernanceDecisionStatusSchema = z.enum([
  "PENDING",
  "APPROVED",
  "DENIED",
  "CANCELLED",
  "FAILED",
]);

export type GovernanceDecisionStatus = z.infer<
  typeof GovernanceDecisionStatusSchema
>;

export const GovernanceAssignmentStatusSchema = z.enum([
  "ACTIVE",
  "PENDING",
  "REVOKED",
  "NOT_FOUND",
]);

export type GovernanceAssignmentStatus = z.infer<
  typeof GovernanceAssignmentStatusSchema
>;

// ============================================================================
// Governance Request (submitted to external authority)
// ============================================================================

export const GovernanceRequestSchema = z.object({
  externalRequestId: z.string().min(1), // Entra request ID, Okta request ID, GitHub PR number, etc.
  authority: GovernanceAuthoritySchema,
  status: GovernanceDecisionStatusSchema, // Normalized decision status
  submittedAt: z.string().datetime(),
  decidedAt: z.string().datetime().optional(),
  decidedBy: z.string().optional(),
  decisionReason: z.string().optional(),
  assignmentId: z.string().optional(), // Entra assignment ID, Okta membership ID, GitHub membership ID
  assignmentExpiresAt: z.string().datetime().optional(),
  metadata: z.record(z.unknown()).optional().default({}),
});

export type GovernanceRequest = z.infer<typeof GovernanceRequestSchema>;

// ============================================================================
// Governance Request Status (for polling - normalized)
// ============================================================================

export const GovernanceRequestStatusSchema = z.object({
  externalRequestId: z.string().min(1),
  status: GovernanceDecisionStatusSchema,
  assignmentId: z.string().optional(),
  assignmentExpiresAt: z.string().datetime().optional(),
  lastPolledAt: z.string().datetime(),
  rawResponse: z.record(z.unknown()).optional(),
});

export type GovernanceRequestStatus = z.infer<
  typeof GovernanceRequestStatusSchema
>;

// ============================================================================
// Governance Assignment (active assignment from authority)
// ============================================================================

export const GovernanceAssignmentSchema = z.object({
  assignmentId: z.string().min(1), // Entra assignment ID, Okta membership ID, GitHub membership ID
  subject: GovernanceSubjectSchema,
  entitlement: GovernedEntitlementSchema,
  authority: GovernanceAuthoritySchema,
  grantedAt: z.string().datetime(),
  expiresAt: z.string().datetime().optional(),
  status: GovernanceAssignmentStatusSchema,
  raw: z.record(z.unknown()).optional(),
});

export type GovernanceAssignment = z.infer<typeof GovernanceAssignmentSchema>;

// ============================================================================
// Governance Revocation Result
// ============================================================================

export const GovernanceRevocationResultSchema = z.object({
  success: z.boolean(),
  message: z.string(),
  error: z.string().optional(),
  reason: z.string().optional(),
  authority: z.string().optional(),
  assignmentId: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
  // Explicit status for authoritative mutation outcome
  status: z.enum(["REVOKED", "OBSERVE_ONLY"]).optional(),
  // Whether authoritative mutation was actually performed
  authoritativeMutationPerformed: z.boolean().optional(),
  // Reason for observe-only fallback
  fallbackReason: z.string().optional(),
});

export type GovernanceRevocationResult = z.infer<
  typeof GovernanceRevocationResultSchema
>;

// ============================================================================
// Governance Provider Interface
// ============================================================================

export interface GovernanceProvider {
  readonly authority: GovernanceAuthority;

  // Resolve Opnory identity to governance subject
  resolveSubject(identity: {
    requesterId: string;
    requesterEmail: string;
    externalIdentities: any;
  }): Promise<GovernanceSubject>;

  // Resolve Opnory entitlement to governed entitlement
  resolveEntitlement(entitlement: any): Promise<GovernedEntitlement>;

  // Submit request to external authority
  submitRequest(request: GovernedAccessRequest): Promise<GovernanceRequest>;

  // Get status of submitted request
  getRequestStatus(externalRequestId: string): Promise<GovernanceRequestStatus>;

  // Get active assignment for subject+entitlement
  getAssignment(
    subject: GovernanceSubject,
    entitlement: GovernedEntitlement,
  ): Promise<GovernanceAssignment | null>;

  // Revoke assignment
  revokeAssignment(
    assignment: GovernanceAssignment,
  ): Promise<GovernanceRevocationResult>;
}

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
  "AWAITING_AUTHORITY_DECISION", // Waiting for external governance authority decision
]);

export type AccessRequestStatus = z.infer<typeof AccessRequestStatusSchema>;

// Valid status transitions
// SAFETY: `as const satisfies` preserves exact literal types while validating conformance
export const VALID_TRANSITIONS = {
  PENDING_APPROVAL: [
    "APPROVED",
    "DENIED",
    "CANCELLED",
    "AWAITING_AUTHORITY_DECISION",
  ],
  APPROVED: ["FULFILLING", "CANCELLED", "AWAITING_EXTERNAL_ACCEPTANCE"],
  DENIED: ["CANCELLED"],
  FULFILLING: ["FULFILLED", "FAILED"],
  FULFILLED: ["REVOCATION_PENDING", "CANCELLED", "RETRY", "REVOCATION_FAILED"],
  FAILED: [
    "FULFILLING",
    "CANCELLED",
    "FULFILLED",
    "AWAITING_EXTERNAL_ACCEPTANCE",
  ],
  CANCELLED: [],
  AWAITING_EXTERNAL_ACCEPTANCE: [
    "FULFILLED",
    "FAILED",
    "CANCELLED",
    "REVOCATION_PENDING",
  ],
  REVOCATION_PENDING: ["REVOKED", "FAILED"],
  REVOKED: [],
  RETRY: ["REVOCATION_PENDING", "RETRY", "REVOCATION_FAILED", "FULFILLED"], // Retry can go to pending, retry again, terminal, or extension
  REVOCATION_FAILED: ["RETRY", "REVOCATION_PENDING"], // Manual recovery can retry
  AWAITING_AUTHORITY_DECISION: ["APPROVED", "DENIED", "CANCELLED"],
} as const satisfies Record<AccessRequestStatus, readonly AccessRequestStatus[]>;

export function canTransition(
  from: AccessRequestStatus,
  to: AccessRequestStatus,
): boolean {
  // SAFETY: VALID_TRANSITIONS is `as const satisfies Record<AccessRequestStatus, readonly AccessRequestStatus[]>`
  // so its keys are exactly AccessRequestStatus and values are readonly AccessRequestStatus[]
  // SAFETY: assertion here narrows the const satisfies type to the Record type for indexing
  return (VALID_TRANSITIONS as Record<AccessRequestStatus, readonly AccessRequestStatus[]>)[from]?.includes(to) ?? false;
}

export function transitionOrThrow(
  from: AccessRequestStatus,
  to: AccessRequestStatus,
  options?: { expectedVersion?: number; actualVersion?: number },
): void {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid status transition: ${from} -> ${to}`);
  }
  if (
    options?.expectedVersion !== undefined &&
    options?.actualVersion !== undefined
  ) {
    if (options.expectedVersion !== options.actualVersion) {
      throw new Error(
        `Optimistic concurrency conflict: expected version ${options.expectedVersion}, found ${options.actualVersion}`,
      );
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
  // Governance configuration for this entitlement (typed discriminated union)
  governance: GovernanceConfigSchema.optional(),
  // Additional metadata for governance providers
  metadata: z.record(z.unknown()).optional().default({}),
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
  // Governance fields for Entra/external authority
  governanceExternalRequestId: z.string().optional(),
  governanceAuthority: GovernanceAuthoritySchema.optional(),
  governanceAssignmentId: z.string().optional(),
  governanceAssignmentExpiresAt: z.string().datetime().optional(),
  // Reconciliation state fields
  governanceLastCheckedAt: z.string().datetime().optional(),
  governanceNextCheckAt: z.string().datetime().optional(),
  governanceRetryCount: z.number().int().nonnegative().optional().default(0),
  governanceLastError: z.string().optional(),
  governanceLastErrorCode: z.number().optional(),
  // Governance lease fields for distributed reconciliation worker
  governanceLeaseOwner: z.string().optional(),
  governanceLeaseUntil: z.string().datetime().optional(),
  governanceLeaseAcquiredAt: z.string().datetime().optional(),
  governanceAttemptCount: z.number().int().nonnegative().optional().default(0),
  governanceNextAttemptAt: z.string().datetime().optional(),
  governanceLastAttemptAt: z.string().datetime().optional(),
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
export function toApprovedAccessRequest(
  request: AccessRequest,
): ApprovedAccessRequest {
  if (request.status !== "APPROVED") {
    throw new Error(
      `Cannot execute request in status: ${request.status}. Must be APPROVED.`,
    );
  }
  if (!request.approvedAt || !request.approvedBy) {
    throw new Error("Approved request missing approval metadata");
  }
  // SAFETY: status passed the APPROVED check and approvedAt/approvedBy presence check above
  return request as ApprovedAccessRequest;
}

// Type guard for retry fulfillment (allows FULFILLING status from retry)
export function toRetryFulfillmentRequest(
  request: AccessRequest,
): ApprovedAccessRequest {
  if (request.status !== "APPROVED" && request.status !== "FULFILLING") {
    throw new Error(
      `Cannot execute request in status: ${request.status}. Must be APPROVED or FULFILLING.`,
    );
  }
  if (!request.approvedAt || !request.approvedBy) {
    throw new Error("Approved request missing approval metadata");
  }
  // SAFETY: status passed the APPROVED/FULFILLING check and approvedAt/approvedBy presence check above
  return request as ApprovedAccessRequest;
}

// ============================================================================
// Fulfilled Access Request (for revocation - type-safe boundary)
// ============================================================================

export const FulfilledAccessRequestSchema = AccessRequestSchema.extend({
  status: z.literal("FULFILLED"),
  fulfilledAt: z.string().datetime(),
  externalId: z.string(),
  // Governance lease fields (inherited from AccessRequestSchema)
  governanceLeaseOwner: z.string().optional(),
  governanceLeaseUntil: z.string().datetime().optional(),
  governanceLeaseAcquiredAt: z.string().datetime().optional(),
  governanceAttemptCount: z.number().int().nonnegative().optional().default(0),
  governanceNextAttemptAt: z.string().datetime().optional(),
  governanceLastAttemptAt: z.string().datetime().optional(),
});

export type FulfilledAccessRequest = z.infer<
  typeof FulfilledAccessRequestSchema
>;

// Type guard to ensure only fulfilled requests can be revoked
export function toFulfilledAccessRequest(
  request: AccessRequest,
): FulfilledAccessRequest {
  if (request.status !== "FULFILLED") {
    throw new Error(
      `Cannot revoke request in status: ${request.status}. Must be FULFILLED.`,
    );
  }
  if (!request.fulfilledAt || !request.externalId) {
    throw new Error("Fulfilled request missing fulfillment metadata");
  }
  // SAFETY: status passed the FULFILLED check and fulfilledAt/externalId presence check above
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
// Governance Reconciliation
// ============================================================================

export const ReconciliationResultSchema = z.object({
  requestsChecked: z.number().int().nonnegative(),
  requestsUpdated: z.number().int().nonnegative(),
  driftDetected: z.number().int().nonnegative(),
  errors: z.array(
    z.object({
      externalRequestId: z.string().optional(),
      error: z.string(),
      errorCode: z.number().optional(),
    }),
  ),
});

export type ReconciliationResult = z.infer<typeof ReconciliationResultSchema>;

export const GovernanceReconcilerConfigSchema = z.object({
  provider: z.enum(["local", "entra", "okta"]),
  maxRetries: z.number().int().nonnegative().default(3),
  retryBackoffMs: z.number().int().nonnegative().default(5000),
  driftDetectionEnabled: z.boolean().default(true),
});

export type GovernanceReconcilerConfig = z.infer<
  typeof GovernanceReconcilerConfigSchema
>;

export interface GovernanceReconciler {
  reconcilePendingRequests(): Promise<ReconciliationResult>;
  reconcileAssignments(): Promise<ReconciliationResult>;
  reconcileRevocations(): Promise<ReconciliationResult>;
}

// Reconciliation state for access requests
export const ReconciliationStateSchema = z.object({
  lastCheckedAt: z.string().datetime().optional(),
  nextCheckAt: z.string().datetime().optional(),
  retryCount: z.number().int().nonnegative().default(0),
  lastError: z.string().optional(),
  lastErrorCode: z.number().optional(),
});

export type ReconciliationState = z.infer<typeof ReconciliationStateSchema>;

// Audit event types for reconciliation
export const ReconciliationAuditEventTypeSchema = z.enum([
  "GOVERNANCE_RECONCILIATION_STARTED",
  "GOVERNANCE_RECONCILIATION_SUCCEEDED",
  "GOVERNANCE_RECONCILIATION_FAILED",
  "GOVERNANCE_DRIFT_DETECTED",
  "GOVERNANCE_STATE_CORRECTED",
]);

export type ReconciliationAuditEventType = z.infer<
  typeof ReconciliationAuditEventTypeSchema
>;

export const ApprovalDecisionSchema = z.object({
  decision: z.enum(["APPROVE", "DENY"]),
  approverId: z.string(),
  approverEmail: z.string().email(),
  reason: z.string().max(2000).optional(),
  timestamp: z
    .string()
    .datetime()
    .default(() => new Date().toISOString()),
});

export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;

// ============================================================================
// Policy Evaluation Result
// ============================================================================

export const PolicyDecisionSchema = z.enum([
  "APPROVAL_REQUIRED",
  "DENY",
  "ALLOW",
]);

export type PolicyDecision = z.infer<typeof PolicyDecisionSchema>;

export const PolicyEvaluationResultSchema = z.object({
  decision: PolicyDecisionSchema,
  requiredApprovers: z.array(z.string()).default([]),
  reason: z.string(),
  policyId: z.string(),
  metadata: z.record(z.unknown()).optional().default({}),
});

export type PolicyEvaluationResult = z.infer<
  typeof PolicyEvaluationResultSchema
>;

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
