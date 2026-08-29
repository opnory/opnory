import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

/**
 * A `FulfillmentResult` with `status: "succeeded"` MUST be constructed via
 * `fulfilledAfterVerification` or `failedFulfillment` (from `@opnory/governance-core/domain`).
 * Direct object-literal construction of a success result is prohibited because
 * it bypasses the guarantee that the success is backed by a verified desired state.
 */

const SUCCESS_LITERAL_PROPS = new Set(["status", "mutated", "provider"]);

function isFulfillmentResultLiteral(node: ESTree.ObjectExpression): boolean {
  // Heuristic: object literal has at least `status` and `mutated` properties
  const hasStatus = node.properties.some(
    (p) =>
      p.type === "Property" &&
      p.key.type === "Identifier" &&
      p.key.name === "status" &&
      p.value.type === "Literal" &&
      p.value.value === "succeeded",
  );
  const hasMutated = node.properties.some(
    (p) =>
      p.type === "Property" &&
      p.key.type === "Identifier" &&
      p.key.name === "mutated",
  );
  return hasStatus && hasMutated;
}

function isFactoryCall(node: ESTree.CallExpression): boolean {
  if (
    node.callee.type === "Identifier" &&
    (node.callee.name === "fulfilledAfterVerification" ||
      node.callee.name === "failedFulfillment")
  ) {
    return true;
  }
  if (
    node.callee.type === "MemberExpression" &&
    node.callee.property.type === "Identifier" &&
    (node.callee.property.name === "fulfilledAfterVerification" ||
      node.callee.property.name === "failedFulfillment")
  ) {
    return true;
  }
  return false;
}

function isFactoryFunction(node: any): boolean {
  if (node.type === "FunctionDeclaration" && node.id) {
    return node.id.name === "fulfilledAfterVerification" || node.id.name === "failedFulfillment";
  }
  if (node.type === "VariableDeclarator" && node.id.type === "Identifier") {
    return node.id.name === "fulfilledAfterVerification" || node.id.name === "failedFulfillment";
  }
  return false;
}

export const noUncheckedFulfillmentSuccessRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow ad-hoc construction of success FulfillmentResult. Success results must flow through fulfilledAfterVerification or failedFulfillment factories to ensure desired-state verification.",
    },
    messages: {
      uncheckedSuccess:
        "FulfillmentResult with status 'succeeded' must be constructed via fulfilledAfterVerification or failedFulfillment, not an object literal. This ensures the success is backed by verified desired state.",
    },
  },
  create(context) {
    // Only enforce in production source (not tests, not live scripts, not adapters)
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

    // Track if we're inside a factory function
    let inFactoryFunction = 0;

    return {
      FunctionDeclaration(node) {
        if (isFactoryFunction(node)) {
          inFactoryFunction++;
        }
      },
      "FunctionDeclaration:exit"(node) {
        if (isFactoryFunction(node)) {
          inFactoryFunction--;
        }
      },
      ArrowFunctionExpression(node) {
        if (isFactoryFunction(node)) {
          inFactoryFunction++;
        }
      },
      "ArrowFunctionExpression:exit"(node) {
        if (isFactoryFunction(node)) {
          inFactoryFunction--;
        }
      },
      FunctionExpression(node) {
        if (isFactoryFunction(node)) {
          inFactoryFunction++;
        }
      },
      "FunctionExpression:exit"(node) {
        if (isFactoryFunction(node)) {
          inFactoryFunction--;
        }
      },
      ReturnStatement(node) {
        // Skip if we're inside a factory function or returning a factory call
        if (inFactoryFunction > 0) return;
        if (
          node.argument &&
          node.argument.type === "CallExpression" &&
          isFactoryCall(node.argument)
        ) {
          return;
        }
        if (
          node.argument &&
          node.argument.type === "ObjectExpression" &&
          isFulfillmentResultLiteral(node.argument)
        ) {
          context.report({ node: node.argument, messageId: "uncheckedSuccess" });
        }
      },
      VariableDeclarator(node) {
        // Skip if assigning the result of a factory call
        if (
          node.init &&
          node.init.type === "CallExpression" &&
          isFactoryCall(node.init)
        ) {
          return;
        }
        if (
          node.init &&
          node.init.type === "ObjectExpression" &&
          isFulfillmentResultLiteral(node.init)
        ) {
          context.report({ node: node.init, messageId: "uncheckedSuccess" });
        }
      },
      CallExpression(node) {
        if (
          node.callee.type === "Identifier" &&
          node.callee.name === "return" &&
          node.arguments.length === 1 &&
          node.arguments[0].type === "ObjectExpression" &&
          isFulfillmentResultLiteral(node.arguments[0])
        ) {
          context.report({ node: node.arguments[0], messageId: "uncheckedSuccess" });
        }
      },
    };
  },
});