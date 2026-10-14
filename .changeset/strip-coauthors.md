---
"kai-terminal": patch
---

Add `kai strip-coauthors` (CLI) and the `kai_strip_coauthors` MCP tool: removes `Co-authored-by:` trailers that AI coding agents append to commit messages, on Linux, macOS, and Windows. Fail-closed by design — requires an attached branch and a clean tree, refuses merges in range and pushed history unless `--force` is set, validates every rewritten message before touching history, and supports `--dry-run` plus a `--match` filter for stripping only selected trailers. `HEAD` is amended in place; `--last N` replays the range preserving trees and author identity (messages only, file content never altered). Covered by pure-function and temp-repo integration tests including pushed-history, merge, dirty-tree, and empty-message refusals.
