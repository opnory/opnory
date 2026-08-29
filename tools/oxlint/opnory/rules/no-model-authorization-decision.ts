import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

/**
 * Policy decisions are pure, deterministic, and provider-agnostic. They must
 * never make the authorization decision that grants or revokes access against
 * a real provider — that is the FulfillmentAdapter's job. This rule flags the
 * policy layer reaching for provider-facing mutation primitives.
 *
 * Concretely: the `access-policy` package must not import from the
 * `governance-core` adapter layer, nor call `grant`/`revoke`/`fulfill` on a
 * provider object.
 */

const FORBIDDEN_ADAPTER_IMPORTS = new Set([
  "@opnory/governance-core",
  "@opnory/governance-core/adapters",
]);

const FORBIDDEN_CALL_METHODS = new Set([
  "grant",
  "revoke",
  "fulfill",
  "fulfillAssignment",
  "revokeAssignment",
]);

export const noModelAuthorizationDecisionRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow the policy/model layer from issuing provider authorization decisions (grant/revoke). Only fulfillment adapters perform provider mutations.",
    },
    messages: {
      adapterImport:
        "The policy layer must not import the fulfillment adapter layer. Authorization decisions (grant/revoke) belong in the FulfillmentAdapter, not the policy/model.",
      mutationCall:
        "The policy layer must not call a provider mutation (`{{method}}`). Emit a policy decision; let the FulfillmentAdapter perform the mutation.",
    },
  },
  create(context) {
    // Only enforce within the policy package.
    const filename = context.filename ?? "";
    const inPolicyLayer = /\/packages\/access-policy\//u.test(filename);
    if (!inPolicyLayer) return {};

    return {
      ImportDeclaration(node) {
        if (typeof node.source.value !== "string") return;
        if (FORBIDDEN_ADAPTER_IMPORTS.has(node.source.value)) {
          context.report({ node, messageId: "adapterImport" });
        }
      },
      CallExpression(node: ESTree.CallExpression) {
        const callee = node.callee;
        let methodName: string | null = null;
        if (
          callee.type === "MemberExpression" &&
          callee.property.type === "Identifier"
        ) {
          methodName = callee.property.name;
        }
        if (methodName && FORBIDDEN_CALL_METHODS.has(methodName)) {
          context.report({
            node,
            messageId: "mutationCall",
            data: { method: methodName },
          });
        }
      },
    };
  },
});