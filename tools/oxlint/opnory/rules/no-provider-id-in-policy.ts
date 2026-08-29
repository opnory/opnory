import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

/**
 * The policy/model layer must never embed or make decisions based on
 * provider-specific identifiers (Entra `objectId`, Okta `userId`, Azure AD
 * `tenantId`, etc.). Policy operates on domain concepts (entitlement, subject,
 * role) and the fulfillment adapter translates to provider identifiers.
 */

const PROVIDER_ID_PATTERNS = new Set([
  "objectId",
  "object_id",
  "providerObjectId",
  "provider_object_id",
  "providerSubjectId",
  "provider_subject_id",
  "tenantId",
  "tenant_id",
  "appObjectId",
  "app_object_id",
  "servicePrincipalId",
  "service_principal_id",
  "enterpriseAppId",
  "enterprise_app_id",
  "userId",
  "user_id",
  "groupId",
  "group_id",
]);

export const noProviderIdInPolicyRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow provider-specific identifiers in the policy layer. Policy operates on domain concepts; provider IDs belong to the fulfillment adapter layer.",
    },
    messages: {
      providerId:
        "Provider-specific identifier `{{id}}` must not appear in the policy layer. Use domain concepts (entitlement, subject, role); fulfillment adapters translate to provider IDs.",
    },
  },
  create(context) {
    const filename = context.filename ?? "";
    const inPolicyLayer = /\/packages\/access-policy\//u.test(filename);
    if (!inPolicyLayer) return {};

    return {
      Identifier(node: ESTree.Identifier) {
        if (PROVIDER_ID_PATTERNS.has(node.name)) {
          context.report({
            node,
            messageId: "providerId",
            data: { id: node.name },
          });
        }
      },
      Property(node: ESTree.Property) {
        if (node.key.type === "Identifier" && PROVIDER_ID_PATTERNS.has(node.key.name)) {
          context.report({
            node: node.key,
            messageId: "providerId",
            data: { id: node.key.name },
          });
        }
      },
    };
  },
});