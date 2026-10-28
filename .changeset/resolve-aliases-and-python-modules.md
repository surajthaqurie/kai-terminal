---
"kai-terminal": patch
---

Better import graph and task detection. TypeScript/JavaScript imports through the root `tsconfig.json` `paths` / `baseUrl` aliases (for example `@/utils`) now resolve to the indexed file, and Python `from . import a, b` links to each of `a.py` and `b.py` instead of only `__init__.py`, so `kai_get_dependencies` and neighbour expansion see those edges. Existing indexes refresh once to pick this up. Task classification now recognises "debug why ...", "review ...", "audit ...", "why does ... crash" and "replace X with Y".
