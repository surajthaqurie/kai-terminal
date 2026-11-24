# CI-08 investigation: TypeScript 7 and typescript-eslint

Question: the project's only "lint" is `tsc --noEmit` because typescript-eslint was said not to
support TypeScript 7. Is that still true, and can real linting be added without disabling or
weakening anything? Investigated 2026-11-24.

## Findings

1. **TypeScript 7.0 has no classic compiler API.** The installed `typescript@7.0.2` package exports
   only `./lib/version.cjs` at its root (`ts.createSourceFile` is `undefined`); the new API lives
   under `typescript/unstable/sync|async`. typescript-eslint's parser is built on the classic API,
   so it cannot run on 7.0 at all. This is not a too-strict version range that could be bypassed.
2. **typescript-eslint 8.74.0 (latest)** declares `typescript >=4.8.4 <6.1.0`.
   `@typescript-eslint/typescript-estree` additionally declares an optional peer
   `@typescript/native` = `typescript@>=7.1.0-dev.20261009.1 || >=7.1.0-beta`: native
   TypeScript 7 support is being built upstream against the 7.1 API, not 7.0.
3. **A separate TypeScript 6.0 just for the linter works on this codebase today.** ESLint 10.15.0
   + typescript-eslint 8.74.0 + typescript 6.0.3 + eslint-plugin-react-hooks 7.1.1, installed in
   an isolated folder, linted all 462 files in `src/` with **0 parse errors** (the language
   accepted by 6.0 covers this code; 7.0 is the same language with a new compiler).

| Rule set (proof of concept) | Time | Errors | Warnings | Main rules |
|---|---|---|---|---|
| `recommended` + react-hooks | 14 s | 66 | 18 | 43 `no-unused-vars`, 19 `no-explicit-any`, 10 `exhaustive-deps`, 4 `prefer-const`; plus 8 stale `eslint-disable` comments |
| `recommendedTypeChecked` + react-hooks | 38 s | 1,887 | 18 | 842 `require-await`, 343 `no-unsafe-member-access`, 199 `no-unsafe-assignment`, 121 `no-unnecessary-type-assertion`, 94 `unbound-method` |

`tsc --noEmit` (strict, `noUnusedLocals`, `noUnusedParameters`) stays the type check either way;
the linter adds rules tsc does not have (hooks dependencies, `any`, unused catch bindings, …).

## Options

- **A. Recommended: an isolated lint toolchain now.** A small `tools/lint/` package with its own
  `package.json` and lockfile (ESLint, typescript-eslint, `typescript@~6.0`, react-hooks) so the
  linter's TypeScript can never be picked up by the build or `tsc`, which stay on 7.0. Start with
  `recommended` + react-hooks (66 findings to fix once, then a CI gate); add type-aware rules one
  by one later (`recommendedTypeChecked` all at once is 1,887 findings, mostly stylistic).
  Cost: one more `npm ci` in CI (about 140 packages), about 15 s per run.
- **B. Wait for typescript-eslint on the TypeScript 7.1 native API**, then lint with the
  project's own TypeScript. No interim linting.
- **C. A linter that does not use the TypeScript compiler** (oxlint, Biome): fast, one native
  dependency, but no type-aware rules ever, and a different rule set to learn.
- Not recommended: npm `overrides` to give typescript-eslint a nested TypeScript 6 inside the main
  dependency tree (fragile, easy to break the build's TypeScript resolution).

## Decision needed

Adding A means new dev dependencies and a rule set, so it was not installed here. With A chosen,
the work is: create `tools/lint/`, fix the 66 findings (or baseline them), add `npm run lint:eslint`
and a CI step; move to option B once typescript-eslint supports TypeScript 7.1.

## Reproduce

In an empty folder: `npm install eslint@10 typescript-eslint@8.74.0 typescript@~6.0
eslint-plugin-react-hooks`, a flat config applying `tseslint.configs.recommended` (or
`recommendedTypeChecked` with `parserOptions.project` pointing at the repository's
`tsconfig.json`) to `src/**/*.{ts,tsx}`, then run that folder's ESLint with `--config` from the
repository root.
