---
"kai-terminal": patch
---

Windows agent detection and status-bar reliability: PATH lookup now honours `PATHEXT`, so npm/nvm shims resolve to the runnable `.cmd` entry (e.g. `C:\nvm4w\nodejs\opencode.cmd`) instead of the extensionless shell script, and `--version` probes run `.cmd`/`.bat` shims through `cmd /c` (`.ps1` through `powershell`) with no console-window flash. GUI-backed agents (Cursor, Windsurf, Cline) skip the `--version` probe entirely and report "Installed" instead of a probe-failed scare. The footer gains a git refresh button (branch badge and "No git repo" states) that re-probes the active pane and re-syncs Code Mode, and Code Mode now re-syncs on every submitted command line so `kai code .` / `kai stop code` typed inside Kai's own tab take effect immediately. Split panes render again via restored `.pane-split` flex layout with corrected divider axes, panels reuse cached provider/diagnostics results, and lazy-panel loading shows a spinner instead of a blank flash.
