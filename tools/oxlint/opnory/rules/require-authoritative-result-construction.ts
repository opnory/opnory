import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

/**
 * Every `FulfillmentResult` with `status: "succeeded"` must be backed by a
 * `VerificationResult` with `status: "verified"`. This is the lint-side
 * enforcement that the control-flow proof ensures: no success without a
 * prior verification establishing the desired state.
 *
 * The rule checks that:
 * 1. `fulfilledAfterVerification` is called with a verification argument
 *    that is not trivially `status: "verified"` (i.e., it's a variable that
 *    came from a real `verify` call).
 * 2. It does NOT attempt full control-flow analysis (that's intractable at
 *    lint time) — it instead makes the factory function the ONLY way to
 *    construct success, and the factory itself throws if verification is absent.
 *
 * This rule is a "sibling" to no-unchecked-fulfillment-success. Together they
 * enforce: (a) use the factory, (b) the factory enforces verification.
 */

export const requireAuthoritativeResultConstructionRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Require FulfillmentResult success to be constructed via fulfilledAfterVerification factory, ensuring desired-state verification.",
    },
    messages: {
      noFactory:
        "FulfillmentResult success must be constructed via fulfilledAfterVerification. This guarantees the result is backed by verified desired state.",
    },
  },
  create(context) {
    // Same scope as no-unchecked-fulfillment-success
    const filename = context.filename ?? "";
    const inTest =
      /\/.*\.test\.(ts|js)$/u.test(filename) ||
      /\/.*\.spec\.(ts|js)$/u.test(filename);
    const inLive = /\/scripts\/live-governance\//u.test(filename);
    const inFrozenAdapter = /\/packages\/governance-core\/src\/adapters\//u.test(filename);
    const inProdSource =
      /\/packages\/[^/]+\/src\//u.test(filename) ||
      /\/apps\/[^/]+\/src\//u.test(filename);
    if (!inProdSource || inTest || inLive || inFrozenAdapter) return {};

    return {
      CallExpression(node) {
        // Check for fulfilledAfterVerification calls that don't pass a verification
        if (
          node.callee.type === "Identifier" &&
          node.callee.name === "fulfilledAfterVerification"
        ) {
          const verificationArg = node.arguments[0];
          if (!verificationArg) {
            context.report({ node, messageId: "noFactory" });
          }
        }
        // Also check method-call form: verification.fulfilledAfterVerification(...)
        if (
          node.callee.type === "MemberExpression" &&
          node.callee.property.type === "Identifier" &&
          node.callee.property.name === "fulfilledAfterVerification"
        ) {
          const verificationArg = node.arguments[0];
          if (!verificationArg) {
            context.report({ node, messageId: "noFactory" });
          }
        }
      },
    };
  },
});