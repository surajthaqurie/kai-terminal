// ESLint for Kai Terminal (CI-08). Run from the repository root: `npm run lint:eslint`
// (paths below are relative to the working directory because the config is passed with --config).
//
// Rule set: ESLint core `recommended`, typescript-eslint `recommended` (syntax-level, no type
// information) and the two React hooks rules. Deliberate exceptions are made where they occur,
// each with a reason (e.g. `no-control-regex` where terminal escape sequences are matched). The
// type-checked set is not enabled: about 1,800 findings, mostly stylistic; add rules one at a
// time. `tsc --noEmit` (TypeScript 7, strict) remains the type check.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

const files = ["src/**/*.{ts,tsx}", "e2e/**/*.ts"];

export default tseslint.config(
  { ignores: ["**/node_modules/**", "dist/**", "src-tauri/**", "kai-website/**"] },
  { ...js.configs.recommended, files },
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
    // Type-aware rules that catch real bugs (not the stylistic type-checked set): a promise whose
    // rejection nobody handles, a promise passed where a plain callback is expected, `await` on
    // something that is not a promise. They need the TypeScript program, built from tsconfig.json.
    files,
    languageOptions: {
      parserOptions: { project: "./tsconfig.json", tsconfigRootDir: process.cwd() },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/await-thenable": "error",
    },
  },
  {
    // Tests may use `any` for loose fixtures and mocks.
    files: ["src/__tests__/**/*.{ts,tsx}", "e2e/**/*.ts"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  }
);
