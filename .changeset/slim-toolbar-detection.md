---
"kai-terminal": patch
---

Slim toolbar and footer: removed the toolbar New Session button (use TabBar + / Ctrl+Shift+T), the Recent dropdown, the top git badges, the top Code Mode pill, and the Clear button — git branch, project directory, and Code Mode (now an explicit exit toggle button) live only in the bottom status bar. AI providers panel: dropped per-provider Auto-wire buttons (kai wiring is auto-detected read-only), redesigned provider cards with proper spacing, added a Re-detect button. Detection fix: desktop probing now also covers well-known install locations (`~/.local/bin`, `~/.opencode/bin`, `~/.cargo/bin`, nvm node bins, `/usr/local/bin`, …) so GUI launches with a minimal PATH still find user-installed CLIs, added the `agy` CLI to the catalog plus extra binary aliases (`claude-code`, `cursor-agent`, `opencode2`, `github-copilot`).
