# Implementation Roadmap

Repository `kai-terminal` @ `50f4c8c`. **Nothing in this roadmap has been implemented**; it is a plan derived from the findings in the other audit documents. Finding IDs link to their cards: ARCH → [ARCHITECTURE-AUDIT](ARCHITECTURE-AUDIT.md), PERF → [PERFORMANCE-AUDIT](PERFORMANCE-AUDIT.md), RES → [RESOURCE-AND-SIZE-AUDIT](RESOURCE-AND-SIZE-AUDIT.md), FUNC → [FUNCTIONAL-GAP-AUDIT](FUNCTIONAL-GAP-AUDIT.md), REL/SEC → [RELIABILITY-AND-SECURITY](RELIABILITY-AND-SECURITY.md), CI → [TEST-AND-BENCHMARK-PLAN](TEST-AND-BENCHMARK-PLAN.md).

Ground rules (from the brief): preserve all features, shortcuts, themes, layouts and workflows; no architectural change without evidence; no new dependency without justification; no input/output silently dropped; every performance change must be preceded by a baseline from the test plan §3 and followed by the same measurement. Each task is intended to be a separate small PR with its own tests.

## Sequencing at a glance

```
Phase 0 (parallel, S)   Baselines + CI safety net:  CI-01, CI-03, T0-baseline
Phase 1 (correctness)   REL-01, PERF-03, SEC-01, SEC-03, SEC-06, FUNC-01, FUNC-02, SEC-02, SEC-04, REL-07
Phase 2 (performance)   PERF-04 → PERF-01 → PERF-02 → PERF-05, PERF-06, PERF-07, PERF-08, PERF-09, PERF-10/11
Phase 3 (resources/size) RES-01, RES-02, RES-03, RES-04, RES-05, RES-07/08/09, RES-10
Phase 4 (gaps/polish)   FUNC-04…13, REL-08/09/10/11/12, SEC-05/07…14, ARCH-02…06, CI-04…09
```
Phase 0 is not one of the four requested phases; it is listed because several Phase 1–2 tasks cannot be verified without it. It costs a day or two and should start first.

---

## Phase 0 — Safety net and baselines (prerequisite)

### T0.1 Baseline measurements
- **Finding IDs:** CI-06 (all PERF/RES numbers depend on it). **Dependencies:** none.
- **Expected outcome:** a committed `docs/audit/baseline-<date>.md` with the §1.3 table filled for cold/warm start, idle CPU, flood CPU, key-echo p95, memory idle/active, 1/2/4/8-pane scaling, installer size — measured by the procedures in TEST-AND-BENCHMARK-PLAN §3.
- **Files likely to change:** new docs only; optional `KAI_BENCH=1` instrumentation behind a flag in `main.tsx`, `TerminalView.tsx`, `pty.rs` (marks only).
- **Tests required:** none beyond the procedures; instrumentation must be a no-op when the flag is off.
- **Regression risks:** none if the flag is respected.
- **Acceptance criteria:** every row of the baseline table has a number or an explicit "cannot measure because …".

### T0.2 Compile, lint and test the GUI feature in CI
- **Finding IDs:** CI-01. **Dependencies:** none. **Complexity:** S–M.
- **Expected outcome:** PRs fail on GUI-code regressions; the misleading stub artifact is renamed or replaced.
- **Files:** `.github/workflows/ci.yml`.
- **Tests required:** a throwaway branch with a deliberate `cfg(feature="tauri")` error must fail CI.
- **Regression risks:** longer CI (full Tauri compile on Windows/macOS) and possible latent clippy failures in GUI code that must be fixed in the same PR.
- **Acceptance criteria:** CI runs `clippy --all-targets -D warnings` and `test --lib` with default features on windows-latest and macos-15; the deliberate-error branch is red.

### T0.3 Supply-chain gates and CI hygiene
- **Finding IDs:** CI-03, CI-02, CI-07, CI-09. **Dependencies:** none. **Complexity:** S–M.
- **Expected outcome:** `cargo audit`/`deny`, `npm audit` (prod fail, dev warn, website), dependabot for npm/cargo/actions, `--locked`, `rust-toolchain.toml`, `concurrency`/`timeout-minutes`/`permissions`, release workflow `needs` CI.
- **Files:** `.github/workflows/{ci,release}.yml`, `.github/dependabot.yml`, `rust-toolchain.toml`, `Dockerfile.test`.
- **Regression risks:** first run may surface existing advisories (the `undici`/`jsdom` high, website `next`/`postcss`); triage rather than silence.
- **Acceptance criteria:** a seeded vulnerable crate fails the security job; tagging a red commit does not publish.

---

## Phase 1 — Critical correctness, stability and security

### T1.1 Fix the sessions-lock scope in the waiter thread
- **Finding IDs:** REL-01 (also REL-02). **Dependencies:** none. **Complexity:** S.
- **Expected outcome:** the `sessions` mutex is never held while the master is dropped or while a native resize runs.
- **Files:** `src-tauri/src/pty.rs` (waiter block ~709-717; `resize_pty` ~806-832).
- **Tests required:** unit test with a blocking-`Drop` master (`list_sessions()` returns during the drop); resize with a sleeping master does not block `write` lookup.
- **Regression risks:** ordering of "remove from map" vs "emit exit" must be preserved (all output before exit; test 14).
- **Acceptance criteria:** new tests pass; existing 257 + 19 Rust tests pass; the Windows 10/11-23H2 VM loop (`cd ..; exit`) never wedges other tabs.

### T1.2 Stop the cwd event storm
- **Finding IDs:** PERF-03 (underlies ARCH-02). **Dependencies:** none. **Complexity:** S.
- **Expected outcome:** exactly one `pty-cwd` event per distinct report; no per-read global lock acquisition for already-seen reports.
- **Files:** `src-tauri/src/pty.rs` (reader loop 628-654, `extract_osc_cwds`).
- **Tests required:** unit test for the `[A][B][colour][colour]` sequence; live PowerShell probe expects 3 events, not 101; split-sequence-across-reads parser tests stay green.
- **Regression risks:** sequences split across reads must still be reassembled (keep the unterminated suffix).
- **Acceptance criteria:** probe shows 3 events; cwd footer still updates on `cd` in PowerShell, cmd and bash.

### T1.3 Windows cwd-planting fix
- **Finding IDs:** SEC-01 (amplified by RES-02). **Dependencies:** none. **Complexity:** S–M.
- **Expected outcome:** a planted `cmd.exe`/`git.exe`/`where.exe`/`powershell.exe`/`taskkill.exe` in the project folder is never executed by the CLI/MCP.
- **Files:** `src/core/spawnSafety.ts` and call sites listed in SEC-01; CLI/MCP entry points (`src/cli/index.ts`, `src/core/mcp.ts`) for the parent-env setting.
- **Tests required:** Windows test planting a harmless exe in a temp cwd and asserting the real tool runs; keep `dropCwdHits` tests.
- **Regression risks:** absolute `System32` paths must handle non-standard `SystemRoot`; `git` resolution must honour the user's PATH order.
- **Acceptance criteria:** the planting test in `src/__tests__/spawnSafety.test.ts` (executables planted in the working directory, flag unset in the parent) shows the real tools run.

### T1.4 Neutralise repo-configured git execution
- **Finding IDs:** SEC-03 (with SEC-10, SEC-12). **Dependencies:** none. **Complexity:** S.
- **Expected outcome:** background git probes pass `-c core.fsmonitor=false -c core.untrackedCache=false --no-optional-locks`; diffs `--no-ext-diff --no-textconv`; `GIT_LITERAL_PATHSPECS=1` for file operations; OSC 7 cwd accepted only for local host + existing directory.
- **Files:** `src-tauri/src/git.rs` (153-157, 232-298, 573-651), `src-tauri/src/pty.rs` (1362-1396).
- **Tests required:** `pwned.txt` reproduction no longer writes; literal `[id].tsx` test; concurrent `git commit` + probe loop never fails with `index.lock`.
- **Regression risks:** `status` may be slower on huge repos without fsmonitor/untracked cache (measure with the baseline).
- **Acceptance criteria:** reproduction negative; badge behaviour unchanged.

### T1.5 Stop recording typed lines
- **Finding IDs:** SEC-06 (ARCH-04). **Dependencies:** none. **Complexity:** S.
- **Expected outcome:** no per-Enter `localStorage` write of typed input; existing `kai_cmd_history_v1` purged on upgrade (cacheJanitor currently *preserves* it).
- **Files:** `src/components/TerminalView.tsx` (258-300, 916-980), `src/services/autocomplete.ts`, `src/services/cacheJanitor.ts`, `src/__tests__/autocomplete.test.ts`.
- **Tests required:** typing into a no-echo prompt writes nothing; janitor removes the old key once.
- **Regression risks:** none user-visible (nothing reads the data); keep `autocomplete.ts` exports only if a UI ships.
- **Acceptance criteria:** DevTools shows no `kai_cmd_history_v1` after typing commands.

### T1.6 Search shortcut and destructive-action confirmations
- **Finding IDs:** FUNC-01, FUNC-02 (FUNC-03). **Dependencies:** a real-`TerminalView` test harness (part of ARCH-03; do first within this task). **Complexity:** S (FUNC-01), M (FUNC-02).
- **Expected outcome:** `Ctrl+Shift+F` toggles once; closing a busy tab/multi-pane tab/last tab and loading a workspace over live shells asks first (reuse the `ShellPicker` confirm pattern); active-tab close picks a neighbour.
- **Files:** `src/components/TerminalView.tsx`, `src/hooks/useAppShortcuts.ts`, `src/hooks/useTabs.ts`, `src/hooks/useSessionPersistence.ts`, `src/components/WorkspaceModal.tsx`; backend busy query if added (`pty.rs`/`lib.rs`).
- **Tests required:** jsdom test (real `TerminalView`, fake xterm → registered handler → window listener); `closeTab`/`restoreWorkspace` confirmation tests.
- **Regression risks:** confirmation fatigue — only prompt when a foreground process is running or multiple panes would die; must not block `exit_now`/session-exit paths.
- **Acceptance criteria:** manual keypress opens search once; closing an idle single-pane tab remains instant.

### T1.7 Update integrity
- **Finding IDs:** SEC-02 (CI-03 release side). **Dependencies:** T0.3 (release signing artifacts). **Complexity:** M.
- **Expected outcome:** installers are verified (SHA256 + detached signature with an embedded public key) before launch; per-user `0700` download dir with `create_new`; anti-downgrade; size cap; per-hop redirect validation.
- **Files:** `src-tauri/src/updater.rs`, `src/services/updateService.ts`, `.github/workflows/release.yml`, `RELEASE_GUIDE.md`.
- **Tests required:** one-flipped-byte refusal; pre-created-symlink destination (Linux); version ≤ current refused.
- **Regression risks:** bricking updates if signing is mis-wired — ship a manual fallback and release a test update through a pre-release channel first.
- **Acceptance criteria:** tampered asset refused on all three OSes; legitimate update installs.

### T1.8 Per-window command ACL
- **Finding IDs:** SEC-04 (SEC-07 CSP narrowing, SEC-08). **Dependencies:** none. **Complexity:** S–M.
- **Expected outcome:** `music-pip` and `shared-chat` cannot call `create_pty`, installers, integration RPC or agent wiring; narrowed `connect-src`; `launcher` resolved in Rust.
- **Files:** `src-tauri/build.rs`, `src-tauri/capabilities/*.json`, `src-tauri/tauri.conf.json`, `src-tauri/src/lib.rs`, `src-tauri/src/ai_cli.rs`, `SECURITY.md`, `src/__tests__/tauriCsp.test.ts`.
- **Tests required:** invoke test per window label; CSP test on the narrow policy.
- **Regression risks:** missing a command the music/chat windows legitimately need (window drag, `music_relay_url`, `get_app_version`) — enumerate by grepping `invoke(` in those windows' code.
- **Acceptance criteria:** DevTools `invoke("create_pty")` from `music-pip` is rejected; music and chat windows still work.

### T1.9 Unix startup robustness
- **Finding IDs:** REL-07 (REL-10). **Dependencies:** none (needs a macOS/Linux host to verify). **Complexity:** S.
- **Expected outcome:** login-shell PATH lookup never blocks window creation or hangs on a backgrounding rc; no `set_var` from a background thread.
- **Files:** `src-tauri/src/login_path.rs`, `src-tauri/src/lib.rs`, `src-tauri/src/kai_cli.rs`.
- **Tests required:** rc with `sleep 30 &` returns within the bound; PATH still correct for GUI launches from Finder/launcher.
- **Regression risks:** the first terminal may spawn before PATH is merged — re-resolve lazily or wait with a short bound.
- **Acceptance criteria:** time-to-window with an nvm-heavy zshrc measured before/after.

---

## Phase 2 — Performance and responsiveness (needs T0.1 baselines first)

### T2.1 Per-window output routing
- **Finding IDs:** PERF-04. **Dependencies:** T1.1. **Complexity:** S–M.
- **Expected outcome:** `pty-output`/`pty-exit`/`pty-cwd` go only to the owning window (`emit_to(owner)` or a per-session `Channel`).
- **Files:** `src-tauri/src/pty.rs` (29-43, `set_owner` 866), `src-tauri/src/terminal_windows.rs`, `src/services/ptyService.ts`.
- **Tests required:** two-window event-targeting test; hand-off keeps ordering (owner switched under the gate before held output is released).
- **Regression risks:** hand-off races; events for a window that closed mid-flood must be discarded safely.
- **Acceptance criteria:** idle window receives zero output events while another floods.

### T2.2 Output flow control and the no-drop guarantee
- **Finding IDs:** PERF-01, PERF-02 (PERF-09 optional). **Dependencies:** T0.1, T1.1, T2.1. **Complexity:** M–L (the largest task in the plan).
- **Expected outcome:** bounded reader→emitter queue with a credit/ack protocol (`pty_ack`) driven by xterm `write` callbacks, so a fast producer blocks naturally; nothing is dropped while xterm accepts data; if a cap is ever hit, a visible `[kai] N KB skipped` marker is written and the swallowed exception is logged.
- **Files:** `src-tauri/src/pty.rs`, `src-tauri/src/lib.rs`, `src/services/ptyService.ts`, `src/services/terminalOutputBuffer.ts`, `src/components/TerminalView.tsx` (flush 1034-1107), possibly `tauri::ipc::Channel`.
- **Tests required:** stalled-emitter RSS plateau; `close_pty` and exit return promptly under a stalled consumer; `seq 1 5000000` byte-exact end to end; hidden-window soak; update `perf_step9_regression.test.ts:211` (cap semantics change).
- **Regression risks:** deadlock if exit/close depends on the reader draining (design them independent); interactive latency must not regress (compare §3.4 p95 before/after); hand-off gate interaction.
- **Acceptance criteria:** flood memory plateaus; Ctrl+C takes effect promptly mid-flood; byte-count test is exact; key-echo p95 within 10 % of baseline.

### T2.3 Keep input responsive: blocking work off the async workers
- **Finding IDs:** PERF-05. **Dependencies:** T0.1. **Complexity:** M.
- **Expected outcome:** git/clipboard/probe commands run via `spawn_blocking`; the clipboard PowerShell call has a timeout.
- **Files:** `src-tauri/src/lib.rs` (380-760), `src-tauri/src/git.rs`, `src-tauri/src/clipboard.rs`.
- **Tests required:** with N = cores hung `get_git_changes_cmd`, `write_to_pty` p99 stays flat.
- **Regression risks:** result ordering for callers that assume sequential execution.
- **Acceptance criteria:** the hang test shows no input stall.

### T2.4 Resize and settings repaint discipline
- **Finding IDs:** PERF-06, PERF-07, PERF-08. **Dependencies:** T0.1. **Complexity:** S each.
- **Expected outcome:** one trailing refit per resize burst with cancelled follow-ups; settings effect touches xterm only for changed terminal fields; WebGL re-attach retried after loss for visible panes and a lower hidden budget when several windows exist.
- **Files:** `src/hooks/useWindowRefit.ts`, `src/components/TerminalView.tsx` (616-636, 96-115, 1394-1408), `src/hooks/useTerminalConfig.ts`.
- **Tests required:** new `useWindowRefit` tests (call counts); `clearTextureAtlas` not called when toggling an unrelated setting; GPU re-attach test with a fake context loss.
- **Regression risks:** a missed refit leaves a mis-sized grid — keep the immediate pass on focus/visibility and the final pass on resize end.
- **Acceptance criteria:** `fit()` calls/s during a scripted drag drop by the measured factor; no visual regressions in the 1/2/4/8-pane scenario.

### T2.5 Startup path
- **Finding IDs:** PERF-10, PERF-11 (FUNC-05, REL-09 are correctness companions in Phase 4). **Dependencies:** T0.1. **Complexity:** S–M.
- **Expected outcome:** no cold PowerShell on every Windows launch (registry read, "already installed" cached); first render not gated on fonts; Search/Image/Serialize addons imported on first use.
- **Files:** `src-tauri/src/kai_cli.rs`, `src/main.tsx`, `src/components/TerminalView.tsx`.
- **Tests required:** `startupPaint.test.ts` updated; first-use addon load test.
- **Regression risks:** FOUT flash with fallback fonts; a first-keystroke race for image protocols.
- **Acceptance criteria:** cold-start proxy and eager bundle size improve (or the task is dropped if the baseline shows no gain).

---

## Phase 3 — Resource and application-size optimisation

### T3.1 Make background work conditional
- **Finding IDs:** RES-01, RES-02 (ARCH-01). **Dependencies:** T1.3 (RES-02 + SEC-01). **Complexity:** S–M.
- **Expected outcome:** call watcher runs only while music is playing (or uses a registry notification); MCP tool-list poll uses `mtimeMs`/`fs.watch` and cached root; LSP probes async/parallel/cached.
- **Files:** `src-tauri/src/call_watch.rs`, `src-tauri/src/lib.rs:831`, `src/components/MusicPlayer/MusicPanel.tsx` (`useCallPause`), `src/core/mcp.ts` (849, 909-923), `src/core/integrations/{tools,config}.ts`, `src/core/lspBridge.ts`.
- **Tests required:** zero `reg.exe` children with no music; zero `git` children from an idle `kai mcp`; `useCallPause` tests updated.
- **Regression risks:** missing a call-pause when music starts during an active call (start the watcher before/at play and check once immediately).
- **Acceptance criteria:** 10-minute process-creation counts of 0 for both; MCP p95 improves.

### T3.2 Bundled Node: bump and automate
- **Finding IDs:** RES-03 (ARCH-05). **Dependencies:** T0.3. **Complexity:** S.
- **Expected outcome:** current LTS bundled and auto-bumped via dependabot-style script; installer size unchanged ±.
- **Files:** `scripts/fetch-node.mjs`, `.github/workflows/release.yml`, a small renovate/script file.
- **Tests required:** `kai --version`/`kai mcp` smoke test against the bundled Node in the release workflow.
- **Regression risks:** Node major changes can break the bundled CLI (run the full Vitest suite on the target Node first); macOS JIT entitlements.
- **Acceptance criteria:** bundled `node --version` equals the pinned LTS; MCP smoke test green on all 6 targets.

### T3.3 Size budgets and hygiene
- **Finding IDs:** RES-04, RES-05, RES-08, RES-09 (CI-06). **Dependencies:** T0.1. **Complexity:** S.
- **Expected outcome:** CI bundle gate; `tokio` line removed; `gpt-tokenizer` to devDependencies; npm `files` limited to `dist/cli`; `engines` field; optional `rustls-tls-native-roots`; `thiserror` 2.
- **Files:** `.github/workflows/ci.yml`, `src-tauri/Cargo.toml`, `src-tauri/src/error.rs`, `package.json`.
- **Tests required:** release build + all Rust tests; `npm pack --dry-run` file list; update check behind a MITM proxy (if native roots).
- **Regression risks:** `thiserror` 2 derive differences (compile-time only); `native-roots` changes TLS trust.
- **Acceptance criteria:** `kai.exe` ≤ baseline; tarball ≈ −1.5 MB; bundle gate green at current sizes.

### T3.4 Privacy and network-at-launch cleanup
- **Finding IDs:** RES-07, RES-10. **Dependencies:** none. **Complexity:** S.
- **Expected outcome:** YouTube `preconnect` injected only when Music opens; update check documented beside the privacy claim; scrollback setting shows its memory cost.
- **Files:** `index.html`, `README.md`/`USER_MANUAL.md`, `src/components/SettingsModal.tsx`.
- **Tests required:** `startupPaint`/`securityHardening` tests adjusted; manual `netstat` at launch.
- **Regression risks:** slower first music start by one handshake.
- **Acceptance criteria:** no connection to YouTube at launch with the music panel closed.

*Explicitly not planned:* `opt-level=3` (RES-06), removing features, removing fonts/images, `isolate:false` in Vitest without evidence.

---

## Phase 4 — Missing functionality and polish

| Task | Finding IDs | Dependencies | Files likely to change | Tests required | Regression risks | Acceptance criteria |
|---|---|---|---|---|---|---|
| T4.1 Settings sync across windows | FUNC-06 | — | `useTerminalConfig.ts`, `settingsService.ts`, `terminal_windows.rs` (existing `emit_to_terminal_windows`) | two-window propagation test | write loops; last-writer semantics → make saves field-wise | theme change in A appears in B without restart |
| T4.2 Persistence completeness | FUNC-07, FUNC-08 | T4.1 | `tabFactory.ts`, `useSessionPersistence.ts`, `App.tsx:247`, `TabBar.tsx` | 12-tab restart; torn-off tab survives restart; no animated icons for unstarted tabs | restoring many tabs at once (spawn storm — keep lazy spawn) | restart restores all tabs, active tab/pane |
| T4.3 Git badge freshness | FUNC-04 | T1.2, T1.4 | `usePaneCwd.ts`, `cwdCommand.ts`, `useGitStatus.ts` | settler + `usePaneCwd` integration | extra git spawns (throttle ≤1/2–3 s) | `git checkout -b` updates footer ≤ ~1 s |
| T4.4 First-tab shell correctness | FUNC-05, REL-09 | — | `useTerminalConfig.ts`, `TerminalView.tsx` (1159-1196, 1317-1320) | delayed `get_available_shells`/`listen` tests | slower first prompt by the wait bound (≤500 ms) | first tab always uses configured shell/args; first prompt never lost |
| T4.5 Session-exit UX | FUNC-09, REL-03, FUNC-03 | T1.1 | `useSessionExit.ts`, `pty.rs` | per-pane crash counter; explicit close emits no crash exit | keeping dead panes changes layout/focus logic | non-zero exit keeps pane with status + Restart |
| T4.6 Keyboard/clipboard edge cases | FUNC-10, FUNC-13 | real-`TerminalView` harness (T1.6) | `TerminalView.tsx`, `App.tsx:411`, `TabBar.tsx` | AltGr layout, denied-clipboard, focus-return tests | shortcut regressions | AltGr+Shift+C/V types its character; no unhandled rejections |
| T4.7 Hand-off hardening | REL-08 | T2.1 | `tabHandoff.ts`, `useTabDetach.ts`, `TerminalView.tsx` | close-mid-move, failed-adopt Retry, double `handleExit` | complexity of async protocol | no orphan shell on Retry; moved session survives close race |
| T4.8 Unix/Windows process hardening | REL-04, REL-05, REL-06, REL-11, REL-12 | Linux CI | `pty.rs`, `shared_agent.rs`, `USER_MANUAL.md` | SIGHUP-ignoring shell; EINTR; invalid-UTF-8; documented detached-child policy | killing process groups too eagerly | HUP-trapping shell gone ≤1 s after close |
| T4.9 Agent/secret/doc hygiene | SEC-05, SEC-08, SEC-09, SEC-11, SEC-13, SEC-14 | T0.3 | `indexer.ts`, `mcpTools.ts`, `ai_cli.rs`, `kai_cli.rs`, `hostServer.ts`, `secretStore.ts`, `SECURITY.md`, `KNOWN_LIMITATIONS.md` | symlink-to-`.env` (Linux/macOS); file-mode test; REG_EXPAND_SZ PATH on a throw-away profile | PATH edits are user-visible — make opt-in | docs match code; secrets via stdin; modes preserved |
| T4.10 Structure and tests | ARCH-02…06, CI-04, CI-05, CI-08 | T1.6 | `TerminalView.tsx` extractions, `.eslintrc`, `tests/pty_integration_tests.rs`, new e2e dir | tests listed in TEST-AND-BENCHMARK-PLAN §5 | refactor regressions — extract hooks without behaviour change, one per PR | e2e smoke green on Windows+Linux; ESLint `react-hooks` clean |
| T4.11 Optional enhancements | FUNC-11, FUNC-12 | — | `TerminalView.tsx`, `shell.rs` | per feature | scope creep | each shipped only with a stated user problem (see FUNCTIONAL-GAP-AUDIT §3-D) |

## Done criteria for the whole programme
1. Re-run the §1.3 baseline table and publish before/after. 2. All new tests from TEST-AND-BENCHMARK-PLAN §5 exist and fail when their bug is reintroduced. 3. The findings register in EXECUTIVE-SUMMARY has every High finding closed or consciously accepted in writing. 4. `SECURITY.md`/`KNOWN_LIMITATIONS.md` match the code.
