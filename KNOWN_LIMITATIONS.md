# Known Limitations

This document lists the current outstanding verification tasks, operating system boundaries, terminal constraints, and intentional design limits of Kai Terminal. Resolved defects and completed features are removed to keep this document concise and actionable.

---

## Outstanding Verification

The following items are implemented and tested at the unit and mock level, but await confirmation in dedicated target environments or CI runners:

### 1. Flatpak Host-Shell Execution
- **Context:** When running inside a Flatpak container (`FLATPAK_ID` is set), shell sessions run on the host via `flatpak-spawn --host`. The login shell is discovered via `getent passwd` (cached with `/bin/sh` fallback), and working directory tracking relies on OSC 7 sequences emitted by the shell.
- **Implemented Mitigations:** Bash is primed with an OSC 7 prompt hook via `bash_cwd_prompt_command`, which chains to existing user `PROMPT_COMMAND` values and prevents duplicate injection. OSC 7 and OSC 9;9 parsers enforce 4,096-byte bounds and reject NUL bytes or control characters. PTY spawn failures return actionable diagnostic guidance (`flatpak_failure_hint`).
- **Required Verification:** A live run in a real Flatpak installation (confirming host shell job control and that `cd` updates the status bar directory badge in bash) or a green `linux-packages` CI job in `.github/workflows/ci.yml`.

### 2. WSL ConPTY CI Integration
- **Context:** Running Linux shells via `wsl.exe` under Windows ConPTY is fully supported and diagnosed in code (`is_wsl_shell_path`, `wsl_failure_hint`, `test_16b_wsl_output_decoding_and_diagnosis`).
- **Implemented Mitigations:** The dedicated `wsl` CI job in `.github/workflows/ci.yml` automates `Vampire/setup-wsl@v7` on `windows-latest` with root as the default user, strips the interactive first-run configuration prompt, and runs `test_16_wsl_shell_round_trip`.
- **Required Verification:** First green run of the hosted `wsl` CI job on GitHub Actions to verify WSL2 nested virtualization on the runner.

---

## Platform and Operating-System Limitations

### 1. Windows 7 / 8 / 8.1 Unsupported
- **Cause:** Windows ConPTY APIs were introduced in Windows 10 (build 17763 / version 1809). Older Windows releases lack native pseudo-console support.
- **Behavior:** Kai Terminal checks host build versions at startup (`MIN_SUPPORTED_WINDOWS_BUILD = 17763`). Unsupported versions return a typed `TerminalError::PtyCreationFailed` with actionable upgrade instructions.
- **Status:** Intentional design restriction.

### 2. Operating System Global Shortcuts
- **Cause:** Host operating systems reserve specific global hotkeys (e.g., `Cmd+Space` on macOS, `Win+L` or `Ctrl+Alt+Del` on Windows) at the kernel/window-manager level.
- **Behavior:** Webview applications cannot intercept or override host-reserved system shortcuts.
- **Workaround:** Configure alternative application shortcuts in Settings → Shortcuts.

### 3. Windows File Symlink Privileges
- **Cause:** Windows requires Developer Mode or elevated (Administrator) privileges to create file symlinks (`EPERM`).
- **Behavior:** Directory symlinks use NTFS junctions (which require no special privileges). File symlinks gracefully skip in unit tests on Windows without Developer Mode, reporting explicit Vitest skip reasons (`symlinkOrSkip`).
- **Workaround:** Enable Developer Mode in Windows Settings if file symlink creation is required.

### 4. macOS Microphone Attribution
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

### 4. Heuristic Token Estimates
- **Context:** Context budgeting and token metrics are calculated using deterministic character-class heuristics flagged `isEstimate: true`.
- **Boundary:** Kai does not bundle heavy model tokenizers by default. Exact counting is available when model-specific tokenizer adapters (`registerModelTokenizer`) or custom tokenizer functions are explicitly registered; otherwise, counts remain labeled estimates.

### 5. Fail-Closed Secret Filtering
- **Context:** Project indexing and MCP range reads enforce strict realpath confinement and pattern-based secret filtering (`sensitive_content`).
- **Boundary:** Files matching secret-detection patterns (including credential files and `src/core/indexer.ts` which defines the secret regexes) are rejected. Files excluded by this filter cannot be retrieved by MCP tools.

### 6. System Git Requirement
- **Context:** The status bar Git badge relies on machine-readable Git plumbing commands (`rev-parse`, `status --porcelain`) executed with strict 8-second timeouts.
- **Boundary:** If `git` is absent from `PATH`, the status badge displays an informative error without affecting terminal functionality.

---

### 7. Per-Terminal Code Mode Signal
- **Context:** Code Mode is scoped to one terminal: `kai <agent>` announces start and end on its own output as a private `OSC 1337` sequence (`src/core/codeModeSignal.ts`) and the pane that receives it shows the Code Mode pill. No shared state is read by the footer.
- **Verified:** The real CLI's signal arrives intact and in order through Windows 11 ConPTY (build 26300), through a Linux PTY, and through the real xterm.js parser (including a signal split across output chunks).
- **Boundary:** Older Windows builds whose ConPTY may drop escape sequences it does not recognise, and macOS, have not been tested; there the pill would simply stay on "Terminal". Shells that do not receive `KAI_TERMINAL=1` (for example WSL without `WSLENV`) cannot run `kai <agent>` at all, so they never reach this path. A `kai` CLI older than the app does not send the signal.

### 8. External Service Integrations (Azure DevOps)
- **Context:** `kai integration azure` connects a project to Azure DevOps; its tools are read-only and listed only for connected projects (see `MCP.md`).
- **Boundary:** Azure DevOps Services and Azure DevOps Server projects are detected from git remotes; a Server remote must be an HTTPS address of the form `https://<host>/<collection>/<project>/_git/<repo>`. SSH remotes of a Server install are not recognized (the HTTPS address behind them cannot be derived), so use `kai integration azure --server-url ... --project ...` there. Server support has not been run against a real server. There are no write tools yet. The tool list is read when an agent connects, so a running agent session must be restarted after `kai integration azure` or `kai azure remove`.
- **Boundary:** Azure CLI sign-in needs `az` on the PATH of whatever starts it. A desktop app launched from a menu on macOS or Linux can have a shorter PATH than your shell; the Integrations tab then offers an access token instead. Access tokens go to the OS secret store; macOS `security` takes the token as an argument, briefly visible to the same user's `ps`.
- **Boundary:** The macOS Keychain and Linux Secret Service paths are unit-tested with a fake runner, not run on those systems; Windows DPAPI is tested for real. Requests are built to the public Azure DevOps REST API and tested against a fake server, not yet against a live organization.
- **Boundary:** The desktop tab runs the installed `kai` CLI. An older `kai` earlier on PATH does not know the command, and the tab says so.

---

## Verification Requirements

To verify the outstanding items:

1. **WSL Integration Test:**
   - Execute the `wsl` job in `.github/workflows/ci.yml` on a GitHub Actions `windows-latest` runner.
   - Verify that `Vampire/setup-wsl@v7` provisions Ubuntu-22.04 and that `test_16_wsl_shell_round_trip` passes under ConPTY.

2. **Flatpak Packaging & Host Shell Execution:**
   - Execute the `linux-packages` job in `.github/workflows/ci.yml` on `ubuntu-22.04`.
   - Verify that `flatpak-builder` packages `com.kai.terminal.yml` with the GNOME 48 SDK and that `flatpak run --command=flatpak-spawn com.kai.terminal --host sh -c 'echo "FLATPAK_HOST_SHELL_OK: $(uname -s)"'` (run with `dbus-run-session` in headless environments) successfully invokes the host shell.
