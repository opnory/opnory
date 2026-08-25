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
