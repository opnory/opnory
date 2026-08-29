import { z } from "zod";

// ============================================================================
// Resource Scope
// ============================================================================

export const ResourceScopeSchema = z.object({
  tenantId: z.string().optional(),
  workspaceId: z.string().optional(),
  resourceType: z.string().optional(),
  resourceId: z.string().optional(),
});

export type ResourceScope = z.infer<typeof ResourceScopeSchema>;

// ============================================================================
// Permission
// ============================================================================

export const ProviderMappingSchema = z.object({
  provider: z.string(),
  type: z.enum(["group", "appRole", "team", "application"]),
  value: z.string(),
});

export type ProviderMapping = z.infer<typeof ProviderMappingSchema>;

export const PermissionSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  mappings: z.array(ProviderMappingSchema),
});

export type Permission = z.infer<typeof PermissionSchema>;

// ============================================================================
// EntitlementRequest
// ============================================================================

export const EntitlementRequestStatusSchema = z.enum([
  "pending",
  "approved",
  "denied",
  "fulfilled",
  "revoked",
  "failed",
  "cancelled",
]);

export type EntitlementRequestStatus = z.infer<
  typeof EntitlementRequestStatusSchema
>;

export const EntitlementRequestSchema = z.object({
  id: z.string().uuid(),
  subjectId: z.string(),
  entitlementId: z.string(),
  requestedAt: z.string().datetime(),
  justification: z.string().optional(),
  requestedBy: z.string(),
  status: EntitlementRequestStatusSchema,
});

export type EntitlementRequest = z.infer<typeof EntitlementRequestSchema>;

// ============================================================================
// PolicyDecision
// ============================================================================

export const PolicyDecisionSchema = z.object({
  id: z.string().uuid(),
  requestId: z.string().uuid(),
  decision: z.enum(["approved", "denied"]),
  reason: z.string(),
  evaluatedBy: z.string(),
  evaluatedAt: z.string().datetime(),
});

export type PolicyDecision = z.infer<typeof PolicyDecisionSchema>;

// ============================================================================
// RoleAssignment
// ============================================================================

export const RoleAssignmentStatusSchema = z.enum([
  "active",
  "expired",
  "revoked",
]);

export type RoleAssignmentStatus = z.infer<typeof RoleAssignmentStatusSchema>;

export const RoleAssignmentSchema = z.object({
  id: z.string().uuid(),
  subjectId: z.string(),
  roleId: z.string(),
  scope: ResourceScopeSchema,
  grantedAt: z.string().datetime(),
  expiresAt: z.string().datetime().optional(),
  sourceRequestId: z.string().uuid(),
  status: RoleAssignmentStatusSchema,
});

export type RoleAssignment = z.infer<typeof RoleAssignmentSchema>;

// ============================================================================
// FulfillmentOperation
// ============================================================================

export const FulfillmentOperationSchema = z.object({
  id: z.string().uuid(),
  assignmentId: z.string().uuid(),
  provider: z.string(),
  action: z.enum(["grant", "revoke"]),
  providerObjectId: z.string().optional(),
  status: z.enum(["pending", "completed", "failed"]),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime().optional(),
  error: z.string().optional(),
});

export type FulfillmentOperation = z.infer<typeof FulfillmentOperationSchema>;

// ============================================================================
// EvidenceEvent
// ============================================================================

export const EvidenceEventSchema = z.object({
  id: z.string().uuid(),
  assignmentId: z.string().uuid(),
  action: z.enum(["grant", "verify", "revoke"]),
  provider: z.string(),
  providerObjectId: z.string(),
  correlationId: z.string(),
  occurredAt: z.string().datetime(),
});

export type EvidenceEvent = z.infer<typeof EvidenceEventSchema>;

// ============================================================================
// FulfillmentAdapter Interface
// ============================================================================

export const SubjectRefSchema = z.object({
  type: z.enum(["user", "servicePrincipal", "group"]),
  identifier: z.string(), // UPN, objectId, or displayName
  tenantId: z.string().optional(),
});

export type SubjectRef = z.infer<typeof SubjectRefSchema>;

export const ResolvedSubjectSchema = z.object({
  provider: z.string(),
  providerSubjectId: z.string(),
  correlationId: z.string().optional(),
});

export type ResolvedSubject = z.infer<typeof ResolvedSubjectSchema>;

export const FulfillmentResultSchema = z.object({
  status: z.enum(["succeeded", "failed"]),
  mutated: z.boolean(),
  provider: z.string(),
  providerObjectId: z.string().optional(),
  correlationId: z.string().optional(),
  error: z.string().optional(),
});

export type FulfillmentResult = z.infer<typeof FulfillmentResultSchema>;

export const VerificationResultSchema = z.object({
  status: z.enum(["verified", "not-found", "failed"]),
  provider: z.string(),
  providerObjectId: z.string().optional(),
  correlationId: z.string().optional(),
  error: z.string().optional(),
});

export type VerificationResult = z.infer<typeof VerificationResultSchema>;

// ============================================================================
// FulfillmentResult Construction
// ============================================================================
//
// A `FulfillmentResult` with `status: "succeeded"` MUST be backed by a
// verification that established the desired subject + entitlement state.
// Constructing one ad-hoc (object literal) is prohibited by the
// `opnory/no-unchecked-fulfillment-success` lint rule; every success result
// must flow through one of the factory functions below.

/** The mutation that the fulfillment operation actually performed. */
export type FulfillmentMutation = "performed" | "already-desired";

/**
 * Build a success `FulfillmentResult` from a verification that established the
 * desired state is present. Refuses to construct a success result when the
 * verification did not observe the desired state.
 */
export function fulfilledAfterVerification(
  verification: VerificationResult,
  mutation: FulfillmentMutation,
): FulfillmentResult {
  if (verification.status !== "verified") {
    throw new Error(
      `Cannot construct success without verified desired state (verification status: ${verification.status})`,
    );
  }

  return {
    status: "succeeded",
    mutated: mutation === "performed",
    provider: verification.provider,
    providerObjectId: verification.providerObjectId,
    correlationId: verification.correlationId,
  };
}

/**
 * Build a failure `FulfillmentResult`. Failures do not carry a desired-state
 * guarantee and may be constructed directly.
 */
export function failedFulfillment(
  provider: string,
  error: string,
  extra?: { providerObjectId?: string; correlationId?: string },
): FulfillmentResult {
  return {
    status: "failed",
    mutated: false,
    provider,
    providerObjectId: extra?.providerObjectId,
    correlationId: extra?.correlationId,
    error,
  };
}

export interface FulfillmentAdapter {
  readonly provider: string;

  resolveSubject(subject: SubjectRef): Promise<ResolvedSubject>;

  grant(
    assignment: RoleAssignment,
    permission: Permission,
    scope: ResourceScope,
    resolvedSubject: ResolvedSubject,
  ): Promise<FulfillmentResult>;

  verify(
    assignment: RoleAssignment,
    permission: Permission,
    scope: ResourceScope,
    resolvedSubject: ResolvedSubject,
  ): Promise<VerificationResult>;

  revoke(
    assignment: RoleAssignment,
    permission: Permission,
    scope: ResourceScope,
    resolvedSubject: ResolvedSubject,
  ): Promise<FulfillmentResult>;
}
