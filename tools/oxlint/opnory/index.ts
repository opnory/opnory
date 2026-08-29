import { eslintCompatPlugin } from "@oxlint/plugins";

import { noModelAuthorizationDecisionRule } from "./rules/no-model-authorization-decision.ts";
import { noProviderIdInPolicyRule } from "./rules/no-provider-id-in-policy.ts";
import { noUncheckedFulfillmentSuccessRule } from "./rules/no-unchecked-fulfillment-success.ts";
import { requireAuthoritativeResultConstructionRule } from "./rules/require-authoritative-result-construction.ts";

/**
 * Opnory governance-specific lint rules.
 * These enforce architectural invariants of the Opnory Governance Engine:
 * - Policy layer is provider-agnostic and never performs provider mutations
 * - Provider IDs belong to the fulfillment adapter layer only
 * - FulfillmentResult success must be constructed via factory, backed by verification
 */
const opnoryPlugin = eslintCompatPlugin({
  meta: { name: "opnory" },
  rules: {
    "no-model-authorization-decision": noModelAuthorizationDecisionRule,
    "no-provider-id-in-policy": noProviderIdInPolicyRule,
    "no-unchecked-fulfillment-success": noUncheckedFulfillmentSuccessRule,
    "require-authoritative-result-construction": requireAuthoritativeResultConstructionRule,
  },
});

export default opnoryPlugin;