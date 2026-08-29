import { defineConfig } from "oxlint";

export default defineConfig({
  categories: {
    correctness: "error",
    suspicious: "error",
    perf: "warn",
    pedantic: "off",
    style: "off",
    restriction: "off",
  },
  options: {
    reportUnusedDisableDirectives: "error",
  },
  ignorePatterns: [
    "dist/**",
    "coverage/**",
    ".live-results/**",
    "*.d.ts",
    "tools/oxlint/anti-slop/**",
    "tools/oxlint/opnory/rules/**",
    "run-*.js",
    "run-*.mjs",
    "distributed-*.mjs",
    "load-test-*.mjs",
  ],
  jsPlugins: [
    { name: "anti-slop", specifier: "./tools/oxlint/anti-slop/index.ts" },
    { name: "opnory", specifier: "./tools/oxlint/opnory/index.ts" },
  ],
  rules: {
    "eslint/no-unused-vars": "warn",
    "unicorn/no-empty-file": "off",
    "unicorn/no-array-sort": "off",
    "unicorn/require-post-message-target-origin": "off",
    "eslint/no-underscore-dangle": "off",
    "eslint/no-dupe-else-if": "warn",
    "unicorn/consistent-function-scoping": "warn",
    "eslint/no-await-in-loop": "warn",
    "eslint/no-useless-catch": "warn",
    "eslint/preserve-caught-error": "warn",
    "eslint/no-shadow": "warn",
    "anti-slop/no-chained-type-assertions": "warn",
    "anti-slop/no-conditional-empty-object-spread": "warn",
    "anti-slop/no-known-value-widening": "warn",
    "anti-slop/no-module-mocking": "warn",
    "anti-slop/no-object-parameters": "warn",
    "anti-slop/no-reflect-apply": "warn",
    "anti-slop/no-reflect-get": "warn",
    "anti-slop/no-runtime-typeof": ["warn", { allowInTypeGuards: true }],
    "anti-slop/no-shape-in-symbol-names": "off",
    "anti-slop/no-unknown-parameters": "off",
    "anti-slop/no-unknown-returns": "warn",
    "anti-slop/no-unknown-type-aliases": "warn",
    "anti-slop/no-unsafe-dictionary-type": "warn",
    "anti-slop/no-widen-then-assert": "warn",
    "anti-slop/require-safety-comment-for-type-assertion": "warn",
    "opnory/no-model-authorization-decision": "warn",
    "opnory/no-provider-id-in-policy": "warn",
    "opnory/no-unchecked-fulfillment-success": "warn",
    "opnory/require-authoritative-result-construction": "warn",
  },
  overrides: [
    {
      // Production packages: promote anti-slop warnings to errors
      files: [
        "packages/access-policy/**",
        "packages/access-service/**",
        "packages/access-governance/**",
        "packages/access-executor/**",
        "packages/access-store-pg/**",
        "packages/access-approval/**",
        "packages/access-entitlements/**",
        "packages/access-audit/**",
        "packages/access-types/**",
        "packages/agent/**",
        "apps/api/**",
        "apps/slack/**",
      ],
      rules: {
        "anti-slop/no-chained-type-assertions": "error",
        "anti-slop/no-known-value-widening": "error",
        "anti-slop/no-object-parameters": "error",
        "anti-slop/no-runtime-typeof": ["error", { allowInTypeGuards: true }],
        "anti-slop/no-unsafe-dictionary-type": "error",
        "anti-slop/require-safety-comment-for-type-assertion": "error",
        "opnory/no-model-authorization-decision": "error",
        "opnory/no-provider-id-in-policy": "error",
        "opnory/no-unchecked-fulfillment-success": "error",
        "opnory/require-authoritative-result-construction": "error",
      },
    },
    {
      // Frozen adapters: keep all at warn
      files: [
        "packages/governance-core/src/adapters/fulfillment.ts",
        "packages/governance-core/src/adapters/conformance.ts",
      ],
      rules: {
        "anti-slop/no-chained-type-assertions": "warn",
        "anti-slop/no-known-value-widening": "warn",
        "anti-slop/no-object-parameters": "warn",
        "anti-slop/no-runtime-typeof": ["warn", { allowInTypeGuards: true }],
        "anti-slop/no-unsafe-dictionary-type": "warn",
        "anti-slop/require-safety-comment-for-type-assertion": "warn",
        "opnory/no-model-authorization-decision": "warn",
        "opnory/no-provider-id-in-policy": "warn",
        "opnory/no-unchecked-fulfillment-success": "warn",
        "opnory/require-authoritative-result-construction": "warn",
      },
    },
    {
      // config: I/O boundary (env var parsing, JSON parsing) - keep unsafe-dictionary and runtime-typeof at warn
      files: ["packages/config/src/index.ts"],
      rules: {
        "anti-slop/no-unsafe-dictionary-type": "warn",
        "anti-slop/no-runtime-typeof": ["warn", { allowInTypeGuards: true }],
      },
    },
    {
      // observability: OpenTelemetry attributes boundary
      files: ["packages/observability/src/index.ts"],
      rules: {
        "anti-slop/no-unsafe-dictionary-type": "warn",
      },
    },
    {
      // access-governance: I/O boundary (audit store writes) - keep unsafe-dictionary at warn
      files: ["packages/access-governance/src/index.ts"],
      rules: {
        "anti-slop/no-unsafe-dictionary-type": "warn",
      },
    },
    {
      // access-policy: customer policy extensions boundary - keep unsafe-dictionary at warn
      files: ["packages/access-policy/**"],
      rules: {
        "anti-slop/no-unsafe-dictionary-type": "warn",
      },
    },
    {
      // access-types: VALID_TRANSITIONS const satisfies pattern - allow known-value-widening at specific line
      files: ["packages/access-types/src/index.ts"],
      rules: {
        "anti-slop/no-known-value-widening": "warn",
      },
    },
    {
      // apps/api: I/O boundary (external API payloads) - keep unsafe-dictionary at warn
      files: ["apps/api/**"],
      rules: {
        "anti-slop/no-unsafe-dictionary-type": "warn",
      },
    },
    {
      // access-executor: external GitHub API boundary - allow runtime typeof checks
      files: ["packages/access-executor/**"],
      rules: {
        "anti-slop/no-runtime-typeof": ["warn", { allowInTypeGuards: true }],
      },
    },
    {
      // live governance scripts: allow adapter imports and fulfillment objects
      files: ["scripts/live-governance/**"],
      rules: {
        "opnory/no-model-authorization-decision": "warn",
        "opnory/no-unchecked-fulfillment-success": "warn",
        "opnory/require-authoritative-result-construction": "warn",
      },
    },
    {
      // test fixtures: test file for Opnory native rules - apply production level
      files: ["tools/oxlint/opnory/test-fixtures/**"],
      rules: {
        "opnory/no-model-authorization-decision": "error",
        "opnory/no-provider-id-in-policy": "error",
        "opnory/no-unchecked-fulfillment-success": "error",
        "opnory/require-authoritative-result-construction": "error",
        "anti-slop/no-runtime-typeof": ["warn", { allowInTypeGuards: true }],
        "anti-slop/require-safety-comment-for-type-assertion": "warn",
        "anti-slop/no-unsafe-dictionary-type": "warn",
      },
    },
    {
      // All test files: keep anti-slop rules at warn (tests use type assertions and mocks)
      files: ["**/*.test.ts", "**/*.test.js", "**/*.spec.ts"],
      rules: {
        "anti-slop/no-chained-type-assertions": "warn",
        "anti-slop/no-known-value-widening": "warn",
        "anti-slop/no-object-parameters": "warn",
        "anti-slop/no-runtime-typeof": ["warn", { allowInTypeGuards: true }],
        "anti-slop/no-unsafe-dictionary-type": "warn",
        "anti-slop/require-safety-comment-for-type-assertion": "warn",
        "anti-slop/no-widen-then-assert": "warn",
        "anti-slop/no-unknown-returns": "warn",
        "anti-slop/no-unknown-type-aliases": "warn",
      },
    },
  ],
});