# Architecture Audit

Repository `kai-terminal` @ `50f4c8c` (v0.2.3), audited 2026-11-23. Read-only: no source file was changed.
Companion documents: [EXECUTIVE-SUMMARY](EXECUTIVE-SUMMARY.md) · [PERFORMANCE-AUDIT](PERFORMANCE-AUDIT.md) · [RESOURCE-AND-SIZE-AUDIT](RESOURCE-AND-SIZE-AUDIT.md) · [FUNCTIONAL-GAP-AUDIT](FUNCTIONAL-GAP-AUDIT.md) · [RELIABILITY-AND-SECURITY](RELIABILITY-AND-SECURITY.md) · [TEST-AND-BENCHMARK-PLAN](TEST-AND-BENCHMARK-PLAN.md) · [IMPLEMENTATION-ROADMAP](IMPLEMENTATION-ROADMAP.md)
The raw analyst traces, probe scripts and logs were removed after the audit; every finding keeps its file:line references.

**Provenance convention.** Findings were produced by four parallel read-only analyses (Rust PTY backend, frontend, security/background work, build/CI) and the lead auditor re-read the code behind the highest-impact claims. A dagger (†) on a finding ID means the lead auditor independently re-read the cited code. Findings without † rest on the analyst's trace and, where stated, the analyst's reproduction. **Confidence** is always one of *Confirmed* (code path traced, and reproduced where noted), *Likely* (trace is solid, a runtime fact was not observed) or *Needs measurement*.

---

## 1. System map

```
┌──────────────────────────── one OS process: kai(.exe) (Tauri 2, Rust) ───────────────────────────┐
│                                                                                                  │
│  WebView (per window: label "main", "term-N", "music-pip", "shared-chat")                        │
│  ┌────────────────────────────────────────────────────────────────────────────────────────────┐ │
│  │ React 19 App (src/App.tsx)                                                                │ │
│  │   hooks/useTabs ─ tabs[] ─ panes tree (services/paneLayout) ─ TabPanes ─ TerminalView × N │ │
│  │   TerminalView: xterm.js 6 (+ WebGL/fit/search/serialize/image/unicode11/web-links)       │ │
│  │   services/ptyService ── ptyWriteQueue (ordered, ≤256 KiB chunks)  ── invoke(write_to_pty)│ │
│  │   services/terminalOutputBuffer (cap 1 Mi chars) ← ptyService shared listen("pty-output") │ │
│  │   State: React state + localStorage (settings, layout, workspaces, cmd history)           │ │
│  └───────────────▲────────────────────────────────────────┬──────────────────────────────────┘ │
│        events: pty-output / pty-exit / pty-cwd              │ invoke(): create_pty, write_to_pty,  │
│        (app_handle.emit → ALL windows, JSON in webview.eval)│ resize_pty, close_pty, pty_handoff_* │
│  ┌───────────────┴────────────────────────────────────────▼──────────────────────────────────┐ │
│  │ Rust (src-tauri/src)                                                                      │ │
│  │   lib.rs  ─ command table (~60 #[tauri::command(async)] fns, run on tokio workers)        │ │
│  │   pty.rs  ─ PtyManager { sessions: Mutex<HashMap>, per-session writer Mutex }             │ │
│  │             per session: reader thread → mpsc (unbounded) → coalescer thread (4 ms/64 KiB)│ │
│  │             → GatedEmitter(HandoffGate) → emit;   waiter thread (child.wait → cleanup)    │ │
│  │   shell.rs, login_path.rs ─ shell discovery/validation, ConPTY build gate, PATH           │ │
│  │   terminal_windows.rs ─ multi-window labels, seeds, tab hand-off                          │ │
│  │   shutdown.rs ─ bounded (1.5 s) reap on exit      job_runner.rs ─ Windows Job Object (kai run)│
│  │   ai_cli / shared_agent / integrations / kai_cli ─ supervise Node helper processes (pipes)│ │
│  │   updater.rs, git.rs, clipboard.rs, call_watch.rs, music_relay.rs, fonts.rs, …            │ │
│  └───────────────┬────────────────────────────────────────────────────────────────────────────┘ │
└──────────────────┼────────────────────────────────────────────────────────────────────────────────┘
                   │ portable-pty 0.8 (ConPTY on Windows ≥ build 17763, openpty on Unix)
                   ▼
              user's shell (pwsh / cmd / bash / zsh / WSL …)  ── foreground jobs

Separate runtime (bundled Node 22.12.0, 82.8 MB, release builds only):
  dist/cli/index.js  `kai` CLI + `kai mcp` (stdio MCP server) + indexer/retrieval + integrations
  dist/cli/shared-agent.js  E2EE shared-agent host (LAN, opt-in)
  Rust ⇄ Node over stdio pipes (integration RPC, shared agent); agents ⇄ `kai mcp` over stdio.

Persistence: webview localStorage (kai_user_settings, layout, workspaces, kai_cmd_history_v1) per window origin;
             ~/.kai/{projects/*, credentials/*, metrics.jsonl} written by the Node side;
             OS keychain / DPAPI for tokens.
```

### 1.1 Keystroke → shell (verified path)
1. xterm hidden `textarea` keydown → `attachCustomKeyEventHandler` (`src/components/TerminalView.tsx:794-859`) decides copy/paste/app shortcuts; returning `false` stops xterm processing but does **not** stop propagation (see FUNC-01).
2. `term.onData` (`TerminalView.tsx:916-997`) → ghost-input filter → `trackInputData` (command-history recorder, SEC-06) → `ptyService.writeToPty` (`src/services/ptyService.ts:190`).
3. `createPtyWriteQueue` (`src/services/ptyWriteQueue.ts`): per-session promise chain, UTF-8-safe ≤256 KiB chunks, each `await invoke("write_to_pty")`. This awaited chain is the only input-ordering/backpressure mechanism (no sequence numbers server-side).
4. `lib.rs:695 write_to_pty` (`#[tauri::command(async)]` on a sync fn → executes inline on a tokio worker) → `PtyManager::write_to_pty` (`pty.rs:742`): reject >1 MiB (never truncates) → clone per-session writer `Arc` under the global lock → write in 32 KiB syscalls, loops on partial writes, retries `Interrupted`, then `flush()`.

### 1.2 Shell → screen (verified path)
1. Reader thread blocks on a 32 KiB `read` (`pty.rs:609`), forwards a copy through an **unbounded** `std::sync::mpsc` (`pty.rs:596,620`), scans for OSC 7 / 9;9 cwd reports (`pty.rs:628-654`).
2. Coalescer thread (`coalesce_output`, `pty.rs:1580`): 4 ms window or 64 KiB soft cap, keeps incomplete UTF-8 tails, emits a `String`.
3. `GatedEmitter` (hand-off hold, 8 MiB cap) → `app_handle.emit("pty-output", {id,data})` (`pty.rs:31`): **broadcast to every window**, serialised as JSON text inside an evaluated script string (Tauri 2.12 `webview.eval`), fire-and-forget.
4. One shared `listen` per event per window (`ptyService.ts:20-57`) → id filter → `TerminalOutputBuffer.append` (1,048,576-char cap, drop-oldest) → rAF flush (250 ms timer fallback) → `term.write` in 65,536-char slices → xterm parser → WebGL (visible panes) or DOM renderer.
5. Exit: waiter thread `child.wait()` → remove session / drop master → join reader (which joins coalescer) → emit `pty-exit`. All output therefore precedes the exit event (good).

### 1.3 Session, tab, pane and window ownership
- **Tabs** (`hooks/useTabs.ts`, `services/tabFactory.ts`): array of `{id, panes tree, activePane, status…}`; every tab keeps its xterm mounted (`display:none` when hidden) so tab switches never remount (`TabPanes.tsx`). Hidden never-shown panes defer their PTY spawn.
- **Panes** (`services/paneLayout.ts`): nested split tree, geometry-only rendering, ≤8 panes/tab, min extent 0.125, drag ratio clamp 0.2–0.8.
- **PTY ownership**: backend session id ↔ pane via `backendPtyIdRef`; `initSeqRef` guards stale async spawns and reaps orphans; `PtySessionHandle.owner` records the owning window label (but output events ignore it — PERF-04).
- **Windows**: `main` plus `term-N` terminal windows (commit `50f4c8c`). A dragged-out tab moves its **live** PTY via `pty_handoff_begin → snapshot → open window → pty_handoff_finish` with a bounded hold gate (`pty.rs HandoffGate`) and frontend early-event replay.

---

## 2. Structural assessment

| Area | Verdict | Evidence |
|---|---|---|
| Layering UI → service → IPC → Rust | **Sound.** Responsibilities are separated and the invariants that matter (ordered input, early-event replay, stale-spawn guard, exit-after-output) are explicit and unit-tested. | `ptyService.ts`, `ptyWriteQueue.ts`, `ptyEarlyEvents.ts`, `pty.rs` tests |
| Unnecessary abstraction layers | **None found.** Each small module (`ptyEarlyEvents`, `serializeLatest`, `createPtySizeSync`, `terminalOutputBuffer`) exists because of a documented bug. | the tests and their bug history |
| Circular dependencies | **Not analysed** (no tool run). Suggested: `npx madge --circular --extensions ts,tsx src` (see test plan §7). | — |
| Expensive cross-layer traffic | **Yes, three:** global `emit` broadcast (PERF-04), JSON-in-eval output transport (PERF-09), no flow control (PERF-01). | `pty.rs:31`, tauri `event/mod.rs:194` |
| Lifecycle / ownership | **Mostly correct** (every exit path removes the session; foreground children die on close — measured). One lock-scope defect (REL-01) and one Unix kill gap (REL-04). | REL-01, REL-04 |
| Tight coupling | **`TerminalView.tsx` (1,592 lines)** owns spawn/adopt, key handling, output, history, cwd, GPU and search; its real key/flush paths are untested because `appShell.test.tsx` stubs it (ARCH-03). | `src/components/TerminalView.tsx` |
| State ownership across windows | **Weak.** Each window copies global settings from `localStorage` once and never listens for changes (FUNC-06); layout is saved by the first window only (FUNC-07). | `useTerminalConfig.ts`, `useSessionPersistence.ts` |

---

## 3. Findings

Format: **Category / Severity / Confidence** · **Location** · **Root cause** · **Repro** · **Impact (user / technical)** · **Fix (complexity)** · **Verify**.

### ARCH-01 — The terminal binary carries several unrelated product surfaces, each with always-on or startup costs
- **Architecture / Medium / Confirmed (facts); the recommendation is a judgement.**
- **Location:** `src/components/MusicPlayer/MusicPanel.tsx` (2,621 lines), `MusicPipWindow.tsx`, `src-tauri/src/call_watch.rs`, `music_relay.rs`; `src/core/{integrations,teams,sharedAgent,mcp*,indexer,retrieval}` (~20 k lines TypeScript); `src-tauri/src/{ai_cli,shared_agent,integrations,kai_cli}.rs`.
- **Root cause:** feature-by-feature growth inside one process. Concrete consequence found: the only consumer of the always-running call watcher is the music panel (`useCallPause`, mounted in `MusicPanel.tsx:636`), yet the watcher starts at every launch (RES-01).
- **Repro:** read `lib.rs:831` (`spawn_call_watcher` in `setup()`) and grep `useCallPause`.
- **Impact:** user — idle wake-ups and process spawns for a feature most sessions never open; technical — larger attack surface (SEC-04: music/chat windows can call `create_pty`), larger bundle, more startup work.
- **Fix (M):** do not remove features. Make each optional subsystem start lazily and stop when unused (call watcher driven by the music player's *playing* state; music relay on first use; Shared Agent only when enabled — already so). Add a short "what runs at idle" table to `ARCHITECTURE.md` and keep it in sync (see RES-01/RES-02).
- **Verify:** zero child processes spawned over 10 min idle with the music panel never opened (Process Monitor / `Get-WinEvent` process-creation count).

### ARCH-02 — Four independent mechanisms track the pane's working directory
- **Architecture / Medium / Confirmed.**
- **Location:** Rust OSC 7/9;9 scan `pty.rs:628-654` + 2 s `/proc`/`lsof` probe `pty.rs:659-678`; xterm OSC handlers `TerminalView.tsx:861-903`; frontend 5 s poll `TerminalView.tsx:1414-1428`; `cwdCommand.ts` cd-probes at 300/2500/5000 ms + 600 ms settler; `usePaneCwd.ts`.
- **Root cause:** each was added to cover a platform gap (no `cwd` probe on Windows, OSC absent in some shells). They are not coordinated, so each can disagree with the others (symlinked cwd: logical OSC vs physical `/proc`) and the Rust loop re-emits stale values (PERF-03). The git badge relies on the settler reporting *unchanged* directories, which it swallows (FUNC-04).
- **Repro:** PERF-03 probe (101 `pty-cwd` events for 2 `cd`s); FUNC-04 manual check.
- **Impact:** user — stale/flickering git badge and cwd; technical — IPC and global-lock churn.
- **Fix (M):** designate OSC as the single source of truth when a session has ever emitted one; keep probes only as fallback; fix the scan window (PERF-03) and decouple the git refresh trigger from cwd change (FUNC-04).
- **Verify:** unit test that N reads produce exactly one event per distinct report; manual `git checkout -b x` updates the footer within ~1 s.

### ARCH-03 — `TerminalView.tsx` concentrates too many responsibilities and its real behaviour is untested
- **Architecture / Medium / Confirmed.**
- **Location:** `src/components/TerminalView.tsx` (1,592 lines); stub in `src/__tests__/helpers/appStubs.ts`, used by `appShell.test.tsx:980`.
- **Root cause:** spawn/adopt/respawn, key handling, paste, output flush, GPU attach, search, hand-off, cwd and command-history all live in one component with ~30 refs. Tests either stub it (appShell) or drive only adoption (`terminalViewAdopt.test.tsx`).
- **Repro:** FUNC-01 is invisible to the suite for exactly this reason.
- **Impact:** user — regressions reach users (the latest fixes were "focus after tab change" and "import X25519 keys"); technical — high change risk.
- **Fix (M, incremental):** extract pure hooks without behaviour change in this order: `useTerminalKeyHandler`, `useOutputPump` (buffer + flush), `useCommandHistory` (or delete it, SEC-06), `useGpuRenderer`; add a jsdom test with a fake xterm that dispatches the registered key handler and then the window listener.
- **Verify:** new tests fail on the FUNC-01 double toggle before the fix.

### ARCH-04 — Dead or unreferenced code and dependencies
- **Architecture / Low / Confirmed (analyst greps; lead re-verified the first two).**
- † `getCompletions` / `completionRemainder` referenced only by tests, while `recordCommand` + `saveCommandHistory` still run on every Enter (`TerminalView.tsx:264-265`) — see SEC-06.
- † Direct `tokio = { features = ["full"] }` dependency has zero `tokio::` references in `src-tauri/src` or tests (RES-05).
- `redact_secrets` in `diagnostics.rs` unused; `interrupt_pty` is not in `generate_handler!`; `getProjectIntelligence`/`intelligence.rs` command has no UI caller (it would parse ~113 MB of project indexes on this host if wired).
- **Fix (S):** delete or wire up; remove the history recorder (SEC-06) first because it has a privacy cost. **Verify:** `cargo build`, `tsc`, full test suite unchanged.

### ARCH-05 — Two runtimes, one 83 MB sidecar
- **Architecture / Medium / Confirmed.**
- **Location:** `scripts/fetch-node.mjs` (default `22.12.0`), `src-tauri/tauri.bundled-node.conf.json`, `.github/workflows/release.yml`.
- **Root cause:** the `kai` CLI/MCP/indexer is TypeScript and ships with its own Node so installer users need nothing installed. Node is ~15× the Rust binary (RES-03) and is never auto-updated.
- **Impact:** installer size and an unpatched JS runtime executing project-derived data. Not a defect of the terminal core, but the dominant size and patching cost.
- **Fix:** see RES-03 (bump + automate now; lazy download only if size matters more than offline use).

### ARCH-06 — Smaller structural drift
- **Architecture / Low / Confirmed.**
- App version is duplicated in `package.json`, `Cargo.toml`, `tauri.conf.json` (release.yml checks equality — fine, but it is a manual three-way edit).
- `vite.config.ts` re-implements the Rust YouTube scraping for dev (documented as a mirror) — two code paths to keep in sync.
- `SECURITY.md` / `KNOWN_LIMITATIONS.md` drift from the code in six places (list in RELIABILITY-AND-SECURITY §4, SEC-15).
- **Fix (S):** derive versions from one place in CI; keep doc-drift checklist in the release guide.

---

## 4. Duplicate responsibilities, coupling and ownership — summary

| Question from the brief | Answer |
|---|---|
| Duplicate responsibilities | cwd tracking ×4 (ARCH-02); OSC parsing in Rust **and** xterm (intentional, documented); dev-only YouTube scraper mirrors Rust (ARCH-06). |
| Circular dependencies | Not analysed. |
| Unnecessary abstraction | None found. |
| Tightly coupled components | `TerminalView.tsx` (ARCH-03); `App.tsx` (666 lines) wires ~25 hooks but is readable. |
| Expensive cross-layer communication | Broadcast `emit`, JSON-in-eval, no ack (PERF-04/09/01). |
| Incorrect ownership/lifecycle | Sessions lock held across master drop (REL-01); Unix SIGHUP-only close (REL-04); output events ignore `owner` (PERF-04). |
| Dead code / unused dependencies | ARCH-04, RES-05, RES-08. |

## 5. What the architecture does well (do not "fix")
Shared per-window Tauri listeners with ref-counting; early-event replay; `initSeq` stale-spawn guards with orphan reaping; ordered chunked input with explicit rejection (never truncation) of >1 MiB; three-thread per-session model with output-before-exit ordering; bounded shutdown (`finish_within`, 1.5 s); no-remount tab switching; argv-only process spawning; hand-off protocol with rollback; Shared Agent E2EE channel design.
