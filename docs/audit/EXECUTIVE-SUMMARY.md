# Executive Summary — Kai Terminal Engineering Audit

Repository `kai-terminal` v0.2.3 @ `50f4c8c` (main), audited 2026-11-23 on Windows 11 (build 26300, 16 cores, cargo 1.99, node 24).
Scope: architecture, performance, resources, size, functionality, concurrency, reliability, security, tests/CI. **Audit only — no source file was changed and nothing has been fixed.** The only repository changes were these documents.

| Document | Contents |
|---|---|
| [ARCHITECTURE-AUDIT](ARCHITECTURE-AUDIT.md) | system map, data flow, structural findings (ARCH-xx) |
| [PERFORMANCE-AUDIT](PERFORMANCE-AUDIT.md) | startup, responsiveness, rendering, throughput, scaling (PERF-xx) |
| [RESOURCE-AND-SIZE-AUDIT](RESOURCE-AND-SIZE-AUDIT.md) | measured sizes, background work, dependencies, optimisation trade-offs (RES-xx) |
| [FUNCTIONAL-GAP-AUDIT](FUNCTIONAL-GAP-AUDIT.md) | feature-by-feature verification, gaps A–D (FUNC-xx) |
| [RELIABILITY-AND-SECURITY](RELIABILITY-AND-SECURITY.md) | concurrency, lifecycle, security (REL-xx, SEC-xx) |
| [TEST-AND-BENCHMARK-PLAN](TEST-AND-BENCHMARK-PLAN.md) | baseline status, CI findings (CI-xx), benchmark procedures, tests to add |
| [IMPLEMENTATION-ROADMAP](IMPLEMENTATION-ROADMAP.md) | four phases (plus a short Phase 0) with acceptance criteria |

## 0. How to read the confidence labels (and what was NOT done)

- **Confirmed** = code path traced, and reproduced where the card says so. **Likely** = trace is solid, a runtime fact was not observed. **Needs measurement** = plausible, quantity unknown. A **†** on an ID means the lead auditor re-read the cited code personally; other findings rest on the analysts' traces (four parallel read-only analyses) and, where stated, their reproductions.
- **The GUI was never launched.** Therefore there is **no measured cold/warm startup, idle CPU, active CPU, input latency, render latency, resident memory, memory-over-time or multi-pane scaling number in this audit.** Those rows are marked "not measured" and §3 of the test plan gives the exact procedure and the instrumentation needed. Everything performance-related that is not in the "measured" list below is code-traced, not benchmarked.
- **Measured:** frontend bundle sizes; CLI bundle; `node.exe` size; Rust release binary (`opt-level="s"` vs `3` vs no `tokio`); `reg.exe` spawn cost; `pty-cwd` event count (101 vs 3 expected); spurious `pty-exit` after close; Rust-side queue growth under a *simulated* stalled consumer (7.8→29.5 MB/32 s); child-process cleanup on `close_pty` and on host hard-kill; Windows cwd-planting and `core.fsmonitor` reproductions; test results below.
- **Not run:** anything on macOS/Linux (Unix findings are code-traced), installers, `cargo audit`/`cargo deny` (not installed → Rust advisories unchecked), circular-dependency analysis, React Profiler, real-app memory.
- Test results: **frontend 2,703 passed / 25 skipped (178 files)** with one load-induced worker-start timeout (`appShell.test.tsx` passes 93/93 alone); **Rust lib 257/257; PTY integration 19/19** (Windows uses cmd.exe, not PowerShell; WSL and AI-CLI tests pass vacuously without their prerequisites).
- Disclosure of audit side effects: an analyst's `probe2` ends with `taskkill /F /IM ping.exe` (would kill any `ping.exe` on the machine, not only its own — nothing else was affected as far as known); `npm pack --dry-run` re-created the gitignored `dist/cli/`; Rust/frontend builds went to scratch directories (several GB under the session scratchpad, safe to delete).

## 1. Overall engineering health

**Assessment: good core, with risk concentrated at the edges — B+ for a v0.2 product.**

*Strengths (evidence-backed).* The terminal core is carefully engineered: byte-exact, ordered, chunked input that rejects instead of truncating; three-thread-per-session output pipeline with guaranteed "all output before exit"; bounded shutdown; foreground-child cleanup verified on real PIDs; stale-spawn guards, early-event replay and ref-counted listeners; a rollback-safe tab hand-off protocol; strict argv-only process spawning; panic hygiene; a strong Shared Agent crypto design; code-split frontend with sensible lazy panels. The suite is large (2,703 + 257 + 19 passing tests) and the codebase carries its own bug history in comments.

*Weaknesses.* (1) The **ancillary surfaces** (updater, git probing, CLI/MCP process spawning, Tauri command exposure, typed-line recording) hold the most serious defects — mostly security, mostly cheap to fix. (2) The **output path has no flow control** and falls back to *silent dropping*, contradicting the project's own rule. (3) **CI is blind to the GUI code** (every Rust step uses `--no-default-features`). (4) **Performance is asserted, not gated**: all existing benchmarks measure the code-indexer/MCP engine; nothing measures what a terminal is judged on. (5) A handful of background timers do avoidable work at idle. (6) Documentation (`SECURITY.md`, `KNOWN_LIMITATIONS.md`) has drifted from the code in seven places.

*What I cannot say:* whether the app *feels* fast or slow, or how much RAM it uses — that needs the baseline in test plan §3.

**Counts:** 76 findings — **0 Critical, 4 High** (SEC-01, SEC-02, CI-01, REL-01 *potential*), the rest Medium/Low. Severity reflects actual impact; e.g. the call-watcher polling measured ≈0.5 % of one core and is rated Medium, not High.

## 2. Top 10 highest-impact issues

| # | ID | Issue | Sev / Conf | Why it ranks here |
|---|---|---|---|---|
| 1 | **SEC-01** | Windows `noCwdLookupEnv()` is ineffective for Node `spawn`: a planted `cmd.exe`/`git.exe`/`powershell.exe` in a cloned repo runs when you use `kai code/run/mcp` there (and every 2 s under MCP via RES-02) | High / Confirmed (repro) | arbitrary code execution from an untrusted folder; one-line parent-env fix + absolute paths |
| 2 | **SEC-02** | Updater runs a downloaded installer with no hash/signature check, from a predictable temp path (Linux: as root via `pkexec`) | High (Linux) / Med / Confirmed | supply-chain and local privilege-escalation path |
| 3 | **CI-01** | CI never compiles, lints or tests the Tauri GUI feature; the uploaded "desktop binary" is a stub | High / Confirmed (†) | every GUI regression is found at tag time; hides all other regressions |
| 4 | **PERF-01 + PERF-02** | No output backpressure (unbounded channel, fire-and-forget emit) and drop-oldest of whole chunks beyond 1 Mi chars, plus a swallowed xterm discard error | Med / Needs measurement (+Likely) | floods can exhaust memory/UI and then **silently** corrupt screen state; violates the no-drop rule |
| 5 | **REL-01†** | Global `sessions` mutex held while the PTY master is dropped (`ClosePseudoConsole`) — potential all-tab deadlock after `cd; exit` on older Windows | High (potential) / Likely | one wedged waiter freezes input for every tab |
| 6 | **SEC-03** | Automatic `git status` on `cd` runs a repo's `core.fsmonitor` command | Med / Confirmed (repro) | code execution just by entering a downloaded folder; fix is a flag |
| 7 | **SEC-04** | Tauri app commands are not behind per-window ACLs: the music/chat windows (third-party iframe) can call `create_pty` | Med / Confirmed | contradicts `SECURITY.md`; defence in depth for the whole IPC surface |
| 8 | **SEC-06†** | Every typed line (incl. password-prompt answers, TUI input) is stored in plaintext `localStorage` for a feature nothing reads | Med / Confirmed (†) | secrets at rest; deletable code |
| 9 | **FUNC-02** | Closing a busy tab/last tab or loading a workspace kills running shells with no confirmation; "Close tab or pane" closes the whole tab | Med / Confirmed | loses user work in one keystroke |
| 10 | **RES-01 + RES-02** | Ungated background polling: `reg.exe` every 3 s from launch (music-only consumer) and a synchronous `git rev-parse` every 2 s in every `kai mcp` process | Med / Confirmed (measured) | continuous idle cost and event-loop stalls; RES-02 amplifies SEC-01 |

Next in line: PERF-03† (101 `pty-cwd` events instead of 3), FUNC-01 (search shortcut likely dead), PERF-04 (output broadcast to every window), PERF-05 (blocking work on tokio workers), RES-03 (stale 82.8 MB bundled Node), FUNC-05 (first tab may ignore the configured shell), FUNC-06 (settings not synced across windows), REL-07 (Unix startup can hang).

## 3. Biggest performance bottlenecks (all code-traced; quantify via test plan §3)

1. **The output pipeline**: unbounded reader→emitter queue (PERF-01), JSON-in-`eval` transport with up to ~6× inflation for escape-heavy output (PERF-09), broadcast to every window (PERF-04), then a drop-oldest buffer (PERF-02). Under a flood this is where CPU, memory and responsiveness are lost.
2. **cwd event storm** (PERF-03, measured 101 vs 3): ~10 events/s/session and a global-lock acquisition each, while coloured output streams.
3. **Head-of-line blocking** of keystroke writes by blocking commands on tokio workers (PERF-05).
4. **Window resize**: every Tauri resize event refits all panes with uncancelled follow-up timers (PERF-06); any settings change repaints every pane in every tab (PERF-07).
5. **Startup (unmeasured)**: ≈958 kB eager JS, a ≤1.5 s font gate (PERF-11), a cold PowerShell every Windows launch (PERF-10), a synchronous login-shell PATH lookup before any window on macOS/Linux (REL-07), and the shell's own profile load (FUNC-05 shows the fast-launch setting may not reach tab 1).

## 4. Biggest memory and CPU risks

- **Memory growth with a fast producer** (PERF-01): measured 0.7 MB/s linear in the simulated-stall probe; unbounded by construction.
- **Scrollback × panes** (RES-10, derived): ≈14.4 MB/pane at 10k×120 once full; ≈144 MB/pane at the 100k maximum; ×8 panes ≈ 1.15 GB. Idle panes keep what they once printed.
- **Idle CPU/wake-ups**: `reg.exe` ×1,200/h (RES-01, measured 15.6 ms CPU each); `git` ×1,800/h per MCP server on the Node event loop (RES-02, up to 2.5–10 % of the loop); macOS `lsof` per busy session / per pane poll (PERF-12).
- **WebGL contexts**: ≤14 per window against a ~16 per-process assumption; per-window budget with multiple windows (PERF-08).
- **Whether memory stabilises over hours is unknown** — the 8-hour soak (test plan §3.5) has not been run.
- Positive: three threads per session, handle cleanup verified on close, no per-event thread leak found.

## 5. Biggest application-size opportunities

| Opportunity | Size effect | Cost / risk |
|---|---|---|
| Bundled Node 22.12.0 is 82.8 MB raw / ≈31.7 MB gzip — **~95 % of shipped resources, ~15× the app binary** (RES-03) | none from bumping (**do it for security**); ≈−30 MB compressed only if downloaded lazily | lazy download needs network + checksum, complicates offline use |
| xterm + addons ≈72 % of the 716 kB App chunk; lazy-load Search/Image/Serialize (RES-04) | ≈−70–90 kB minified (estimate from proportions) | async load order, first-use latency |
| CLI bundle: 3.6 MB of 4.3 MB is two tokenizer vocabularies (already lazy) | none needed | — |
| npm package ships the unused 1.49 MiB web `dist/` and a bundled-only runtime dependency (RES-08) | ≈−1.5 MB tarball | none |
| Remove unused direct `tokio = full` (RES-05) | −7 kB (0.13 %) | none (hygiene) |
| **Not** recommended: `opt-level=3` (+38.6 % binary, RES-06); removing fonts/images (nothing to remove — fonts already `unicode-range`-split, screenshots not bundled) | — | — |

## 6. Missing or incomplete functionality (details in FUNCTIONAL-GAP-AUDIT §3)

- **A. Critical:** running-process protection on close/restore (FUNC-02); output flow control and a no-silent-drop guarantee (PERF-01/02); per-window command ACL (SEC-04); update integrity verification (SEC-02).
- **B. Important usability:** search shortcut (FUNC-01); stale git badge after in-place git commands (FUNC-04); first-tab shell/profile race (FUNC-05); settings not synced across windows (FUNC-06); persistence drops the 11th tab, secondary windows and the active tab (FUNC-07); exit code and failure output never shown, global crash counter (FUNC-09).
- **C. Reliability:** REL-01/02/04/07/08/09, PERF-03, RES-01/02.
- **D. Optional (each tied to a user problem, not competitor parity):** OSC 52 clipboard, title/bell handling, terminal context menu, `macOptionIsMeta`, multi-line paste warning (FUNC-11).
- **Testing gaps that let these through:** the real `TerminalView` key/flush paths are stubbed in tests; `useWindowRefit` has zero tests; no e2e framework; PTY tests flood ≈25 KB on cmd.exe only (TEST-AND-BENCHMARK-PLAN §5).

## 7. Recommended implementation order

1. **Phase 0 (first, parallel):** baselines (T0.1), GUI-feature CI (T0.2), supply-chain gates (T0.3).
2. **Phase 1 — cheap, high-impact correctness/security (≈1–2 weeks):** T1.1 REL-01, T1.2 PERF-03, T1.3 SEC-01, T1.4 SEC-03, T1.5 SEC-06, T1.6 FUNC-01/02, T1.8 SEC-04; then T1.7 SEC-02 and T1.9 REL-07.
3. **Phase 2 — performance:** T2.1 per-window routing → T2.2 flow control (largest task) → T2.3 → T2.4 → T2.5, each judged against the T0.1 baseline.
4. **Phase 3 — resources/size:** T3.1 background polling, T3.2 Node bump, T3.3 budgets/hygiene, T3.4 launch-time network.
5. **Phase 4 — gaps and polish:** T4.1–T4.11.
Full per-task dependencies, files, tests, regression risks and acceptance criteria: [IMPLEMENTATION-ROADMAP](IMPLEMENTATION-ROADMAP.md).

## 8. Exact commands to reproduce and verify important findings
(Full detail and prerequisites: TEST-AND-BENCHMARK-PLAN §3–§4.)

```bash
# Baselines
npx vitest run
cargo test --no-default-features --manifest-path src-tauri/Cargo.toml --lib
cargo test --no-default-features --manifest-path src-tauri/Cargo.toml --test pty_integration_tests
npx tsc --noEmit && npx vite build --outDir <scratch>/dist-fe --emptyOutDir        # bundle sizes
CARGO_TARGET_DIR=<scratch>/target cargo build --release --locked --manifest-path src-tauri/Cargo.toml   # kai.exe size (~6.5 min cold)
npm pack --dry-run --ignore-scripts --json                                            # npm package contents
cargo tree -d --manifest-path src-tauri/Cargo.toml --locked                           # duplicate crates

# SEC-03 (core.fsmonitor executed by `git status`)
git init r && cd r && git config core.fsmonitor 'sh -c "echo pwned > ../pwned.txt; exit 0"' && git -c core.quotepath=off status --porcelain && ls ../pwned.txt

# SEC-01 (Windows, PowerShell): planted exe runs when the parent env var is unset
mkdir $env:TEMP\plant; copy C:\Windows\System32\hostname.exe $env:TEMP\plant\powershell.exe
Remove-Item Env:NoDefaultCurrentDirectoryInExePath -ErrorAction SilentlyContinue
cd $env:TEMP\plant; node -e "require('child_process').spawnSync('powershell',['-NoProfile','-Command',\"'REAL'\"],{stdio:'inherit'})"   # prints nothing: the planted exe ran

# PERF-03 / PERF-01 / REL-01 regression coverage (the throw-away probes are not kept):
cargo test --no-default-features --manifest-path src-tauri/Cargo.toml --lib osc_scanner         # cwd events: once per report
cargo test --no-default-features --manifest-path src-tauri/Cargo.toml --test pty_integration_tests test_19 test_20   # bounded output, stalled consumer

# RES-01 idle process churn (Windows): Process Monitor, filter "Operation is Process Create" + "Parent PID is <kai.exe>", 10 min, music panel never opened
# FUNC-01: focus a terminal, press Ctrl+Shift+F (expect: search does not stay open)
# SEC-06: type text at a no-echo prompt; DevTools → Local Storage → kai_cmd_history_v1
# SEC-04: music mini-window DevTools → __TAURI_INTERNALS__.invoke("create_pty", {...}) (expect: rejected after the fix; accepted today)
# Not yet checked: npx madge --circular --extensions ts,tsx src ; cargo install --locked cargo-audit cargo-deny && cargo audit --file src-tauri/Cargo.lock
```

## 9. Findings register

Severity: H High, M Medium, L Low. Confidence: C Confirmed, Li Likely, N Needs measurement. † lead-verified.

| ID | Title | Sev | Conf | Doc |
|---|---|---|---|---|
| ARCH-01 | Unrelated product surfaces with always-on/startup costs | M | C | Architecture |
| ARCH-02 | Four independent cwd-tracking mechanisms | M | C | Architecture |
| ARCH-03 | `TerminalView.tsx` over-concentrated, real behaviour untested | M | C | Architecture |
| ARCH-04 | Dead/unreferenced code and dependencies (†) | L | C | Architecture |
| ARCH-05 | Two runtimes, one 83 MB sidecar | M | C | Architecture |
| ARCH-06 | Version/mirror/doc drift | L | C | Architecture |
| PERF-01 | No output backpressure | M | N | Performance |
| PERF-02 | Silent output drops | M | Li | Performance |
| PERF-03† | cwd events re-emitted on every read (101 vs 3) | M | C | Performance |
| PERF-04 | Output broadcast to every window | M | C | Performance |
| PERF-05 | Blocking work on tokio workers | M | Li | Performance |
| PERF-06 | Window `onResized` refits all panes undebounced | M | N | Performance |
| PERF-07 | Settings change repaints all panes | L | C/N | Performance |
| PERF-08 | WebGL budget per window; no re-attach after loss | L | N | Performance |
| PERF-09 | JSON-in-eval output transport; one invoke per key | L | N | Performance |
| PERF-10 | Cold PowerShell on every Windows launch | L–M | Li | Performance |
| PERF-11 | Font gate ≤1.5 s; eager addons | L | N | Performance |
| PERF-12 | cwd polling/probes on macOS/Linux | L | Li | Performance |
| RES-01 | Call watcher `reg.exe` every 3 s, ungated | M | C | Resource |
| RES-02 | `kai mcp` sync `git rev-parse` every 2 s | M | C | Resource |
| RES-03 | Bundled Node dominates size, stale 22.12.0 | M | C/Li | Resource |
| RES-04 | No bundle budget; App chunk 716 kB (~72 % xterm) | M | C/N | Resource |
| RES-05 | Unused direct `tokio = full` (†) | L | C | Resource |
| RES-06 | Release profile already tuned; `opt-level=3` +38.6 % (info) | L | C | Resource |
| RES-07 | Launch-time network contacts undocumented | L | C | Resource |
| RES-08 | npm package contents / dependency placement | L | C | Resource |
| RES-09 | `reqwest` webpki roots, not OS store | L | Li | Resource |
| RES-10 | Memory per pane scales with scrollback | L | N | Resource |
| FUNC-01 | Ctrl+Shift+F likely toggles twice | M | Li | Functional |
| FUNC-02 | No confirmation for destructive actions | M | C | Functional |
| FUNC-03 | Close active tab jumps to last tab | L | C | Functional |
| FUNC-04 | Git badge stale after in-place git commands | L–M | Li | Functional |
| FUNC-05 | First tab may ignore configured shell/profile setting | M | Li | Functional |
| FUNC-06 | Settings not synced across windows | M | C | Functional |
| FUNC-07 | Persistence gaps (>10 tabs, windows, active tab) | L–M | C | Functional |
| FUNC-08 | Restored hidden tabs spin forever | L | C | Functional |
| FUNC-09 | Exit status/failure output lost; global crash counter | L–M | C | Functional |
| FUNC-10 | Keyboard/clipboard edge cases (AltGr etc.) | L | Li | Functional |
| FUNC-11 | Absent terminal features (OSC 52, title, bell, menu, …) | L | C | Functional |
| FUNC-12 | Spawn-time cwd/shell validation quirks | L | C | Functional |
| FUNC-13 | Tab-strip drag/menu details | L | Li | Functional |
| REL-01† | `sessions` lock held across master drop | H (pot.) | Li | Reliability |
| REL-02 | `resize_pty` holds global lock | L | C | Reliability |
| REL-03 | Spurious `pty-exit` after explicit close | L | C | Reliability |
| REL-04 | Unix close = SIGHUP only | L–M | Li | Reliability |
| REL-05 | Read `Interrupted` treated as EOF | L | N | Reliability |
| REL-06 | Invalid-UTF-8 corrupts a split char | L | C | Reliability |
| REL-07 | Login-shell PATH blocks/hangs startup (Unix) | M | Li | Reliability |
| REL-08 | Hand-off rough edges | L | N | Reliability |
| REL-09 | Spawn not ordered after listeners | L–M | N | Reliability |
| REL-10 | `env::set_var` from startup thread (Unix) | M–L | Li | Reliability |
| REL-11 | Tab shells not in a Job Object (document) | L | C | Reliability |
| REL-12 | Mutex held across pipe I/O (Shared Agent) | L | Li | Reliability |
| SEC-01 | Windows cwd binary planting | **H** | C | Security |
| SEC-02 | Updater without integrity check | **H**/M | C | Security |
| SEC-03 | `git status` runs repo `core.fsmonitor` | M | C | Security |
| SEC-04 | App commands not capability-gated | M | C | Security |
| SEC-05 | Symlink alias bypasses sensitive-file filter | M | Li | Security |
| SEC-06† | Typed lines persisted in localStorage | M | C | Security |
| SEC-07 | CSP broader than needed | L–M | C | Security |
| SEC-08 | Agent-config launcher/mode/backup | L–M | C | Security |
| SEC-09 | PATH edits (REG_EXPAND_SZ flatten; rc edits) | L–M | Li | Security |
| SEC-10 | Git optional locks / pathspec magic | L | Li | Security |
| SEC-11 | Shared Agent unauthenticated session kill | L | C | Security |
| SEC-12 | cwd trusted from untrusted OSC 7 | L | Li | Security |
| SEC-13 | Secret-handling nits | L | C | Security |
| SEC-14 | Documentation drift | L | C | Security |
| CI-01† | GUI feature never built/tested in CI | **H** | C | Test plan |
| CI-02 | Release gate Linux-only, not tied to CI | M | C | Test plan |
| CI-03 | Missing supply-chain gates | M | C | Test plan |
| CI-04 | No e2e / real-renderer tests | M | C | Test plan |
| CI-05 | PTY test depth | M | C | Test plan |
| CI-06 | Performance claims not gated | M | C | Test plan |
| CI-07 | Duplicate CI work, no concurrency/timeouts | L | Li | Test plan |
| CI-08 | Lint is only `tsc` | L | C | Test plan |
| CI-09 | Docker harness drift | L | C | Test plan |
