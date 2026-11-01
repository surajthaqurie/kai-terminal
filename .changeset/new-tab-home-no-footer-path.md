---
"kai-terminal": patch
---

New tabs open in your home folder, and the footer no longer shows a path.

- A new tab used to borrow the previous tab's folder for the moment before its shell reported one, so the git badge, "open in editor" and the AI panel pointed at the wrong project. Each tab now only knows its own folder; the shared "toolbar" folder it fell back to is gone.
- Splits still open in the folder of the pane they were split from.
- Removed the working-directory path from the footer (the git branch, mode and shell picker stay).
- `kai mcp <agent>` now repairs an MCP entry whose script no longer exists (for example after the app was reinstalled elsewhere) instead of reporting it as already configured, and writes plain paths without the Windows `\?\` prefix.
