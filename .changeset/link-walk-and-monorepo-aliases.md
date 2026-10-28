---
"kai-terminal": patch
---

Two index fixes. A project that links one directory into another (for example `a/x` pointing at `b`) no longer reads as stale until the next rebuild: the freshness walk now visits directories in the same order as the indexer. TypeScript path aliases now come from the nearest `tsconfig.json` above each file, so packages in a monorepo resolve their own `paths`/`baseUrl` (including through a relative `extends`).
