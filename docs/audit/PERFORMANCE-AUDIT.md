# Performance Audit

Repository `kai-terminal` @ `50f4c8c`, audited 2026-11-23. No source file was changed.
See [EXECUTIVE-SUMMARY](EXECUTIVE-SUMMARY.md) for the ranked view and [TEST-AND-BENCHMARK-PLAN](TEST-AND-BENCHMARK-PLAN.md) for how to measure everything marked *Needs measurement*.

## 0. Honest scope statement

The GUI was **not launched** during this audit (no interactive desktop session was driven). Therefore **no number in this file describes real startup time, input latency, frame time, idle CPU or resident memory of the running app.** What *was* measured is listed in §1; everything else is a code-traced finding with the instrumentation needed to quantify it. Nothing here is an invented benchmark.

## 1. What was actually measured

| Measurement | Result | Method / caveat |
|---|---|---|
| PTY→emitter memory growth with a stalled consumer | working set 7.8 MB → 29.5 MB over 32 s, strictly linear (~0.7 MB/s) while the consumer drained 21.7 MB of a 102 MB `type` into cmd.exe | a throw-away Rust probe (a throw-away script, not kept in the repository); emitter sleeps 100 ms per event to *simulate* a stalled webview. The real Tauri emit path was not instrumented. |
| `pty-cwd` events for a PowerShell session | **101 events** for 2 `cd` + 5 colour commands (expected 3) | `probe.rs` live PowerShell session via `PtyManager` (PERF-03) |
| Spurious `pty-exit` after explicit close | `exit events after explicit close: [Some(1)]` | `probe2.rs` (REL-03) |
| `reg.exe` spawn cost (call watcher) | 43 ms wall avg (33–59), 15.6 ms child CPU avg, 20 runs, .NET `Process` | ≈1,200 spawns/h at the 3 s interval (RES-01) |
| Frontend production build | `tsc --noEmit` 8.6 s; `vite build` 30 s; eager payload ≈958 kB JS raw (≈273 kB gz) + 135 kB CSS | RESOURCE-AND-SIZE-AUDIT §2 |
| Test-suite wall time | Vitest 153 s for 179 files (4.23 s worker start per file); cargo lib tests 72 s; PTY integration 2.9 s | machine was shared with other analysis jobs |

## 2. Startup performance (code-traced, not timed)

Sequence on launch, with what blocks first paint or first usable terminal:

1. **macOS/Linux GUI launches:** `login_path::apply_login_shell_path()` runs `$SHELL -ilc` **synchronously on the main thread before any window exists** (`lib.rs:767`, `login_path.rs:66-121`). It can take as long as the user's full interactive rc and can hang indefinitely (REL-07).
2. **Windows:** `warm_host_pty_cache()` spawns a background thread (`reg` / `cmd /c ver`) so the first `create_pty` usually finds the build number cached; otherwise the first PTY probes synchronously (up to 5 s + 5 s timeouts, `shell.rs:467-488`).
3. `setup()` (`lib.rs:~825-846`): bundled-Node registration (a few `stat`s), **call watcher starts and runs `reg.exe` immediately** (RES-01), and one background thread runs `ensure_kai_cli` (Windows: a cold PowerShell on **every** launch — PERF-10).
4. Frontend: `main.tsx` starts `import("./App")` and a font preload that gates first render for up to 1.5 s (PERF-11), then mounts. Initial tab spawns 60 ms after mount (FUNC-05 shows this can race the shell list).
5. Deliberately deferred (good): update check at 45 s, cache janitor once per version, autostart `reg` query and font enumeration only when Settings opens, panel code prefetched at idle.

**Time to first usable terminal** is therefore bounded below by: WebView2 init + parse of ~958 kB JS + ≤1.5 s font gate + 60 ms spawn delay + ConPTY spawn + the *shell's own profile load* (PowerShell profile cost dominates; `skipShellProfile` exists but may not apply to tab 1 — FUNC-05). The only way to put numbers on this is the instrumentation in the test plan (§3 "Startup").

## 3. Findings

### PERF-01 — No output backpressure: unbounded channel plus fire-and-forget emit
- **Performance / Medium / Needs measurement** (growth is measured with a simulated consumer; real-app magnitude is not).
- **Location:** `src-tauri/src/pty.rs:596` (`std::sync::mpsc::channel`), `:620` (`send`, error ignored), `:31` (`emit` never blocks); frontend has no ack/pause command (no `invoke` name in `src/` provides one).
- **Root cause:** the reader never blocks, so the child is never throttled; the queue between ConPTY/pty and the webview is an unbounded `Vec<Vec<u8>>` plus Tauri's unbounded main-thread eval queue, and the webview cannot acknowledge.
- **Repro:** a throw-away Rust probe (a throw-away script, not kept in the repository) (stalled-consumer emitter) or, in the real app, `yes | head -c 2G` in a pane while watching Rust and WebView2 private bytes and the time-to-prompt after Ctrl+C.
- **Impact:** user — `cat huge.log`, `npm install`, AI-CLI streaming can saturate the UI thread (up to ~250 events/s × ≤98 KB), "Not Responding", Ctrl+C that takes long to take visible effect; technical — memory grows with the producer; the frontend then compensates by dropping output (PERF-02).
- **Fix (M–L):** (a) bounded `sync_channel` + credit/ack (`pty_ack(id, bytes)`; reader blocks when `unacked > N`, e.g. 1–4 MiB) so the child blocks naturally on write; (b) move to a per-session `tauri::ipc::Channel` (also fixes PERF-04). **Caveat:** make `close_pty` and the exit path independent of the reader draining, or REL-01 gets worse.
- **Verify:** a stalled-consumer test with a bounded queue must show output stopping at the bound (done: `test_20` in `pty_integration_tests.rs`); integration test with a stalled emitter asserting `close_pty` still returns promptly.

### PERF-02 — Terminal output can be dropped silently (violates the no-drop requirement)
- **Performance/Reliability / Medium / Likely** (code confirmed; the trigger — a throttled hidden/minimised window or a stalled main thread — was not observed).
- **Location:** `src/services/terminalOutputBuffer.ts:12,38-43,455-478` (drop-oldest above 1,048,576 chars between flushes); `src/components/TerminalView.tsx:1062-1071` (`catch { /* Terminal disposed; drop remaining output */ }` also swallows xterm's "write data discarded" error above 50,000,000 pending chars); `ptyEarlyEvents.ts:410-416` (256 events / 1 MiB, spawn window only).
- **Root cause:** pending output is bounded by discarding the *oldest whole chunks*, which may carry mode-changing sequences (alt-screen, mouse, bracketed paste, SGR), not just text. Flushes are rAF or a 250 ms timer, both throttled in hidden pages.
- **Repro candidate:** run a chatty build (`yes`, `npm install`) in a tab, minimise for several minutes, restore; compare byte counts with `seq 1 5000000 | tee`.
- **Impact:** user — missing text and corrupted screen modes after floods; technical — the project's own rule ("do not silently drop terminal input or output") is broken by design in the overflow path. Intentional and tested (`perf_step9_regression.test.ts:211`) as an O(1) memory bound, but with no visible marker.
- **Fix (M, depends on PERF-01):** never drop while xterm is accepting data; use `term.write` callbacks for watermark flow control and pause the producer (PERF-01); at minimum count dropped chars and write a visible `[kai] N KB of output skipped` marker, and log the swallowed exception.
- **Verify:** instrument `term.write` pending bytes; end-to-end byte-count test; minimise-window soak.

### PERF-03† — cwd events are re-emitted on every read that contains an ESC
- **Performance / Medium / Confirmed (reproduced)**.
- **Location:** `src-tauri/src/pty.rs:628-654` (reader loop), `extract_osc_cwds` `:1417`.
- **Root cause:** `scan_buf` keeps the last 8,192 bytes after every scan, including already-processed complete sequences. The dedupe compares only with the *last emitted* value, so once the tail holds two different reports (A then B) every later ESC-bearing read emits A, then B again until A scrolls out. Each emit takes the global `sessions` lock (`:637`) and sends a `pty-cwd` IPC event. The in-code comment ("overlap re-scans are harmless") is incorrect.
- **Repro:** a throw-away Rust probe (a throw-away script, not kept in the repository): model loop gives `["C:/a","C:/b","C:/a","C:/b","C:/a","C:/b"]` (expected 2); live PowerShell session gives **101 events** for 2 `cd` + 5 coloured commands (expected 3), alternating forever.
- **Impact:** user — delayed or flickering cwd/git badge during coloured output (the 600 ms settler keeps resetting); technical — ~10 IPC events/s/session, a global-mutex acquisition per event, `handle.cwd` transiently stale, and a higher chance of the REL-01 interaction.
- **Fix (S):** keep only the unconsumed suffix (from the last unterminated ESC) or track the absolute end offset of the last parsed sequence.
- **Verify:** unit test feeding the reads above (one event per distinct report); rerun `probe.rs` (expect 3).

### PERF-04 — Every session's output is broadcast to every terminal window
- **Performance / Medium / Confirmed.**
- **Location:** `src-tauri/src/pty.rs:29-43` (`app_handle.emit("pty-output"|"pty-exit"|"pty-cwd")`); owner already tracked at `pty.rs:165`, `set_owner` `:866`; `terminal_windows.rs:113` already has `emit_to`.
- **Root cause:** `AppHandle::emit` reaches every webview with a listener. After commit `50f4c8c` each `main`/`term-N` window registers its own shared listener and filters by id in JS.
- **Repro:** two windows, one flooding; compare main-thread CPU/event counts in the idle window's DevTools.
- **Impact:** user — N windows each parse and discard (N−1)/N of the output; technical — cost scales ×N and amplifies PERF-01/02; also output of one window's sessions is visible to every window's JS.
- **Fix (S–M):** `emit_to(owner_label, …)` reading the owner at emit time (hand-off already switches owner under the gate) or a per-session `Channel`.
- **Verify:** event counts in the idle window before/after.

### PERF-05 — Blocking work runs on tokio worker threads; keystroke writes share the pool with 8 s git probes and an untimed PowerShell clipboard read
- **Performance / Medium / Likely** (macro behaviour traced in vendored source; saturation not measured).
- **Location:** `src-tauri/src/lib.rs:380-760` (`#[tauri::command(async)] fn …` with sync bodies); `git.rs:~614` (`run_git_bounded` up to 8 s); `clipboard.rs:41-54,316` (`Command::new("powershell")…output()` with no timeout); `tauri-macros wrapper.rs:372`.
- **Root cause:** `(async)` on a non-async fn compiles to `respond_async_serialized(async move { f(args) })`: the body runs inline on a tokio worker (default = #CPUs), not `spawn_blocking`.
- **Repro:** make N = cores `get_git_changes_cmd` calls hang (a `git` shim that sleeps) and time `write_to_pty` round-trip.
- **Impact:** user — keystrokes/resizes stall when several repos on slow/network paths are probed or the clipboard read hangs behind AV; technical — head-of-line blocking of the input path.
- **Fix (M):** `spawn_blocking` for git/clipboard/probe/scan commands, timeout on the clipboard PowerShell call, optionally a dedicated writer thread per session.
- **Verify:** the hang test above; p99 `write_to_pty` latency while 8 git probes are in flight.

### PERF-06 — Window `onResized` refits every pane on every event, with uncancelled follow-up timers
- **Performance / Medium / Needs measurement.**
- **Location:** `src/hooks/useWindowRefit.ts:185-204,247-258`; contrast `TerminalView.tsx:1198-1215` (150 ms ResizeObserver throttle that this bypasses).
- **Root cause:** each Tauri resize event runs `fit()` for all panes immediately and queues two more timers (150/500 ms) that are never cancelled; window focus and `onFocusChanged` both trigger the same pass (6 passes on focus regain, harmless because PTY resize is deduped).
- **Repro:** Performance panel while dragging the window edge with 4+ panes; count `fit()`/s and long tasks.
- **Impact:** user — possible jank during window resize with many large panes (up to 8 reflows of up to 10k lines per event); technical — redundant layout.
- **Fix (S):** trailing debounce/rAF for `onResized`, immediate pass only for focus/visibility, clear queued timers on a new signal.
- **Verify:** `fit()` calls per second during a scripted drag before/after.

### PERF-07 — Every settings-object change repaints all panes of all tabs
- **Performance / Low / Confirmed (code); cost Needs measurement.**
- **Location:** `src/components/TerminalView.tsx:616-636`; `src/hooks/useTerminalConfig.ts:48-66,178-185`.
- **Root cause:** any new `settings` identity (Settings save, each Ctrl+=/−, `loadSystemDefaults` at startup) runs `clearTextureAtlas` + full `refresh` + fit on every pane including hidden ones (up to 14 WebGL panes); `zoomFont` re-reads and re-parses settings from `localStorage` on every key press.
- **Impact:** user — hitch when toggling an unrelated setting (e.g. music); technical — atlas rebuilds.
- **Fix (S):** diff only terminal-relevant fields (font, size, line height, theme, opacity, padding, scrollback, cursor); cache the zoom base.
- **Verify:** count `clearTextureAtlas` calls when toggling an unrelated setting (expect 0).

### PERF-08 — WebGL context budget is per window, and a lost context on a visible pane is never re-attached
- **Performance / Low / Needs measurement.**
- **Location:** `src/components/TerminalView.tsx:129-133` (module singleton `hiddenGpuBudget`, 6 hidden panes), `:96-115` (context-loss fallback), `:1394-1408` (re-attach only on `visible` change); `src/components/gpuBudget.ts`.
- **Root cause:** budget = visible panes (≤8) + 6 hidden = ≤14 per window against an assumed ~16 per renderer process (the code's own comment; not verified for WebView2 multi-window). Two windows can exceed it; the DOM-renderer fallback is correct but is never retried while the pane stays visible.
- **Impact:** user — a pane silently stays on the slower DOM renderer until the tab is switched away and back; technical — contexts lost across windows.
- **Fix (S–M):** retry `attachGpuRenderer` after loss for visible panes; lower the hidden budget when several windows exist.
- **Verify:** open 2 windows × 8 panes and inspect `renderer` per pane.

### PERF-09 — Output travels as JSON text inside an evaluated script; every keystroke is one `invoke`
- **Performance / Low / Needs measurement.**
- **Location:** `tauri-2.12.2/src/event/mod.rs:194`, `webview/mod.rs:2230` (`webview.eval`); `src/services/ptyService.ts:63-65`.
- **Root cause:** Tauri's event system has no binary path; control bytes such as ESC become `\u001b` (up to ~6× inflation for escape-heavy output); input is one IPC call per `onData` (typed keys are tiny, pastes are chunked at 256 KiB).
- **Impact:** CPU on both sides of the IPC under floods; negligible for interactive typing. A `tauri::ipc::Channel` carrying bytes avoids the inflation (same change as PERF-01/04).
- **Verify:** bytes-on-the-wire / bytes-of-PTY ratio for `seq 1 1000000` and for a colour-heavy `git log --graph`.

### PERF-10 — Windows: a cold PowerShell runs on every launch just to read the User PATH
- **Performance / Low–Medium / Likely.**
- **Location:** `src-tauri/src/kai_cli.rs:381-410,531-603`; started at `lib.rs:836-846` (background thread).
- **Root cause:** `powershell -NoProfile -Command [Environment]::GetEnvironmentVariable('Path','User')` (15 s timeout) is executed even when `kai` is already installed on PATH; a registry read through `windows-sys` is essentially free.
- **Impact:** hundreds of ms of CPU during the window in which the project's own comments say a child process is a "classic Not Responding on launch trigger" (`useTerminalConfig.ts:100-106`); AV noise. See also SEC-09 for the correctness risk.
- **Fix (S):** read the registry directly (`RegGetValueW`), cache "already installed" in `~/.kai`.
- **Verify:** process-creation count during the first 5 s of launch.

### PERF-11 — First render waits for fonts (≤1.5 s) and all xterm addons are parsed before the first terminal paints
- **Performance / Low / Needs measurement.**
- **Location:** `src/main.tsx:21` (font gate), `src/components/TerminalView.tsx:11-18` (static imports of all 7 addons into the 716 kB App chunk), per-pane instantiation `:684-732`.
- **Root cause:** `document.fonts.load` for both families blocks first render up to 1.5 s (fonts are local woff2, ~89 kB effective via `unicode-range`, so usually fast); Search/Serialize/Image addons (~12–13 % of the chunk by proportion) are only needed on first search / tear-off / image output.
- **Fix (S–M):** render the shell immediately with a fallback font stack and refit on `fonts.ready` (the code already refits then); `import()` Search/Image/Serialize on first use. Trade-off: a first-keystroke race for image protocols and one small request waterfall. Size data: RES-04.
- **Verify:** WebView2 Performance trace of cold start before/after (not measured here).

### PERF-12 — cwd polling and probes (macOS/Linux)
- **Performance / Low / Likely.**
- **Location:** `pty.rs:659-678` (macOS `lsof` at most every 2 s per *busy* session), `TerminalView.tsx:1416` (`get_pty_cwd` every 5 s per visible pane, skipped when `document.hidden`).
- **Impact:** idle cost is low on Windows/Linux; on macOS up to one `lsof` per pane per 5 s (8 panes ≈ 5,700/h). Resolved structurally by ARCH-02 (OSC as single source).
- **Verify:** process-creation count with 8 visible panes on macOS.

## 4. UI responsiveness and rendering — verdict

| Topic | Verdict | Basis |
|---|---|---|
| Input→echo path | Clean: no React state per key, one awaited `invoke` per `onData`; backend writes byte-exact. Latency **not measured**. | trace |
| Tab switching | No remount; layout-effect fit/refresh/atlas rebuild before paint; hidden tabs defer PTY spawn. | `TabPanes.tsx`, tests |
| Split/resize | Dedupe + `serializeLatest`; one avoidable amplifier (PERF-06). | trace |
| Theme switching | Re-themes via CSS variables + xterm theme; full repaint of all panes (PERF-07). | trace |
| React re-renders | `TabPanes` memoised, stable callbacks from `App`; no per-output state. No hot spot found by trace; a React Profiler session is still required to rule one out. | trace |
| Large output | O(1) buffer append (the earlier O(n²) `+=` was fixed — `docs/PERF_STEP9.md` reports ~4.8 s → ~3 ms for a synthetic 10 MB JS-buffer microbenchmark, which tests the buffer only, not xterm or IPC). | `terminalOutputBuffer.ts` |
| Scrollback | 10,000 default (1,000–100,000 clamp). Derived memory ≈ (scrollback + rows) × cols × 12 B per pane (`Uint32Array(3·cols)` per line in installed xterm 6) → ≈14.4 MB at 10k×120, ≈144 MB at 100k×120; ×8 panes ≈ 1.15 GB at the maximum. *Derived, not measured.* | xterm lib |

## 5. Scalability (derived from code; no multi-pane run was performed)

| Dimension | Limit / cost | Source |
|---|---|---|
| Panes per tab | 8 (hard cap, refusal message) | `paneLayout.ts:12` |
| Tabs | unbounded in UI; each keeps a mounted xterm; persisted layout keeps 10 (FUNC-07) | `tabFactory.ts:449,529` |
| WebGL contexts | ≤14 per window; per-window budget (PERF-08) | `TerminalView.tsx:129` |
| Threads per session | 3 (reader, coalescer, waiter) → 8 panes = 24 threads; PTY integration test covers 10 concurrent sessions | `pty.rs:599,608,704`; `test_10` |
| Frontend listeners | 3 per window regardless of panes (good) | `ptyService.ts:20-57` |
| IPC under flood | ≤250 events/s × ≤98 KB per busy session, broadcast to all windows | PERF-01/04 |
| Global lock | one `sessions` mutex for create/write-lookup/resize/close; held across native resize (REL-02) and master drop (REL-01) | `pty.rs` |
| Practical ceiling | **Not measured.** The structural limits that will bite first are IPC volume (PERF-01/04) and memory from full scrollback in many panes, not thread count. Use the 1/2/4/8-pane benchmark in the test plan to find the real knee. | — |

## 6. Idle behaviour
Per the analyst timer inventory: terminal idle cost is low (5 s cwd IPC per visible pane, update check every 6 h while visible, no polling git). The two unconditional idle costs are in the **non-terminal** subsystems: the 3 s `reg.exe` call watcher (RES-01) and the 2 s synchronous `git rev-parse` in every `kai mcp` process (RES-02).
