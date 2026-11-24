# Test and Benchmark Plan

Repository `kai-terminal` @ `50f4c8c`, audited 2026-11-23. No source file was changed; this document specifies what to run and what instrumentation to add. **No benchmark result below was invented**: §1 states exactly what was and was not measured.

## 1. Baseline status (what exists today)

### 1.1 Existing tests — actually run during this audit

| Suite | Command | Result | Notes |
|---|---|---|---|
| Frontend (Vitest 5, jsdom) | `npx vitest run` | **178 files passed, 1 skipped; 2,703 tests passed, 25 skipped; 153 s** | exit code 1 because of **one unhandled error**: `[vitest-pool]: Failed to start forks worker for … appShell.test.tsx` (worker start timeout while other audit jobs were using the CPU). Re-run alone: `npx vitest run src/__tests__/appShell.test.tsx` → **93/93 passed**, 30.6 s. Treat the timeout as load-induced, not a product failure; it shows the suite is sensitive to CPU contention. |
| Rust lib tests | `cargo test --no-default-features --manifest-path src-tauri/Cargo.toml --lib` | **257 passed, 0 failed, 72 s** (cold build ≈3 min) | log not kept. |
| Rust PTY integration | `cargo test --no-default-features --manifest-path src-tauri/Cargo.toml --test pty_integration_tests` | **19 passed, 0 failed, 2.9 s** | On Windows the shell is `%ComSpec%` (cmd.exe), **not PowerShell**; `test_16_wsl_shell_round_trip` (needs `KAI_TEST_WSL=1`) and `test_13_real_ai_cli_compatibility` pass vacuously when their prerequisite is absent. Nothing Unix-specific was run. |
| Type check | `npx tsc --noEmit` | clean, 8.6 s | |

`isolate` observation from the Vitest summary: 179 workers × ≈4.23 s start each; Vitest estimates "at least ~46 s faster with `isolate: false`". This is **not recommended without checking** that tests do not rely on per-file isolation (they set `KAI_HOME` via `isolateKaiHome.ts`); it is listed only as a measured fact.

### 1.2 Test inventory (static counts)
- Frontend: 179 test files, ≈2,528 `it/test` calls (regex count; `.each` counted once). By area (overlaps possible): terminal/PTY/tabs/panes/windows 42 files / 476; MCP/index/retrieval/CLI/agents 50 / 882; integrations/Azure/Teams/Shared Agent 21 / 461; UI/theme/settings/modals/updates 33 / 338; music 11 / 117; security/hardening/misc 22 / 254.
- Rust: ≈253 `#[test]` across 24 files (ai_cli 44, pty 41, shell 38, git 11, integrations 12, kai_cli 11, clipboard 10, fonts 10, updater 9, call_watch 9) + 19 PTY integration tests. Tests under `#[cfg(feature = "tauri")]` do **not** run in CI (CI-01).
- Absent: any e2e/WebDriver/Playwright/tauri-driver framework; any Rust benchmark (`[[bench]]`/criterion); any timing/memory gate.

### 1.3 Baseline metrics table (brief §12)

| Metric | Status | Measured value | How to obtain it (see §3) |
|---|---|---|---|
| Cold startup (time to usable terminal) | **Not measured** | — | §3.1, requires launching the GUI |
| Warm startup | **Not measured** | — | §3.1 |
| Idle CPU | **Not measured** (code-traced idle costs: RES-01, RES-02) | — | §3.2 |
| Active CPU (continuous output) | **Not measured** | — | §3.3 |
| Input latency (keypress→visible) | **Not measured** | — | §3.4 (needs instrumentation) |
| Render latency (output received→rendered) | **Not measured** | — | §3.4 (needs instrumentation) |
| Memory idle / active | **Not measured** (derived estimate only, RES-10) | — | §3.5 |
| Memory stability (long-running) | **Not measured**; Rust-side growth with a stalled consumer **was** measured | 7.8 → 29.5 MB over 32 s (simulated consumer) | §3.5, throw-away probe (not kept) |
| Pane scaling 1/2/4/8 | **Not measured** | — | §3.6 |
| Release binary size | **Measured** | `kai.exe` 5,502,464 B (5.25 MiB), `opt-level="s"` | RESOURCE-AND-SIZE-AUDIT §1.1 |
| Installer size | **Not measured** (no installer built) | proxy: Node 82.8 MB raw / ≈31.7 MB gzip | §3.7 |
| Frontend bundle | **Measured** | 1,229,505 B JS (352,747 B gz), CSS 139,407 B, `dist/` 1.49 MiB | §3.7 |
| `reg.exe` spawn cost | **Measured** | 43 ms wall / 15.6 ms CPU avg, 20 runs | §3.2 |
| `pty-cwd` event count | **Measured** | 101 events for 2 `cd` + 5 colour commands (expected 3) | §4 |

## 2. CI findings (test, build and release infrastructure)

### CI-01 — CI never compiles, lints or tests the Tauri (GUI) feature
- **CI / High / Confirmed (†: every Rust step in `ci.yml:127-185` uses `--no-default-features`).**
- **Location:** `.github/workflows/ci.yml` (steps "Rust Backend Clippy Lint", "Unit Tests", "Build Rust Desktop Application Binary"), `src-tauri/Cargo.toml [features]`.
- **Root cause:** `--no-default-features` disables `tauri`. `lib.rs` has 72 `cfg(feature = "tauri")` sites plus `updater.rs` (10), `shell.rs` (4), `call_watch.rs` (4), `kai_cli.rs`, `terminal_windows.rs`. The uploaded `desktop-binary-<target>` is the non-GUI stub. The first real Tauri compile on Windows/macOS happens in `release.yml` `build` (fail-fast) on a **tag**; on Linux only in `linux-packages`, also unlinted.
- **Repro:** introduce a deliberate type error under `#[cfg(feature = "tauri")]` on a branch; CI stays green.
- **Impact:** user — a GUI-code regression surfaces as a failed or, worse, broken release; technical — "Production build verification passed" is misleading; tauri-gated tests never run.
- **Fix (S–M):** add `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` and `cargo test --lib` with default features on `windows-latest` and `macos-15` (after `npm run build`), and rename or replace the stub artifact (or `tauri build --no-bundle`).
- **Verify:** the deliberate-error branch must fail CI.

### CI-02 — Release `gate` is Linux-only and not tied to CI status
- **CI / Medium / Confirmed.** `release.yml` `gate`: fmt/typecheck/vitest/clippy/rust unit/PTY on ubuntu only, then a 6-target `build` (fail-fast). It does not re-run the security-regression subset, `npm audit`, or Windows/macOS PTY tests, and nothing requires the tagged commit's CI to be green. **Impact:** a Windows-only failure or a newly added vulnerability can still publish. **Fix (M):** `needs` a reusable `ci.yml` (`workflow_call`) or check commit status via API before publishing. **Verify:** tag a failing commit on a fork.

### CI-03 — Missing supply-chain gates
- **CI / Medium / Confirmed.** Present: `npm audit --omit=dev --audit-level=high` (run 6× on the matrix), committed-secret grep, `npm ci`, committed `Cargo.lock`. Missing: `cargo audit`/`cargo deny` (neither installed locally, so Rust advisories are unchecked), Cargo `--locked`, dev-dependency audit (1 high today, test-only), audit of `kai-website/` (2 vulnerabilities, never built/audited in CI), dependabot/renovate (none), Rust toolchain pin (`dtolnay/rust-toolchain@stable`, no `rust-toolchain.toml`), SHA pinning of floating actions (`tauri-apps/tauri-action@v0`, `softprops/action-gh-release@v2`, `Vampire/setup-wsl@v7`, `snapcore/action-build@v1`; the release job has `contents: write`), SBOM/provenance/checksums. **Fix (S–M):** one ubuntu `security` job (`cargo install --locked cargo-audit`, `cargo deny check`, `npm audit`), `.github/dependabot.yml`, `--locked`, `rust-toolchain.toml`. **Verify:** seed a known-vulnerable crate on a branch.

### CI-04 — No end-to-end UI test and no real-renderer test
- **CI / Medium / Confirmed.** Split layout, tab drag/tear-off, WebGL attach/detach and xterm fit/resize against a real PTY are covered only by logic-level unit tests with mocks; the Rust PTY tests never touch the webview and the TS tests never touch a real PTY. **Impact:** regressions like the recent "focus the terminal when the active tab changes" are found by users; WebView2/WKWebView/WebKitGTK differences are untested. **Fix (L):** `tauri-driver` + WebdriverIO smoke test on Windows/Linux (spawn, type `echo`, split, resize, tear-off); start with one Windows smoke test in `release.yml`. **Verify:** green job; sabotage test.

### CI-05 — PTY test depth
- **CI / Medium / Confirmed.** `test_08` floods 500 lines (≈25 KB) with an instant emitter (no throughput, no backpressure, no memory assertion); `test_05` resize asserts the *stored* size, not that the child observes it (`stty size`/`mode con`/SIGWINCH); `test_10` runs a small number of concurrent sessions, no churn; the default Windows shell in tests is cmd.exe. Cleanup tests (`test_11`, `test_15`, `test_15b`) genuinely check real PIDs. **Fix (M):** add §5 tests 1–9. **Verify:** each new test fails when the reader loop is throttled or the bug is reintroduced (mutation check).

### CI-06 — Performance claims are not backed by regression gates
- **CI / Medium / Confirmed.** The only benchmarks measure the code-indexing/MCP engine; `performance_benchmarks.test.ts` asserts correctness only (no time/memory thresholds); `perf_step9_regression.test.ts` checks invariants; `bench:perf` is excluded from CI and its result JSON is never compared; the "terminal output throughput" row in `docs/PERF_STEP9.md` is a JS string-buffer microbenchmark (the document itself says no Rust toolchain/real sessions were available and "four concurrent sessions" is a proxy); `gpuBudget.test.ts` uses mocks. **Nothing gates what a terminal is judged on:** PTY→xterm throughput, keystroke-to-echo latency, frame time, cold start, memory per pane. **Fix (M):** §3 benchmarks as a nightly job with stored baselines and generous thresholds (≈5× measured median) before tightening.

### CI-07 — Duplicate matrix work and no safeguards
- **CI / Low / Likely.** Each of 6 OS legs runs full Vitest then re-runs three subsets already contained in it, plus `npm audit` 6×; `linux-packages` and `wsl` run on every push to `feature/**` and every PR; no `concurrency:` group, no `timeout-minutes`, no `permissions:` block in `ci.yml`. **Fix (S):** `concurrency: cancel-in-progress`, timeouts, least-privilege `permissions`. CI wall-clock not measured.

### CI-08 — Linting is only `tsc`
- **CI / Low / Confirmed.** `lint` = `tsc --noEmit`; no ESLint, so `react-hooks/exhaustive-deps` is unchecked in a 1,592-line `TerminalView` with many refs/effects. pre-push runs typecheck + prettier + `cargo fmt` + clippy + `cargo test --lib` (minutes cold) but not PTY tests/Vitest. **Fix (M):** add ESLint with `react-hooks`; document `HUSKY=0`.

### CI-09 — Docker harness drift
- **CI / Low / Confirmed.** `Dockerfile.test` uses `node:22-bookworm` while CI/release use Node 24; rustup stable unpinned; Linux PTY only. **Fix (S):** shared `.nvmrc`/`rust-toolchain.toml`.

## 3. Benchmark procedures (all reproducible; none executed in this audit unless noted)

All procedures: close other heavy apps, AC power, fixed window size (1000×650, the default), default theme, scrollback default 10,000, record machine model/OS build/WebView2 version, run **5 times**, report median and p95, discard the first run of each cold sequence only if stated.

### 3.1 Startup (cold and warm)
- **Definition:** *time to usable terminal* = process start → first shell prompt painted **and** a typed character echoed.
- **Cold:** reboot or `Clear-RecycleBin`-independent: drop file cache is not available on Windows, so approximate cold = first launch after reboot; **warm** = relaunch within 30 s.
- **External proxy (no code change):** PowerShell
  ```powershell
  $sw=[Diagnostics.Stopwatch]::StartNew()
  $p=Start-Process .\kai.exe -PassThru
  while(-not $p.MainWindowHandle){ Start-Sleep -Milliseconds 10; $p.Refresh() }   # window exists
  $win=$sw.ElapsedMilliseconds
  # first shell process created as a child of kai.exe:
  do { $c=Get-CimInstance Win32_Process -Filter "ParentProcessId=$($p.Id)" | ? Name -match 'pwsh|powershell|cmd|bash|wsl' } until($c)
  "window=$win ms, shell spawned=$($sw.ElapsedMilliseconds) ms"
  ```
  This brackets window creation and shell spawn; it does **not** capture first paint of the prompt.
- **Instrumentation needed for the exact number (one-time, behind `KAI_BENCH=1`):** `performance.mark` at (a) `main.tsx` start, (b) `App` mount, (c) `create_pty` resolved, (d) the first `term.write` **callback** containing visible text; Rust `Instant` at `main()` and at `create_pty` entry/exit; write all to a JSON file. The existing `lastKeyAtRef` (stamped in `onData`) is a ready hook for §3.4.
- **Breakdown to record:** WebView2 init, JS parse (≈958 kB eager), font gate (≤1.5 s, PERF-11), 60 ms spawn delay, ConPTY spawn, shell profile load (compare `skipShellProfile` on/off; FUNC-05 confirms the setting may not reach tab 1).

### 3.2 Idle CPU, wake-ups and process churn
```powershell
# CPU of kai.exe + its WebView2 children over 5 min idle (music panel never opened)
$root=@((Get-Process kai).Id)
$kids=@(Get-CimInstance Win32_Process | ? { $root -contains $_.ParentProcessId } | % ProcessId)   # msedgewebview2 children
$ids=$root+$kids   # WebView2 grandchildren (renderer/GPU) have the manager as parent; extend one more level if needed
$t0=($ids|%{(Get-Process -Id $_ -EA 0).TotalProcessorTime.TotalMilliseconds}|Measure -Sum).Sum
Start-Sleep 300
$t1=($ids|%{(Get-Process -Id $_ -EA 0).TotalProcessorTime.TotalMilliseconds}|Measure -Sum).Sum
"idle CPU ms over 300 s: $($t1-$t0)  => $([math]::Round(($t1-$t0)/3000/[Environment]::ProcessorCount,3)) % of total CPU"
```
- **Process churn (RES-01/RES-02):** Process Monitor with filter `Operation is Process Create` and `Parent PID is <kai pid>` for 10 minutes; expected today ≈200 `reg.exe` creations/10 min (3 s interval). Alternative: enable Security audit 4688 and count. For `kai mcp`, count `git.exe` creations under the `node.exe` PID (expected ≈300 per 10 min today).
- **`reg.exe` micro-cost (done in the audit):** 20 × `Start-Process reg query HKCU\Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone /s /v LastUsedTimeStop` timed with `Stopwatch`; measured 43 ms wall / 15.6 ms CPU.

### 3.3 Active CPU under continuous output
Flood generators (run inside one pane, then 4 panes, then a background tab):
- PowerShell: `1..3000000 | % { "line $_ " + ('x'*80) }`
- cmd: `for /L %i in (1,1,3000000) do @echo line %i xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`
- Escape-heavy: `git log --graph --color --all` on a large repo repeated, or a `yes $(printf '\e[31mred\e[0m')` equivalent in WSL.
- Continuous: `ping -t 127.0.0.1`, `Get-Content -Wait`, a real `npm install`/`cargo build`.
- **Record:** wall time to completion, bytes/s, CPU of `kai.exe` vs `msedgewebview2.exe` separately (§3.2 snippet over the run), peak private bytes of each, UI responsiveness (can a key be typed and echoed during the flood? time-to-prompt after Ctrl+C), and **byte-exact integrity**: `1..N | % {"$_"} | Tee-Object out.txt` then compare the last line and line count shown in the terminal against `out.txt` (any shortfall is PERF-02 in action). Run once with the window minimised for 5 minutes and compare (PERF-02 repro).
- **Rust-side throughput without the GUI:** extend a throw-away Rust probe (a throw-away script, not kept in the repository) (below) with a fast emitter and measure MB/s through `coalesce_output`.

### 3.4 Input latency and render latency
- **Input latency (keypress→visible echo):** instrument `onData` (existing `lastKeyAtRef` timestamp) and record the delta to the next `term.write` **callback** that contains the echo; report p50/p95/p99 over 1,000 keystrokes while (a) idle, (b) another pane floods, (c) 8 panes open. External validation: a 240 fps phone camera or Typometer-style tooling for end-to-end including compositor.
- **Render latency (output received→rendered):** timestamp in `ptyService` listener on receipt, and at the `term.write` callback; add `requestAnimationFrame` after the callback to approximate paint. Report during §3.3 floods.
- **Backend share:** log `Instant` at reader `read` return and at `emit_output` to quantify the 4 ms coalescing window and queueing (PERF-01).

### 3.5 Memory and memory stability
```powershell
Get-Process kai,msedgewebview2 | Select Name,Id,@{n='WS_MB';e={[int]($_.WorkingSet64/1MB)}},@{n='Private_MB';e={[int]($_.PrivateMemorySize64/1MB)}}
```
- **Per session:** 1 pane, record idle private bytes; run `1..200000 | % {"x"*100}`; record again; repeat for scrollback 1,000 / 10,000 / 100,000 and cols 80/120/200. Compare with the derived estimate (lines × cols × 12 B, RES-10). Close the pane and record whether memory is released (leak check).
- **Long-running stability:** 4 panes each running `ping -t` and one `Get-Content -Wait` for **8 hours**, sampling every minute to CSV (`kai.exe`, `msedgewebview2.exe` private bytes, handle count `HandleCount`, thread count). **Pass criterion:** private bytes plateau after scrollback fills (≈ lines × cols × 12 B per pane) and handle/thread counts stay flat. Linear growth ⇒ leak (check `TerminalOutputBuffer`, listener maps, `ptyEarlyEvents`).
- **Churn:** open/close 200 tabs in a loop (needs the e2e harness, CI-04); handles and threads must return to baseline (3 threads per session).

### 3.6 Pane and session scaling (1, 2, 4, 8 panes; plus multiple tabs; plus background sessions)
For N ∈ {1,2,4,8} panes in one tab, then N panes split over 2 tabs with one hidden tab producing continuous output: run §3.3's continuous generator in **one** pane while the others idle, then in **all** panes. Record per N: total CPU (kai + WebView2), total private bytes, key-echo p95 (§3.4), time to switch tabs (instrument the `activeTab` effect), time to complete a window resize (instrument `fit()` calls/s during a scripted drag, PERF-06), WebGL context count (`chrome://gpu` equivalent via DevTools). Repeat with two windows to expose PERF-04 and PERF-08. **Output:** a table of CPU%, MB, p95 ms per N, and the N where echo p95 first exceeds 50 ms (the practical knee).

### 3.7 Build and size
```bash
npx tsc --noEmit && npx vite build --outDir <scratch>/dist-fe --emptyOutDir   # frontend sizes (gzip via reporter, or gzip -9 -c)
npx vite build --config vite.cli.config.ts --outDir <scratch>/dist-cli          # CLI bundle
CARGO_TARGET_DIR=<scratch>/target cargo build --release --locked --manifest-path src-tauri/Cargo.toml   # ~6.5 min cold, 16 cores
ls -l <scratch>/target/release/kai.exe
npm pack --dry-run --ignore-scripts --json                                       # npm tarball
# installers (not done in this audit): node scripts/fetch-node.mjs && npx tauri build --config src-tauri/tauri.bundled-node.conf.json
cargo tree -d --manifest-path src-tauri/Cargo.toml --locked                      # duplicate crates
```
Compare variants one at a time on an idle machine (build-time numbers in this audit were contended).

## 4. Commands to reproduce the audit's key findings

| Finding | Exact steps |
|---|---|
| Baseline tests | `npx vitest run` · `cargo test --no-default-features --manifest-path src-tauri/Cargo.toml --lib` · `cargo test --no-default-features --manifest-path src-tauri/Cargo.toml --test pty_integration_tests` |
| PERF-03 / PERF-01 / REL-01 | The throw-away probes are not kept; regression tests now cover them: `cargo test --no-default-features --manifest-path src-tauri/Cargo.toml --lib osc_scanner` (PERF-03), `--test pty_integration_tests test_19 test_20 test_21` (PERF-01/02: byte-exact flood, stalled consumer, exit while paused), `--lib test_session_is_dropped` (REL-01). |
| SEC-01 cwd planting (Windows) | Regression test: `npx vitest run src/__tests__/spawnSafety.test.ts` (plants executables in a temp folder and asserts the real tools run). To see the original bug by hand: in a folder holding a copy of `hostname.exe` named `powershell.exe`, with `NoDefaultCurrentDirectoryInExePath` removed from the environment, run `node -e "require('child_process').spawnSync('powershell',['-NoProfile','-Command',\"'REAL'\"],{stdio:'inherit'})"`: the planted exe runs and `REAL` is not printed; with the variable set in the **parent** the real tool runs. |
| SEC-03 `core.fsmonitor` | `git init r; cd r; git config core.fsmonitor 'sh -c "echo pwned > ../pwned.txt; exit 0"'; git -c core.quotepath=off status --porcelain; ls ../pwned.txt` |
| FUNC-01 search | Focus a terminal, press `Ctrl+Shift+F`; expected today: bar does not stay open. Then open via command palette to confirm the single-toggle path works. |
| SEC-06 typed-line recording | `sudo -k; sudo ls` (or any no-echo prompt), type text, open DevTools → Application → Local Storage → `kai_cmd_history_v1`. |
| RES-01 `reg.exe` polling | §3.2 Process Monitor recipe, music panel never opened. |
| RES-02 MCP git polling | Run `kai mcp` under an MCP client, count `git.exe` creations under its `node.exe` for 5 minutes. |
| SEC-04 command ACL | Open the music mini window, DevTools → `__TAURI_INTERNALS__.invoke("create_pty", {...})`; today it is not rejected. |
| CI-01 | Add `#[cfg(feature="tauri")] compile_error!("x");` on a throwaway branch, open a PR, observe CI green. |
| Bundle sizes | §3.7 first two commands. |
| Circular dependencies (not analysed) | `npx madge --circular --extensions ts,tsx src` (dev-only, no repo dependency change) |
| Rust advisories (not checked) | `cargo install --locked cargo-audit cargo-deny && cargo audit --file src-tauri/Cargo.lock && cargo deny --manifest-path src-tauri/Cargo.toml check` |

## 5. Tests to add (each one catches a specific finding)

**Rust unit/integration**
1. cwd de-duplication across reads: feed `[OSC A][OSC B][colour][colour]`, assert one event per distinct report (PERF-03).
2. `sessions` not held while master drops — inject a master whose `Drop` blocks; `list_sessions()` must still return (REL-01); resize with a sleeping `resize` (REL-02).
3. Backpressure/slow-consumer: bounded queue, RSS plateau, `close_pty` returns promptly (PERF-01).
4. Multi-window event targeting: output reaches only the owner (PERF-04).
5. Live **PowerShell** session round-trip on Windows (the real default shell).
6. Explicit close emits no crash-coded `pty-exit` (REL-03); SIGHUP-ignoring shell is eventually killed (REL-04, Linux); detached-child policy documented by test (REL-11).
7. Reader `Interrupted` handling (REL-05); invalid-UTF-8-then-split (REL-06).
8. `login_path` with a backgrounding rc file returns within the bound (REL-07).
9. Property/fuzz test for `extract_osc_cwds` (runs on every read); child-observed resize (`stty size`/`mode con`); 10–50 MB flood with RSS and time assertion; spawn/close churn of 200 sessions.

**Frontend**
10. Real `TerminalView` + fake xterm: key handler then window listener (FUNC-01), AltGr, copy/paste (FUNC-10), flush/exit ordering, minimised-window overflow with a drop marker (PERF-02), listener-before-spawn (REL-09), double `handleExit`.
11. `useWindowRefit` (zero tests today): call counts under a resize burst (PERF-06).
12. Close/restore confirmation, `closeTab` neighbour selection (FUNC-02/03); first-tab shell race with delayed `get_available_shells` (FUNC-05); settings propagation across windows (FUNC-06); persistence with 12 tabs and a torn-off tab (FUNC-07); git-badge refresh after an in-place command (FUNC-04); history privacy (SEC-06).

**Security / CI**
13. Windows CI test that plants an exe in cwd and asserts it is not executed (SEC-01); `git` probe test that `core.fsmonitor` is not run (SEC-03); symlink-to-`.env` index/read refusal on Linux/macOS (SEC-05); updater tamper test and symlink-destination test (SEC-02); `tauriCsp.test.ts` against the narrowed policy (SEC-07); command-ACL test that secondary windows cannot call `create_pty` (SEC-04).

## 6. Benchmark and regression gates to add (after §3 baselines exist)
- Nightly job on a pinned runner publishing JSON artifacts: PTY→emitter MB/s (Rust, no GUI), flood completion time + peak RSS, cold-start proxy, bundle size (gzip) of `index`/`App`. Fail on >20 % regression vs the stored median initially (generous), tighten later.
- Bundle gate: fail if gzip(`App`) > 215 kB or gzip(`index`) > 85 kB (current 196.9 / 74.2 kB) (RES-04).
- Keep `bench:perf` (indexer/MCP) but add thresholds to `performance_benchmarks.test.ts` (≈5× current median).
- Once an e2e harness exists (CI-04), a scripted 1/2/4/8-pane scenario that records the §3.6 table.
