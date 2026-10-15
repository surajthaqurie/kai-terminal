---
"kai-terminal": patch
---

Fix "Open in editor" on Windows (PATH lookup no longer picks the extensionless `code`/`cursor` bash shim; the real GUI exe is launched directly, and the `cmd` fallback quotes paths with spaces correctly). Make tab switching smoother: blocking backend commands (git, editor/shell detection, AI CLI probes) no longer run on the UI thread, hidden tabs keep their WebGL renderer briefly so quick tab flips don't rebuild it, and no-op PTY resizes are skipped.
