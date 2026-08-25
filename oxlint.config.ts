import { defineConfig } from "oxlint";

export default defineConfig({
  ignorePatterns: [
    "dist/**",
    "coverage/**",
    ".live-results/**",
    "*.d.ts",
    "tools/oxlint/anti-slop/**",
    "run-*.js",
    "run-*.mjs",
    "distributed-*.mjs",
    "load-test-*.mjs",
  ],
  jsPlugins: [
    { name: "anti-slop", specifier: "./tools/oxlint/anti-slop/index.ts" },
  ],
  rules: {
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
  },
});