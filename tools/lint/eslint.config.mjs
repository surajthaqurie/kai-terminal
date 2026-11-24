// ESLint for Kai Terminal (CI-08). Run from the repository root: `npm run lint:eslint`
// (paths below are relative to the working directory because the config is passed with --config).
//
// Rule set: typescript-eslint `recommended` (syntax-level, no type information) plus the two
// React hooks rules. The type-checked set and ESLint's core `recommended` rules are not enabled
// yet: measured on this code they add about 1,800 and 100 findings, mostly stylistic; add them
// one rule at a time. `tsc --noEmit` (TypeScript 7, strict) remains the type check.
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

const files = ["src/**/*.{ts,tsx}", "e2e/**/*.ts"];

export default tseslint.config(
  { ignores: ["**/node_modules/**", "dist/**", "src-tauri/**", "kai-website/**"] },
  ...tseslint.configs.recommended.map((config) => ({ ...config, files })),
  {
    files,
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      // A `let` assigned once but read earlier by a closure (a handler set up before the value
      // exists) cannot become a const without reordering the code.
      "prefer-const": ["error", { ignoreReadBeforeAssign: true }],
      // `_name` marks an intentionally unused argument or binding.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // Tests may use `any` for loose fixtures and mocks.
    files: ["src/__tests__/**/*.{ts,tsx}", "e2e/**/*.ts"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  }
);
