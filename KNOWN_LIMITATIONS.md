# Known Limitations

This document lists the operating system boundaries, terminal constraints, and intentional design limits of Kai Terminal. Resolved defects, completed features and items that CI has since verified are removed to keep this document concise and actionable.

---

## Platform and Operating-System Limitations

### 1. Windows 7 / 8 / 8.1 Unsupported
- **Cause:** Windows ConPTY APIs were introduced in Windows 10 (build 17763 / version 1809). Older Windows releases lack native pseudo-console support.
- **Behavior:** Kai Terminal checks host build versions at startup (`MIN_SUPPORTED_WINDOWS_BUILD = 17763`). Unsupported versions return a typed `TerminalError::PtyCreationFailed` with actionable upgrade instructions.
- **Status:** Intentional design restriction.

### 2. Operating System Global Shortcuts
- **Cause:** Host operating systems reserve specific global hotkeys (e.g., `Cmd+Space` on macOS, `Win+L` or `Ctrl+Alt+Del` on Windows) at the kernel/window-manager level.
- **Behavior:** Webview applications cannot intercept or override host-reserved system shortcuts.
- **Workaround:** Configure alternative application shortcuts in Settings → Shortcuts. Kai's own defaults avoid `Ctrl+Alt` (AltGr on Windows) for this reason.

### 3. Windows File Symlink Privileges
- **Cause:** Windows requires Developer Mode or elevated (Administrator) privileges to create file symlinks (`EPERM`).
- **Behavior:** Directory symlinks use NTFS junctions (which require no special privileges). File symlinks gracefully skip in unit tests on Windows without Developer Mode, reporting explicit Vitest skip reasons (`symlinkOrSkip`).
- **Untraversable junctions:** Some Windows builds (seen on 11 build 26300) create a junction but then refuse to follow it in every process (`The path cannot be traversed because it contains an untrusted mount point`, surfaced by Node as `UNKNOWN`). The link tests detect this and skip with a reason rather than fail; project indexing and `kai_read_range` already treat such a path as unreadable (fail closed). The same tests run on the Linux and macOS CI runners.
- **Workaround:** Enable Developer Mode in Windows Settings if file symlink creation is required.

### 4. Custom Window Frame
- **Cause:** The native title bar is replaced by the tab row (`decorations: false` on Windows and Linux, an overlay title bar with the native traffic lights on macOS via `src-tauri/tauri.macos.conf.json`). Minimize, maximize and close are drawn by Kai on Windows and Linux.
- **Behavior:** Windows 11's snap-layouts popup on hovering the maximize button is not available; dragging to a screen edge still snaps. The empty strip of the tab row moves the window and a double-click maximizes it.
- **Verification:** The configuration and permissions are checked by tests, but dragging, edge resizing, snapping and the macOS traffic-light spacing have not been run on every OS yet. Please report a window that cannot be moved or resized.

### 5. macOS Microphone Attribution
- **Cause:** macOS CoreAudio permissions report whether audio input is active, but do not attribute microphone streams to specific application processes.
- **Behavior:** Music Time pauses when audio input is active and a known native conferencing application is running. Browser-based calls (e.g., Google Meet) cannot be reliably distinguished from other browser microphone usage on macOS.
- **Status:** Operating system privacy boundary.

### 6. Installed Font List on macOS
- **Cause:** macOS has no cheap way to list font families, so Kai builds the Settings font list from font file names.
- **Behavior:** A few names, such as SF Mono, may not match a real family and are left out of the list. **Custom Font Name / Stack...** accepts any installed font by name. Windows and Linux read real family names.
- **Status:** Not verified on a Mac; compiled for macOS only.

---

## Terminal and Process Limitations

### 1. Unix Canonical Line Mode Buffer (4,096 bytes)
- **Cause:** The Unix kernel tty line discipline enforces a standard 4,096-byte line buffer for cooked/canonical input.
- **Behavior:** Uncommitted input exceeding 4,096 bytes in canonical mode is capped by the OS kernel. Byte-exact streaming (`write_bytes_chunked`) delivers arbitrary chunk sizes, but interactive shells requiring long uncommitted lines must switch to raw mode.
- **Status:** Standard Unix kernel behavior.

### 2. Pane Count Limit and Minimum Split Floor
- **Cause:** Unbounded terminal splitting leads to severe UI rendering contention and illegible terminals.
- **Behavior:** Kai Terminal enforces a hard ceiling of 8 split panes per tab (`MAX_PANES_PER_TAB = 8`) and a minimum split extent floor of 1/8 pane area (`MIN_SPLIT_EXTENT`), refusing splits that would result in unusable terminals.
- **Status:** Intentional design restriction.

### 3. Detached Descendant Processes
- **Cause:** Child processes that detach into separate sessions or process groups (`setsid`, double-fork, or Windows detached processes) cannot be tracked or reaped through the parent process group.
- **Behavior:** Task termination kills the managed process group (`kill(-pid)` on Unix, `taskkill /T /F` on Windows). If escapee processes remain, index updates flag results as point-in-time freshness with `descendantsMaySurvive` warnings.
- **Status:** Process boundary limitation.

### 4. Terminal Write Payload Ceiling (1 MB)
- **Cause:** Massive unbuffered paste operations risk blocking the IPC bridge and freezing the frontend rendering loop.
- **Behavior:** Single write calls exceeding 1,048,576 bytes (`MAX_INPUT_WRITE_BYTES`) are rejected with an explicit notification rather than freezing the application or truncating input silently.

---

## Feature Boundaries

### 1. Local-Only Persistence
- **Context:** Workspaces, tab layouts, settings, and project indexes are stored strictly in local browser storage (`localStorage`) and `~/.kai/projects/`.
- **Boundary:** Kai Terminal includes no remote synchronization service, cloud storage, or telemetry export by design. Keystrokes, terminal history, scrollback logs, and environment variables are never stored to disk or transmitted over the network. The one opt-in exception is an external-service sign-in (`kai integration azure`), described in limitation 8 below.

### 2. Local AI CLI Diagnostics (No Network Verification)
- **Context:** The AI CLI diagnostics panel discovers installed AI tools via local executable detection (`PATH`), direct bounded `--version` probes, and local configuration file presence (`auth_status: config_present`).
- **Boundary:** Passive diagnostics never verify credentials over the network or make billable API calls. A successful `--version` probe or present config file does not guarantee valid credentials or network reachability.
- **Version Gating:** The version gate (`unsupported_version`) is implemented and tested, but `MIN_SUPPORTED_VERSIONS` is kept empty until vendors publish verified minimum version floors.

### 3. Local Language Server Requirement
- **Context:** Project intelligence (symbol extraction, import resolution, and context retrieval) operates via deterministic AST-free pattern parsing.
- **Boundary:** Deep cross-file type inference requires locally installed language server binaries (`typescript-language-server`, `rust-analyzer`, `pyright`, `gopls`). If missing or if the server exits prematurely, analysis falls back immediately to deterministic heuristic parsing without blocking.

### 4. Heuristic Token Estimates
- **Context:** Context budgeting and token metrics are calculated using deterministic character-class heuristics flagged `isEstimate: true`.
- **Boundary:** Kai does not bundle heavy model tokenizers by default. Exact counting is available when model-specific tokenizer adapters (`registerModelTokenizer`) or custom tokenizer functions are explicitly registered; otherwise, counts remain labeled estimates.

### 5. Fail-Closed Secret Filtering
- **Context:** Project indexing and MCP range reads enforce strict realpath confinement and pattern-based secret filtering (`sensitive_content`).
- **Boundary:** Files matching secret-detection patterns (including credential files and `src/core/indexer.ts` which defines the secret regexes) are rejected. Files excluded by this filter cannot be retrieved by MCP tools.

### 6. System Git Requirement
- **Context:** The status bar Git badge relies on machine-readable Git plumbing commands (`rev-parse`, `status --porcelain`) executed with strict 8-second timeouts.
- **Boundary:** If `git` is absent from `PATH`, the status badge displays an informative error without affecting terminal functionality.

### 7. Per-Terminal Code Mode Signal
- **Context:** Code Mode is scoped to one terminal: `kai <agent>` announces start and end on its own output as a private `OSC 1337` sequence (`src/core/codeModeSignal.ts`) and the pane that receives it shows the Code Mode pill. No shared state is read by the footer.
- **Verified:** The real CLI's signal arrives intact and in order through Windows 11 ConPTY (build 26300), through a Linux PTY, and through the real xterm.js parser (including a signal split across output chunks).
- **Boundary:** Older Windows builds whose ConPTY may drop escape sequences it does not recognise, and macOS, have not been tested; there the pill would simply stay on "Terminal". A `kai` CLI older than the app does not send the signal.

### 8. External Service Integrations (Azure DevOps)
- **Context:** `kai integration azure` connects a project to Azure DevOps; its tools are read-only and listed only for connected projects (see `MCP.md`).
- **Boundary:** Azure DevOps Services and Azure DevOps Server projects are detected from git remotes; a Server remote must be an HTTPS address of the form `https://<host>/<collection>/<project>/_git/<repo>`. SSH remotes of a Server install are not recognized (the HTTPS address behind them cannot be derived), so use `kai integration azure --server-url ... --project ...` there. The desktop Integrations tab is for Azure DevOps Services (`dev.azure.com`) only; Server setup is command-line only. Server support has not been run against a real server (it uses REST API 7.0, including the 7.0 comments preview, chosen from Microsoft's API reference and tested against a fake server only). Azure DevOps Server signs in with an access token, never the Azure CLI, because on-premises servers do not accept the Microsoft Entra tokens `az` issues. There are no write tools yet.
- **Boundary:** The merge branch and the branch naming pattern (the **More** link on the Azure DevOps card) are guidance for agents, returned by `kai_workflow_rules`. The pattern is a regular expression checked only for being valid when you save; Kai installs no git hooks and never checks a branch name, or validates or blocks a commit, push or merge, and it creates no branch or pull request itself: the agent runs `git` (and, if it chooses, `az repos pr create`). The branch list comes from the repository over the network, so with no connection the list is empty and a branch typed earlier is kept as saved. It is set from the desktop app only (there is no command), per folder, and needs a current `kai` on PATH.
- **Boundary:** Azure CLI sign-in needs `az` on the PATH of whatever starts it. A desktop app launched from a menu on macOS or Linux can have a shorter PATH than your shell; the Integrations tab then offers an access token instead. Access tokens go to the OS secret store; macOS `security` takes the token as an argument, briefly visible to the same user's `ps`.
- **Boundary:** The macOS Keychain and Linux Secret Service paths are unit-tested with a fake runner, not run on those systems; Windows DPAPI is tested for real. Requests are built to the public Azure DevOps REST API and tested against a fake server, not yet against a live organization.
- **Boundary:** The desktop tab runs the installed `kai` CLI. An older `kai` earlier on PATH does not know the command, and the tab says so.
