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
- **Behavior:** On Windows 11, hovering the maximize button opens the snap-layouts popup (Kai keeps an invisible window over the button so Windows treats it as a native one). Dragging to a screen edge also snaps. The empty strip of the tab row moves the window and a double-click maximizes it.
- **Verification:** Hover and a quick click were run on Windows 11 build 26300. A first click while the popup is already open was not reliable when driven by injected input, so please report it if that does not maximize. Dragging, edge resizing, snapping and the macOS traffic-light spacing have not been run on every OS yet.

### 5. macOS Microphone Attribution
- **Cause:** macOS CoreAudio permissions report whether audio input is active, but do not attribute microphone streams to specific application processes.
- **Behavior:** Music Time pauses when audio input is active and a known native conferencing application is running. Browser-based calls (e.g., Google Meet) cannot be reliably distinguished from other browser microphone usage on macOS.
- **Status:** Operating system privacy boundary.

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

### 4. Token Counts: Exact for OpenAI Models, Estimated Otherwise
- **Context:** Context budgeting and token metrics are character-class heuristic estimates (`isEstimate: true`) unless a tokenizer produced the number. Kai bundles the OpenAI BPE vocabularies (`o200k_base` for GPT-4o, GPT-4.1, GPT-5 and the o-series; `cl100k_base` for GPT-4 and GPT-3.5), loaded on first use, and `estimateModelTokensAsync(text, model)` returns exact counts for those models (`isExact: true`, `tokenizerName: bundled-...`). Message framing is not added.
- **Boundary:** Models without a public offline tokenizer (Claude, Gemini, Llama and others) keep the labeled estimate unless an adapter is registered with `registerModelTokenizer` or `registerCustomTokenizer`. Counts without a model name, including the context Kai assembles today, are estimates. The estimate is conservative: about 1.7 to 1.9 times the OpenAI token count on code and Markdown. The bundled vocabularies are an npm dependency; the desktop app ships only the CLI file, so there the OpenAI count falls back to the estimate.

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
- **Context:** `kai integration azure` connects a project to Azure DevOps. Its read tools are listed only for connected projects (see `MCP.md`). Four write tools (comment on a work item, change its state, open a pull request between existing branches, comment on a pull request) are off by default and appear only after you run `kai integration azure --allow-writes` for that folder. They never create branches, merge or delete.
- **Boundary:** Azure DevOps Services and Azure DevOps Server projects are detected from git remotes; a Server remote must be an HTTPS address of the form `https://<host>/<collection>/<project>/_git/<repo>`. A Server SSH remote does not give the web address: Kai suggests `https://<host>/<collection>` and asks before signing in; a port or virtual directory it cannot derive needs `--server-url`. The desktop Integrations tab sets up both Services and Server (the **Azure DevOps Server...** form takes the server URL with its collection, an optional project and an access token). Server support, including that form, has not been run against a real server (it uses REST API 7.0, including the 7.0 comments preview, chosen from Microsoft's API reference and tested against a fake server only). Azure DevOps Server signs in with an access token, never the Azure CLI, because on-premises servers do not accept the Microsoft Entra tokens `az` issues.
- **Boundary:** The merge branch and the branch naming pattern (the **More** link on the Azure DevOps card) are guidance for agents, returned by `kai_workflow_rules`. The pattern is a regular expression checked only for being valid when you save; Kai installs no git hooks and never checks a branch name, or validates or blocks a commit, push or merge, and it creates no branch or pull request itself: the agent runs `git` (and, if it chooses, `az repos pr create`). The branch list comes from the repository over the network, so with no connection the list is empty and a branch typed earlier is kept as saved. It is set from the desktop card or with `kai integration azure --merge-branch` / `--branch-pattern`, per folder, and needs a current `kai` on PATH.
- **Boundary:** Azure CLI sign-in needs `az` on the PATH of whatever starts it. A desktop app launched from a menu on macOS or Linux can have a shorter PATH than your shell; the Integrations tab then offers an access token instead. Access tokens go to the OS secret store.
- **Boundary:** The macOS Keychain and Linux Secret Service paths are unit-tested with a fake runner, not run on those systems; Windows DPAPI is tested for real. Requests are built to the public Azure DevOps REST API and tested against a fake server, not yet against a live organization.
- **Boundary:** Write tools were tested against a fake server only, not a live organization. A personal access token needs Work Items and Code: Read & write; browser and Azure CLI sign-ins use your own permissions. Turning writes on is refused inside an AI agent's session by a process-tree and environment check. That check is guidance, not a sandbox.
- **Boundary:** The desktop tab runs the installed `kai` CLI. An older `kai` earlier on PATH does not know the command, and the tab says so.

### 9. Microsoft Teams Chat (`kai teams`)
- **Context:** `kai integration teams` signs you in with your Microsoft account and `kai teams` shows your teams, channels and chats in the terminal, through Microsoft Graph with your own permissions. It is not an MCP integration: no agent tool exists for it.
- **Boundary:** Sign-in needs a Microsoft Entra app registration. The client ID constant (`KAI_TEAMS_CLIENT_ID`) is empty in the source, so a build without one (and without the Azure DevOps client ID it falls back to) stops with "Microsoft Teams sign-in is not set up in this build of Kai". `KAI_TEAMS_CLIENT_ID` in the environment overrides it for testing. See `docs/teams-sign-in.md`.
- **Boundary:** The Microsoft Teams card in the desktop Integrations tab signs in, tests, and signs out through the installed `kai` CLI, so it needs a current `kai` on PATH (an older one says it did not understand the request). It cannot show the sign-in address if the browser fails to open; run `kai integration teams` in a terminal, which prints it. The chat itself (`kai teams`) is only in a terminal tab. The card is covered by unit tests with a fake CLI, not run against a live Microsoft 365 tenant.
- **Boundary:** Reading what others wrote in a channel needs `ChannelMessage.Read.All`, which most organizations require an administrator to approve. Sign-in asks for it by default and, when Microsoft says an administrator has to approve it, repeats the sign-in once without it. That fallback is covered by tests with a fake browser; it has not been run against a tenant that blocks the permission, and if Microsoft shows its approval page without returning to Kai, the sign-in waits until it times out (5 minutes). Without the permission, chats and sending to a channel work and reading a channel shows a note; `kai integration teams --channels` signs in again after approval.
- **Boundary:** A file you send can be at most 250 MB, with at most 4 items per message and 250 MB in total (what you attach is held in memory while it is sent). Files over 4 MB are uploaded to your OneDrive in chunks and resumed if the connection drops. A picture is shown inline in the message only up to 4 MB; a larger one is sent as a link. Images are drawn inline in the terminal only where it supports it (iTerm2, WezTerm, mintty, Kai Terminal) and only as PNG, JPEG or GIF; elsewhere they open in your image viewer.
- **Boundary:** The agent guard refuses to run `kai teams` inside an AI agent's session by checking the process tree, environment markers and the interactive terminal. It is not a sandbox: a program running as the same operating-system user can in principle ask the OS to decrypt that user's stored secrets, as with any desktop app's sign-in.
- **Boundary:** Graph requests are covered by unit tests against fake responses; this has not been verified against a live Microsoft 365 tenant, and the macOS Keychain and Linux Secret Service paths are not run on those systems.
