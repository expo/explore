import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

/**
 * Correctness-only lint for the CLI, the Viewer and the tests. Formatting is not enforced here, so
 * the config asks for nothing a reviewer would not also ask for. Run with `npm run lint`.
 */
export default tseslint.config(
  { ignores: ["dist/**", "viewer/dist/**", "viewer-host/**", "examples/**", "node_modules/**", "runs/**", "test/ci/apps/**", "**/*.d.ts"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx,mts,cts,js,mjs,cjs}"],
    languageOptions: { globals: { ...globals.node, ...globals.browser, ...globals.es2024 } },
    rules: {
      "no-empty": ["error", { allowEmptyCatch: true }],
      // Report text is scrubbed of control characters on purpose; those regexes are the point.
      "no-control-regex": "off",
      "preserve-caught-error": "off",
      "no-useless-assignment": "off",
      // Cleanup code throws from `finally` only when the body did not already fail; the guards are deliberate.
      "no-unsafe-finally": "off",
      "no-constant-condition": ["error", { checkLoops: false }],
      "prefer-const": ["error", { ignoreReadBeforeAssign: true, destructuring: "all" }],
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" }],
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-unused-expressions": ["error", { allowShortCircuit: true, allowTernary: true }],
    },
  },
  {
    files: ["test/**"],
    rules: { "require-yield": "off" },
  },
  {
    files: ["viewer/src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // The React Compiler rules assume compiled output; the Viewer is not compiled by it yet.
      "react-hooks/refs": "off",
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/preserve-manual-memoization": "off",
    },
  },
);
