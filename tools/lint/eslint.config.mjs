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
      // A value that would print as "[object Object]" (in String() or a template), and a union
      // member swallowed by a wider one (`"a" | string`) so its names go unchecked.
      "@typescript-eslint/no-base-to-string": "error",
      "@typescript-eslint/restrict-template-expressions": "error",
      "@typescript-eslint/no-redundant-type-constituents": "error",
      // A switch over a union with neither every case nor a `default`: a new member would fall
      // through silently. An explicit `default` counts as handling the rest.
      "@typescript-eslint/switch-exhaustiveness-check": [
        "error",
        { considerDefaultExhaustiveForUnions: true },
      ],
      // A method passed on without its object loses `this`. Closure-based APIs are typed as
      // function properties (`close: () => void`), which says they are safe to pass alone.
      "@typescript-eslint/unbound-method": "error",
      // Deprecated APIs (React 19 types, vitest), with a reasoned exception where one is needed.
      "@typescript-eslint/no-deprecated": "error",
      // Spreading a class (copies no static methods), a Promise, a Map, or a string (splits
      // by code point, not by visible character).
      "@typescript-eslint/no-misused-spread": "error",
      "@typescript-eslint/use-unknown-in-catch-callback-variable": "error",
      // `any` must not flow on unchecked (it mostly came from JSON.parse: type it `unknown` and
      // narrow). Off in tests, below.
      "@typescript-eslint/no-unsafe-argument": "error",
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-return": "error",
      "@typescript-eslint/no-unsafe-class-instance-assignment": "error",
      // Code that does nothing or says the same thing twice (all auto-fixable).
      "@typescript-eslint/no-unnecessary-type-assertion": "error",
      "@typescript-eslint/no-unnecessary-template-expression": "error",
      "@typescript-eslint/no-unnecessary-type-arguments": "error",
      "@typescript-eslint/prefer-find": "error",
      "@typescript-eslint/prefer-includes": "error",
      "@typescript-eslint/prefer-string-starts-ends-with": "error",
      "@typescript-eslint/prefer-regexp-exec": "error",
      // Not enabled, with the findings read (the CI-08 lint work stops here; see
      // docs/audit/CI-08-LINT-INVESTIGATION.md):
      // - only-throw-error, prefer-promise-reject-errors: Tauri's invoke rejects with strings;
      //   every hit rethrew a caught value.
      // - return-await: all 15 hits were style; no promise was returned unawaited inside a try.
      // - no-unnecessary-condition (253), no-unnecessary-type-conversion (19),
      //   no-unnecessary-boolean-literal-compare (10): the code checks and coerces values whose
      //   static type is stronger than what arrives at runtime (settings from storage, RPC and
      //   backend replies, `isTTY` that is really `true | undefined`). Their fixes remove those
      //   checks (`x?.ok === false` becomes `!x?.ok`, true when x is missing): behavior changes.
      // - require-await (17): every hit implements an async interface; dropping `async` turns a
      //   synchronous throw into an exception instead of a rejected promise.
      // - no-unnecessary-type-parameters (11): the usual `get<T>()` / `invoke<T>()` where the
      //   caller names the result type.
      // - prefer-nullish-coalescing (133): no auto-fix; each `||` -> `??` changes what "", 0 and
      //   false do (e.g. `stored || fallback` for an empty localStorage value), so all 133 would
      //   need reading one by one. Not done; a candidate if a `||` default ever causes a bug.
      // - no-meaningless-void-operator: `void name;` is how this code marks a binding as
      //   deliberately unused; the rule's fix turns it into a bare `name;`.
      // - prefer-optional-chain (55): style; most hits have no safe auto-fix (`a && a.b` and
      //   `a?.b` differ when `a` is "" or 0), so each would need reading for no bug.
      // - Style only: array-type, consistent-type-definitions, no-confusing-void-expression,
      //   no-empty-function, no-non-null-assertion, no-extraneous-class, no-invalid-void-type,
      //   dot-notation, no-inferrable-types, consistent-generic-constructors, no-dynamic-delete,
      //   prefer-for-of, non-nullable-type-assertion-style, and the strict options of
      //   restrict-template-expressions / restrict-plus-operands.
    },
  },
  {
    // Tests may use `any` for loose fixtures and mocks. Their fetch fakes stringify inputs that
    // are always URL strings; a wrong one fails the test, so base-to-string adds nothing there.
    files: ["src/__tests__/**/*.{ts,tsx}", "e2e/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-base-to-string": "off",
      // `expect(obj.method).toHaveBeenCalled()` references a mock method without calling it.
      "@typescript-eslint/unbound-method": "off",
      // Loose fixtures and mocks are typed `any` on purpose.
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-unsafe-class-instance-assignment": "off",
    },
  }
);
