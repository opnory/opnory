import { getLogger } from "@opnory/observability";
import { EntitlementCatalog, canonicalEngineeringContributorEntitlement } from "@opnory/access-entitlements";
import {
  PolicyEvaluationResult,
  PolicyDecision,
  PolicyEvaluationResultSchema,
  EntitlementRef,
} from "@opnory/access-types";

const logger = getLogger().child({ component: "access-policy" });

// ============================================================================
// Policy Context
// ============================================================================

export interface PolicyContext {
  requesterId: string;
  requesterEmail: string;
  requesterRoles?: string[];
  requesterDepartment?: string;
  entitlement: EntitlementRef;
  metadata?: Record<string, unknown>;
}

// ============================================================================
// Policy Engine
// ============================================================================

export class PolicyEngine {
  private catalog: EntitlementCatalog;

  constructor(catalog?: EntitlementCatalog) {
    this.catalog = catalog || new EntitlementCatalog([canonicalEngineeringContributorEntitlement]);
  }

  evaluate(context: PolicyContext): PolicyEvaluationResult {
    logger.info({ requesterId: context.requesterId, entitlementId: context.entitlement.id }, "Evaluating access policy");

    // Verify entitlement exists in catalog
    const entitlement = this.catalog.getById(context.entitlement.id);
    if (!entitlement) {
      return {
        decision: "DENY",
        requiredApprovers: [],
        reason: `Entitlement ${context.entitlement.id} not found in catalog`,
        policyId: "ENTITLEMENT_NOT_FOUND",
        metadata: { entitlementId: context.entitlement.id },
      };
    }

    // For this first slice: always require manager approval
    // This is deterministic - no LLM involved in the decision
    if (entitlement.approvalPolicy === "MANAGER") {
      // In a real implementation, we'd resolve the manager from an org chart/IdP
      const requiredApprovers = this.resolveApprovers(context.requesterId, entitlement);

      return {
        decision: "APPROVAL_REQUIRED",
        requiredApprovers,
        reason: `Entitlement ${entitlement.name} requires manager approval per policy`,
        policyId: "MANAGER_APPROVAL_REQUIRED",
        metadata: {
          entitlementId: entitlement.id,
          approvalPolicy: entitlement.approvalPolicy,
          risk: entitlement.risk,
        },
      };
    }

    // Future: support AUTO, SECURITY_REVIEW, ADMIN
    return {
      decision: "DENY",
      requiredApprovers: [],
      reason: `Unsupported approval policy: ${entitlement.approvalPolicy}`,
      policyId: "UNSUPPORTED_POLICY",
      metadata: { approvalPolicy: entitlement.approvalPolicy },
    };
  }

  private resolveApprovers(requesterId: string, entitlement: { id: string; approvalPolicy: string }): string[] {
    // In a real implementation, this would query an org chart or IdP
    // For now, return a placeholder - the approval service will validate
    // that the approver is not the requester
    return [`manager-of-${requesterId}`];
  }
}

// ============================================================================
// Policy Evaluation Helpers
// ============================================================================

export function evaluateAccessPolicy(context: PolicyContext): PolicyEvaluationResult {
  const engine = new PolicyEngine();
  return engine.evaluate(context);
}