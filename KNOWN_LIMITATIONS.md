# Known Limitations & Technical Boundaries

This document lists known operating system constraints, platform boundaries, resolutions implemented, and explicit non-goals to provide clear technical transparency.

---

## 1. Operating System & Platform Boundaries & Resolutions

### 1.1 Windows ConPTY Semantics
- **Previous Behavior:** Attempting to spawn PTY on legacy Windows builds (pre-build 17763) resulted in cryptic native library crashes or silent failures without user guidance.
- **Implementation Change:** Added an explicit Windows version gate (`MIN_SUPPORTED_WINDOWS_BUILD = 17763`, Windows 10 v1809 / Windows 11) in `shell.rs` (`check_host_pty_support()`). Unsupported builds return a typed `TerminalError::PtyCreationFailed` with actionable upgrade instructions. Added WSL detection (`is_wsl_shell_path`) that appends service diagnostic hints (`wsl_failure_hint()`) for WSL startup errors. Reaped process cleanup on window/application close preventing orphan processes.
- **Tests Added:** `test_windows_build_gate_accepts_supported_builds`, `test_windows_build_gate_rejects_legacy_builds_with_actionable_error`, `test_wsl_shell_path_detection`.
- **Actual Test Result:** Passed (38/38 Rust unit tests, 13/13 real PTY integration tests).
- **Platform Coverage:** Windows 10 (build >=17763), Windows 11, WSL (Linux sub-environment).
- **Remaining Limitation:** Windows 7/8/8.1 are intentionally unsupported due to missing native ConPTY API support.

### 1.2 Unix PTY Input & Output Reliability
- **Previous Behavior:** Standard OS `n_tty` kernel line discipline enforces a 4,096-byte canonical line buffer for interactive canonical mode input; large pastes could freeze the app or get truncated.
- **Implementation Change:** Implemented byte-exact streaming (`write_bytes_chunked`) in 32 KiB chunks over native PTY master writer with `ErrorKind::Interrupted` retry and partial write looping. Enforced a 1 MB input payload cap per write call (`MAX_INPUT_WRITE_BYTES`) returning an explicit error prompt instead of freezing. Output is read in 4 KiB chunks, UTF-8 validated preserving trailing multi-byte sequences (`split_valid_utf8`), emitted via IPC, and rendered on frontend with `requestAnimationFrame` batching.
- **Tests Added:** `test_write_chunked_preserves_exact_bytes`, `test_oversized_input_rejected_not_truncated`, `test_large_multiline_unicode_paste_delivered`, `test_04_ansi_colors_and_unicode`, `test_08_high_volume_output_and_memory`.
- **Actual Test Result:** Passed.
- **Platform Coverage:** Linux, macOS, Windows (ConPTY).
- **Remaining Limitation:** OS kernel canonical line mode still applies to line-buffered input; interactive shells requiring long uncommitted lines must switch to raw mode (standard Unix behavior).

### 1.3 Split Panes & Input Isolation
- **Previous Behavior:** Tab-only layouts without configurable multi-pane input routing or pane resizing boundaries.
- **Implementation Change:** Implemented multi-pane tab architecture (up to 4 independent PTY sessions per tab, horizontal and vertical splits) in `paneLayout.ts` and `TerminalView.tsx`. Each pane maintains its own backend session UUID. Focus tracking routes keyboard input strictly to the active pane. Added drag-to-resize pane dividers and active-pane styling. Pane exit cleans up backend child processes.
- **Tests Added:** `src/__tests__/paneLayout.test.ts`, `test_10_multiple_simultaneous_sessions`, `test_11_child_process_cleanup`.
- **Actual Test Result:** Passed (37/37 Vitest tests, 13/13 integration tests).
- **Platform Coverage:** Cross-platform (Linux, macOS, Windows).
- **Remaining Limitation:** Pane count capped at 4 per tab to preserve terminal rendering performance and grid readability.

### 1.4 Configurable Keyboard Shortcuts
- **Previous Behavior:** Fixed hardcoded keyboard shortcuts with no conflict detection or customization UI.
- **Implementation Change:** Built centralized shortcut registry (`shortcuts.ts`) with configurable keybindings (`KeybindingsConfig`), conflict detection (`findConflicts`), modifier label translation (Cmd on macOS vs Ctrl on Windows/Linux), and settings UI (`SettingsModal.tsx`). Added shortcut actions for tab/pane navigation (`nextTab`, `prevTab`, `nextPane`), split pane, restart, search, command palette. Keystrokes are ignored when focused in text inputs (`isTypingTarget`).
- **Tests Added:** `src/__tests__/shortcuts.test.ts`.
- **Actual Test Result:** Passed.
- **Platform Coverage:** Cross-platform (macOS, Linux, Windows).
- **Remaining Limitation:** System-level OS global hotkeys reserved by host operating system (e.g. `Cmd+Space` on macOS) cannot be overridden by webview shortcuts.

### 1.5 Named Sessions & Project Workspaces
- **Previous Behavior:** Only transient single layout persistence (`terminal_tab_layout_v1`).
- **Implementation Change:** Built versioned local workspace schema (`kai_workspaces_v1` v2) with migration from legacy formats (`terminal_workspaces_v1`) in `workspaces.ts`. Added `WorkspaceModal.tsx` for creating, renaming, deleting, saving, and restoring named workspaces. Added working directory path validation (`validateWorkspaceDir`) and environment variable override support in project settings (`ProjectWorkspaceSettings`). Keystrokes, history, scrollback, and secrets are strictly excluded from persistence.
- **Tests Added:** `src/__tests__/workspaces.test.ts`, `test_validate_and_resolve_cwd_valid_and_invalid`.
- **Actual Test Result:** Passed.
- **Platform Coverage:** Cross-platform.
- **Remaining Limitation:** Saved workspaces persist layout metadata locally in `localStorage`; no remote sync or network transfer is included by design.

### 1.6 AI CLI Diagnostics & Provider Integration
- **Previous Behavior:** Diagnostic probe could mistake `--version` output for authentication success or hang on slow binaries.
- **Implementation Change:** Created provider-neutral diagnostic state enum (`AiCliDiagnosticState`: `not_found`, `version_detected`, `probe_failed`, `authentication_required`, `authentication_failed`, `ready`, `launch_failed`, `unsupported_version`, `unknown`). Probes `--version` with a strict 8-second execution timeout and auto-reap on timeout (`probe_version`). Checks local config file presence (`check_local_auth_presence`) without inspecting token contents or making network calls. Supports custom user-defined executable paths (`check_custom_ai_cli_path`).
- **Tests Added:** `test_detect_returns_all_catalogued_clis`, `test_version_success_does_not_imply_auth`, `test_probe_timeout_returns_quickly_for_missing_binary`, `test_missing_cli_reports_not_found_state`, `test_13_real_ai_cli_compatibility`.
- **Actual Test Result:** Passed.
- **Platform Coverage:** Cross-platform.
- **Remaining Limitation:** Auth check verifies local configuration file presence only; live API credentials are never tested over the network to prevent unintended costs.

### 1.7 Git Status Integration
- **Previous Behavior:** Uncached git commands on render created UI latency on large repositories.
- **Implementation Change:** Uses machine-readable git plumbing commands (`rev-parse`, `status --porcelain`) executed directly via process spawning (8 s timeout bound). Implemented bounded per-directory caching (`getGitInfoCached`, 5s TTL, max 50 entries) with manual cache invalidation (`invalidateGitCache`). Correctly reports detached HEAD commits (`detached@<sha>`), untracked files, modified files, and deleted files.
- **Tests Added:** `src/__tests__/gitCache.test.ts`, `test_branch_dirty_and_detached_head`, `test_invalid_dir_returns_error_not_panic`, `test_large_repo_status_is_bounded`.
- **Actual Test Result:** Passed.
- **Platform Coverage:** Cross-platform.
- **Remaining Limitation:** Git status badge relies on local system `git` binary; if `git` is not installed on system PATH, the badge is hidden without affecting terminal functionality.

### 1.8 Project Intelligence, Symbol Extraction & Context Retrieval
- **Previous Behavior:** No local project intelligence, symbol indexing, or MCP integration existed; external coding agents had to scan entire file trees or read raw repository dumps without task relevance.
- **Implementation Change:** Implemented local incremental project indexer (`src/core/indexer.ts`), deterministic task classifier (`src/core/classifier.ts`), versioned prompt templates (`src/core/templates.ts`), on-demand skills registry (`src/core/skills.ts`), stdio Model Context Protocol (MCP) server (`src/core/mcp.ts`), optional local Language Server Protocol (LSP) bridge (`src/core/lspBridge.ts`), and native Tauri status bar intelligence badge (`src-tauri/src/intelligence.rs`, `Toolbar.tsx`). Indexes are stored outside target repositories in `~/.kai/projects/<id>/`. Rendered prompts are hard-bounded to the token budget (`assembleContext` drops skills, lowest-scored sources, then rules, and truncates only as a last resort while preserving the verbatim task). Projects can be removed with `kai unregister <path|id>` (deletes only Kai-owned data; the repository is untouched; storage ids are strictly validated before deletion).
- **Tests Added:** `src/__tests__/intelligence.test.ts` (16 tests), `src/__tests__/lspBridge.test.ts` (6 tests), `src/__tests__/mcp_security.test.ts` (9 tests), `src/__tests__/audit_regression.test.ts`, `src/__tests__/unregister.test.ts` (CLI `unregister`/`code`/`status`/`query` coverage, `deleteProjectData` id validation, `ProjectLock` concurrency, budget-enforcement bounds), and Rust unit tests in `src-tauri/src/intelligence.rs`. CI runs the security regression suites and a built-bundle CLI smoke test (`--version`, `--help`) explicitly on Linux, Windows, and macOS (`Security Regression Tests` and `CLI Smoke Test` steps).
- **Actual Test Result:** Passed (90/90 Vitest tests across 14 files, `tsc --noEmit` clean, 40 unit + 13 integration Rust tests passing).
- **Platform Coverage:** Cross-platform (Linux, macOS, Windows).
- **Remaining Limitation:**
  1. Deep type-checker cross-file inferences fall back to deterministic pattern parsing when local language server binaries (`typescript-language-server`, `rust-analyzer`, `pyright`, `gopls`) are not locally installed on the host.
  2. Token counts use a fast deterministic `cl100k` heuristic estimator and are explicitly tagged `isEstimate: true` until an exact tokenizer binary is configured.
  3. All project intelligence is single-machine local; no cloud index sync or telemetry export is included by design.

---

## 2. Explicit Non-Goals & Security Guardrails

1. **No Remote Execution / SSH Daemon:** Kai connects strictly to local child shell processes on the host machine. It does not include built-in SSH connections, remote web sockets, or remote execution servers.
2. **Standard User Privileges:** Child shell processes run under standard OS user permissions. Kai does not bypass OS security or automatically elevate privileges; root (`sudo`) or Administrator elevation must be entered interactively by the user.
3. **No Credential Persistence or Telemetry:** Terminal input keystrokes, environment variables, scrollback logs, and credentials are never stored to disk, transmitted, or logged.
4. **Local Persistence Only:** Saved settings (`kai_user_settings`), active tab/pane layouts (`kai_workspaces_v1`), and recent projects (`kai_recent_projects`) are saved strictly in local browser storage (`localStorage`). Command history and terminal scrollback contents are never saved to disk.
5. **No Bundled AI Executables:** Third-party AI CLIs (Claude Code, Gemini CLI, Codex, etc.) are not bundled into Kai installers. If installed by the user, they can be executed inside regular terminal tabs.
6. **Non-Execution of Indexed Code:** Kai's project scanner never compiles, evaluates, or runs scripts discovered in indexed projects.

---

## 3. Implemented Capabilities Summary

- **Project Intelligence & MCP Server:** Terminal-first indexing (`kai code .`), status tracking (`kai status`), context querying (`kai query`), cost estimation (`kai cost`), evaluation benchmarks (`kai bench`), optional LSP status inspection (`kai lsp status`), and read-only MCP server (`kai mcp .`) over stdio JSON-RPC.
- **Status Bar Intelligence Widget:** Native desktop status bar badge displaying project readiness, file count, symbol count, and estimated token footprint directly in Kai Terminal.
- **Split Panes:** Up to 4 split panes per tab (horizontal and vertical splits) with independent backend PTY processes per pane.
- **Custom Shortcuts:** Centralized shortcut manager with customizable keybindings, navigation shortcuts, and conflict detection.
- **Workspaces & Editor Launching:** Save active tab/pane layouts, restore named workspaces, and launch projects in external code editors (VS Code, Cursor, VSCodium, Sublime, Zed).
- **Git Integration:** Displays active branch name and dirty status using system `git` with cached directory status and machine-readable output.
- **Local AI CLI Diagnostics:** Displays PATH detection, local version status, and non-modifying auth configuration status for AI coding tools without network calls or external data transfer.
