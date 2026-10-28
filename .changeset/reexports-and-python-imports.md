---
"kai-terminal": patch
---

The import graph now sees through barrel files and resolves Python project imports. An import of a name that a barrel (`export { x } from`, `export * from`) or a Python package `__init__.py` re-exports also records the file that defines it, so `kai_get_dependencies`, the reverse import map and caller expansion no longer lose callers that go through a barrel. Python absolute imports of project modules (`from pkg import x`, `import pkg.mod`, including a `src/` layout) now resolve to the indexed file. Existing indexes refresh once.
