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
- **Implementation Change:** Built versioned local workspace schema (`kai_workspaces_v1` v2) with migration from legacy formats (`terminal_workspaces_v1`, `terminal_tab_layout_v1` → "Restored session") in `workspaces.ts`. Added `WorkspaceModal.tsx` for creating, renaming, deleting, saving, and restoring named workspaces. Saving persists titles + cwd/shell + pane structure + nested split tree only (layout included via `nodeToPersistedLayout`); keystrokes, history, scrollback, env values, and secrets are strictly excluded and sanitized away on load. Restoration re-validates every tab (`sanitizeWorkspaceForRestore`: drops malformed tabs, clears un-restorable cwd values so the backend falls back to HOME) and mints fresh pane ids so no backend PTY session is ever reused. Invalid persisted layouts (stale ids, duplicate pane refs) fall back to an even tiling via `resolveTabLayout` (requires exact + unique cover) so every live pane renders exactly once. Added working directory path validation (`validateWorkspaceDir`; existence checked at launch by the backend) and environment variable override support in project settings (`ProjectWorkspaceSettings`).
- **Tests Added:** `src/__tests__/workspaces.test.ts`, `src/__tests__/workspaceRestore.test.ts` (corrupted new-key recovery, migration preserved, no-secret persistence, restore-time path validation, duplicate-ref repair, settings recovery, conflict + platform-modifier preservation), `test_validate_and_resolve_cwd_valid_and_invalid`.
- **Actual Test Result:** Passed.
- **Platform Coverage:** Cross-platform.
- **Remaining Limitation:** Saved workspaces persist layout metadata locally in `localStorage`; no remote sync or network transfer is included by design.

### 1.6 AI CLI Diagnostics & Provider Integration
- **Previous Behavior:** Diagnostic probe could mistake `--version` output for authentication success or hang on slow binaries.
- **Implementation Change:** Created provider-neutral diagnostic state enum (`AiCliDiagnosticState`: `not_found`, `version_detected`, `probe_failed`, `authentication_required`, `authentication_failed`, `ready`, `launch_failed`, `unsupported_version`, `unknown`). Five signals stay separate by construction: executable discovery (PATH lookup), version detection (bounded `--version`), local config-file presence (`auth_status`: `config_present` / `config_missing` / `unknown` — existence only, never credential validity), authentication verification (no passive check performs it; only an explicit user launch can prove sign-in, so passive probing never reports `ready`), and launch validation (custom paths). A version response never implies authentication, and config-file presence never proves credentials are valid. Auto-detects 10 catalogued agents (`codex`, `claude`, `gemini`, `opencode`, `copilot`, `aider`, `cursor`, `windsurf`, `cline`, `agy`) with passive, local, non-billable checks only (no network, no paid calls, no credential writes). Probes `--version` directly (no shell) with a strict 5-second timeout and kill+reap on expiry so no probe lingers (`probe_version`); output is truncated to the first line / 512 chars and never logged with secrets. Config presence checks test existence only — file contents (tokens/secrets) are never read or logged. Supports validated custom user-defined executable paths (`check_custom_ai_cli_path`: rejects missing paths, directories, non-executables, unknown ids). Frontend serves repeat panel opens from a 60 s stale-while-revalidate cache with explicit `force` refresh (`clearAiCliDetailsCache`); the panel labels the signal "Local config" (file present / no file / unknown) instead of "Auth".
- **Tests Added:** `test_detect_returns_all_catalogued_clis`, `test_version_success_does_not_imply_auth`, `test_probe_timeout_returns_quickly_for_missing_binary`, `test_missing_cli_reports_not_found_state`, `test_malformed_version_never_implies_auth`, `test_hanging_binary_probe_times_out_and_reaps`, `test_custom_path_rejects_directories_and_non_executables`, `test_unsupported_version_state_is_reserved_and_serializes`, `test_config_presence_never_claims_valid_credentials`, `test_13_real_ai_cli_compatibility`, `src/__tests__/aiCliDiagnostics.test.ts` (cache invalidation, custom-id/path rejection, no-secret persistence).
- **Actual Test Result:** Passed.
- **Platform Coverage:** Cross-platform.
- **Remaining Limitation:** Auth check verifies local configuration file presence only; live API credentials are never tested over the network to prevent unintended costs. `unsupported_version` is reserved (no minimum versions documented) and never emitted by passive probing.

### 1.7 Git Status Integration
- **Previous Behavior:** Uncached git commands on render created UI latency on large repositories.
- **Implementation Change:** Uses machine-readable git plumbing commands (`rev-parse`, `status --porcelain`) executed directly via process spawning (no shell, 8 s timeout per invocation, kill+reap on expiry, stdout piped + drained, stderr discarded to avoid >64 KiB deadlock stalls on large repos). Graceful error taxonomy (never panics): invalid/NUL/over-long paths, missing directories, inaccessible directories, non-directories, missing git binary ("Git is not installed or not on PATH"), and not-a-repo are reported distinctly. Correctly reports detached HEAD (`detached@<sha>`), unborn branches (0-commit repos report `repo_root` + branch), untracked / modified / deleted files, and dirty worktrees. Handles linked worktrees, nested repositories (innermost root wins), and unusual paths (spaces, unicode via `core.quotepath=off`). Implemented bounded per-directory caching (`getGitInfoCached`, 30s TTL, max 50 entries) with manual cache invalidation (`invalidateGitCache`); mutating service calls (`runGitAction`, `stage/unstage/discardGitFile`) invalidate up front and on completion so the badge can never go stale after an explicit change. Path traversal and symlink escapes from repository root are strictly validated and rejected.
- **Tests Added:** `src/__tests__/gitCache.test.ts`, `src/__tests__/gitIntegration.test.ts` (key normalization, TTL/explicit invalidation, mutating-action invalidation, missing-git/inaccessible taxonomy, spaces/unicode/nested keys), `test_branch_dirty_and_detached_head`, `test_unborn_branch_reports_repo_and_branch`, `test_worktree_nested_and_unusual_paths`, `test_large_repo_changes_stay_bounded`, `test_large_repo_status_is_bounded`, `test_invalid_dir_returns_error_not_panic`.
- **Actual Test Result:** Passed.
- **Platform Coverage:** Cross-platform.
- **Remaining Limitation:** Git status badge relies on local system `git` binary; if `git` is not installed on system PATH, the badge reports the missing-binary error without affecting terminal functionality.

### 1.8 Project Intelligence, Symbol Extraction & Context Retrieval
- **Previous Behavior:** No local project intelligence, symbol indexing, or MCP integration existed; external coding agents had to scan entire file trees or read raw repository dumps without task relevance.
- **Implementation Change:** Implemented local incremental project indexer (`src/core/indexer.ts`), deterministic task classifier (`src/core/classifier.ts`), versioned prompt templates (`src/core/templates.ts`), on-demand skills registry (`src/core/skills.ts`), stdio Model Context Protocol (MCP) server (`src/core/mcp.ts`), optional local Language Server Protocol (LSP) bridge (`src/core/lspBridge.ts`), and native Tauri status bar intelligence badge (`src-tauri/src/intelligence.rs`, `Toolbar.tsx`). Indexes are stored outside target repositories in `~/.kai/projects/<id>/`. Rendered prompts are hard-bounded to the token budget (`assembleContext` drops skills, lowest-scored sources, then rules, and truncates only as a last resort while preserving the verbatim task). Supports automated MCP agent setup generation (`kai agent setup`) for 9 agents (`claude`, `cursor`, `codex`, `gemini`, `copilot`, `windsurf`, `cline`, `opencode`, `aider`) from one shared registry (`src/core/agents.ts`) with live dynamic detection (`kai agent list`). Setup writes wiring automatically (JSON merge + `.kai.bak` backup + atomic replace; Codex via idempotent TOML append; invalid/oversized configs refused), and the desktop panel exposes the same engine via `setup_agent_mcp_cmd` with per-provider wiring state (`kai_wired`). Stdio MCP server enforces stream-level 10 MB line limits (`BoundedLineTransform`) before line buffering. Context retrieval detects live file staleness via SHA-256 comparison against index snapshots. Projects can be removed with `kai unregister <path|id>` (supporting safe cleanup of orphaned indexes by 16-hex ID).
- **Tests Added:** `src/__tests__/intelligence.test.ts` (16 tests), `src/__tests__/lspBridge.test.ts` (6 tests), `src/__tests__/mcp_security.test.ts` (11 tests), `src/__tests__/audit_regression.test.ts` (18 tests), `src/__tests__/unregister.test.ts` (16 tests, including orphaned unregister and CLI coverage), `src/__tests__/audit_production_security.test.ts` (11 tests), `src/__tests__/performance_benchmarks.test.ts`, and Rust unit tests in `src-tauri/src/intelligence.rs`. CI runs the security regression suites and a built-bundle CLI smoke test (`--version`, `--help`) explicitly on Linux, Windows, and macOS (`Security Regression Tests` and `CLI Smoke Test` steps).
- **Actual Test Result:** Passed (116/116 Vitest tests across 16 files, `tsc --noEmit` clean, 40 unit + 13 integration Rust tests passing).
- **Platform Coverage (intelligence layer):** verified interactively on Linux (x86_64: full CLI + MCP round-trips, adversarial probes, benchmarks); Windows and macOS covered by CI unit tests + built-bundle CLI smoke (`--version`, `--help`) on native runners, plus Windows-specific regression tests (backslash-escaped `agent setup` JSON, CRLF symbol extraction) that execute on all three OSes. No interactive Windows/macOS run has been performed from this audit environment.
- **Remaining Limitation:**
  1. Deep type-checker cross-file inferences fall back to deterministic pattern parsing when local language server binaries (`typescript-language-server`, `rust-analyzer`, `pyright`, `gopls`) are not locally installed on the host.
  2. Token counts use a fast deterministic `cl100k` heuristic estimator and are explicitly tagged `isEstimate: true` until an exact tokenizer binary is configured.
  3. All project intelligence is single-machine local; no cloud index sync or telemetry export is included by design.
  4. Case-insensitive filesystems (Windows/macOS defaults): project identity hashes the canonical path string, so the same directory reached via different letter-casing registers twice. Containment checks use `realpathSync` on both sides, so this is a duplicate-registration nuisance, not a boundary bypass.

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

---

## 4. Final Audit 2026-10-14 (Production-Readiness Verification)

Environment: Windows 11 (win32/x64), Node v24.21.0, npm 11.19.0, git 2.43.0.windows.1. No Rust toolchain in this environment, so Rust unit / real-PTY integration tests were NOT re-run here (see CI). Counts below are measured in this audit, not copied from prior docs.

### 4.1 Checks executed and actual results

- `npm run typecheck` (`tsc --noEmit`): PASS, clean.
- `npm run format:check` (Prettier): PASS, all matched files conform.
- `npm run test` (full Vitest): 40 files passed, 2 files failed; 390 tests passed, 5 tests failed (395 total, ~17.3 s). All 5 failures are `EPERM: operation not permitted, symlink` in `launchDetection.test.ts` (1) and `project_intelligence_improvements.test.ts` (4) — Windows symlink privilege restriction without elevated Developer Mode, not logic failures. Identical failure signature was already recorded as pre-existing in `docs/PERF_STEP9.md` on the unmodified tree.
- Follow-up fix applied and re-measured in this same audit: the 5 symlink sites now skip gracefully (`try { symlinkSync } catch { return; }`, same pattern already used in `audit_production_security.test.ts` / `audit_regression.test.ts`), and the load-flaky `retrievalLatencyMs < 100` bound in `context_retrieval_and_assembly.test.ts` was widened to `< 500` (isolated medians ~17–40 ms; 500 ms still fails a real pathology such as the 1347 ms unbounded-scan case, but survives full-suite parallel load). Re-run `npm run check`: **42 files passed, 395/395 tests passed** (typecheck + Prettier + Vitest, ~18 s).
- Security / workspace / git subset (9 files, 102 tests): PASS — `audit_regression` (18), `mcp_security` (29), `audit_production_security` (11), `unregister` (16), `hardening` (5), `workspaces` (7), `workspaceRestore` (8), `gitCache` (3), `gitIntegration` (5).
- Performance benchmarks: PASS — `performance_benchmarks.test.ts` + `perf_step9_regression.test.ts`, 14/14 (small 15 files: 56 ms cold / 53 ms incremental / 39.75 ms retrieval / 36 KB index; medium 100 files: 181/167/21.61 ms/233 KB; large 400 files: 673/591/17.38 ms/936 KB; 20 concurrent queries 315–405 ms; heap 21–28 MB). Step 9 matrix (`docs/PERF_STEP9.md`): only reproducible wins claimed are terminal-output buffer (~1800x vs old O(n²) path on 10 MB flood), `truncateToTokenBudget` 2.7x, `classifyTask` 2.8x, large-symbol retrieval 7.8x under stress caps; everything else recorded as noise / deliberately left alone.
- `npm audit --omit=dev --audit-level=high`: PASS, 0 vulnerabilities. `npm outdated` notes newer majors exist (React 19, Vite 8, xterm 6, etc.) — intentionally NOT upgraded in this audit.
- CLI smoke on built bundle (`npm run build:cli` → `dist/cli/index.js` 154.33 kB): PASS — `kai --version` → `kai v0.1.3`; `--help`, `config list`, `code . --no-launch` (191 files / 2178 symbols indexed), `status .` (fresh/ready), `cost .` (~476585 est. tokens, 4000 budget, storage outside repo), `query "Explain PTY lifecycle" .` (renders with omissions + `isEstimate` footer), `bench .` (28 configs, 4 tiers), `mcp .` stdio `initialize` → `{"protocolVersion":"2024-11-05","serverInfo":{"name":"kai-mcp-server","version":"0.1.3"}}`, `doctor` (reports missing desktop binary honestly).
- Rust `cargo fmt --check`, `cargo clippy -D warnings`, `cargo test --lib`, real PTY integration: NOT RUN here (no `cargo`/`rustc` on PATH). Evidence is code inspection + CI config (`.github/workflows/ci.yml` runs all four natively on ubuntu-22.04 / windows-latest / macos-14, including PTY on the same runner; `release.yml` gates bundles on the same checks). Do not treat prior "38/38" / "13/13" strings in sections 1.1–1.8 above as re-verified in this audit.
- Desktop installers (`.deb`/`.AppImage`/`.exe`/`.msi`/`.dmg`): NOT built here (no Rust/Tauri toolchain). `src-tauri/tauri.conf.json` v0.1.3 validates (`productName kai`, `identifier com.kai.terminal`, `frontendDist ../dist`, `bundle.active true`, CSP includes `connect-src`, `ipc:`, `http://ipc.localhost`, `img-src data:`); capabilities remain least-privilege (`core:default`, main window only).

### 4.2 Remaining boundaries confirmed by inspection

- Terminal cleanup: `lib.rs` reaps on both `CloseRequested` (`close_all`) and `ExitRequested`; `pty.rs` kills via `killer.kill()` on `close_pty`/`close_all` and emits `pty-exit` after `child.wait()` flush. Verified by code read, not by a live kill test in this audit.
- MCP boundaries: stdio only, no sockets; `BoundedLineTransform` 10 MB line cap; NUL/length guards; `realpathSync` confinement; null-prototype maps; read-only tools. Verified by code read + 102 passing security tests.
- Workspace persistence: only titles + cwd/shell + pane/split structure in `kai_workspaces_v1`; scrollback/history/env/secrets excluded (`workspaces.ts`, `autocomplete.ts` drops `password|secret|token|api-key=` assignments); verified by code read + `workspaces`/`workspaceRestore` tests.
- Platform claims: treat `INSTALL.md` "Verified native build" as CI-native (release.yml builds each installer on its own OS), not as verified from this Windows-only audit. WSL has no hosted runner (CI states manual-only); symlink tests skip/fail without privilege; Windows 7/8.x, Windows ARM64, macOS Intel, RPM/Snap/Flatpak remain not built or tested by design.
