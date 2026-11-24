# Functional Gap Audit

Repository `kai-terminal` @ `50f4c8c`, audited 2026-11-23. No source file was changed.
Method: every feature was traced UI → React state → `ptyService`/Tauri `invoke` → Rust → persistence. **The running app was not driven**, so UI behaviour claims are static traces; items that need a keypress to confirm say so.
Suite state at audit time: **2,703 frontend tests passed, 25 skipped, 178 files** (one worker-start timeout on `appShell.test.tsx` under load; re-run alone: 93/93 pass); **257 Rust lib tests and 19 PTY integration tests passed** (logs not kept). Passing tests do not cover the gaps below (see "Missing tests").

## 1. Feature verification matrix

| Feature | Expected | Actual (traced) | Implementation | Missing validation / edge cases | Existing tests | Missing tests |
|---|---|---|---|---|---|---|
| **Tabs: create / rename / switch / reorder** | New tab inherits cwd/shell; rename persists; Ctrl+1-9 jumps; drag reorders | Works; tab switch never remounts; hidden tabs defer PTY spawn | `hooks/useTabs.ts`, `services/tabFactory.ts`, `TabBar.tsx`, `TabPanes.tsx` | Tab count unbounded in UI while persistence keeps 10 (FUNC-07); restored hidden tabs show a spinner forever (FUNC-08) | `tabFactory`, `tabRename`, `tabDrag`, `tabTearOff`, `sessionState`, `terminalUx` | real `TerminalView` activation/focus path |
| **Tab close** | Close the tab, kill its shells, pick a sensible next tab, protect running work | Closes immediately with no confirmation; active-tab close jumps to the **last** tab; `Ctrl+Shift+W` on the last tab quits the window | `useTabs.ts:123-141`, `App.tsx:361` | FUNC-02, FUNC-03 | `sessionState` | confirmation paths (none exist) |
| **Split panes** | H/V split, nested, focus, drag-resize, min size, close, no empty layout | Works: nested tree, exact-cover fallback, 8-pane cap with refusal message, min extent 0.125, survivors keep identity, focus moves to neighbour | `services/paneLayout.ts`, `TabPanes.tsx`, `hooks/useSessionExit.ts` | PTY `MIN_COLS=10` vs pane width only coincides with current caps | `paneLayout` (19), `paneLayoutTree` (5), `paneShell`, `terminalFit` (15) | resize with real xterm + backend (no e2e, CI-04) |
| **Terminal sessions** | Create with chosen shell/cwd/env, report exit status, recover from unexpected exit, clean up | Spawn/close/exit are correct and ordered; foreground children die on close (measured); **exit code is never shown**, scrollback of a failed shell vanishes with the pane; first tab can ignore the configured shell | `pty.rs`, `shell.rs`, `useSessionExit.ts`, `TerminalView.tsx:1317` | FUNC-05, FUNC-09, FUNC-12; Unix SIGHUP-only close (REL-04) | 19 PTY integration tests (cmd.exe on Windows, not PowerShell), `ptyService`, `spawnRecovery`, `spawnSafety` | PowerShell live session, SIGHUP-ignoring shell, spurious exit event (REL-03) |
| **Copy / paste** | Ctrl+Shift+C/V, bracketed paste, multi-line safe | Works incl. CRLF→CR, bracketed-paste wrap with embedded-end stripping, key auto-repeat de-dup; multi-line paste into a shell **without** bracketed paste runs every line but the last with no warning; AltGr layouts can lose Ctrl+Alt+Shift+C/V | `TerminalView.tsx:393-406,763-825`, `terminalModes.ts:273`, `clipboardService.ts` | FUNC-10, FUNC-11 | `pasteText`, `clipboardService`, `terminalModes` | real key-handler wiring |
| **Search** | Ctrl+Shift+F opens find; palette also works | **Primary shortcut likely a no-op** (double toggle) — FUNC-01; palette/header path fine | `TerminalView.tsx:848-853`, `useAppShortcuts.ts:333`, `SearchBar.tsx` | closing via App toggle skips `clearDecorations` | `terminalUx` (label only) | real handler + window listener |
| **Command palette** | Lists actions, runs, returns focus | Works; focus returns to the element focused at open time, which may be a pane the action just hid | `CommandPalette.tsx`, `useModalBehavior.ts:95` | needs manual check (FUNC-10) | `popupMenu`, `modalBehavior` | focus after action that hides previous terminal |
| **Shortcuts** | Rebindable, conflict-aware, no AltGr collision | Strong: reserved-combo and conflict detection, legacy migration, repeat guard, AltGr guard in the app-level handler | `services/shortcuts.ts`, `useAppShortcuts.ts` | no AltGr guard in the terminal-level handler (FUNC-10) | `shortcuts*` (5 files) | key handler inside xterm |
| **Scroll / scrollback** | 10 k default, configurable | Works; clamp 1k–100k; settings input accepts out-of-range text until save | `settingsService.ts`, `SettingsModal.tsx:762` | UI validation (RES-10) | `terminalLayoutSettings` | — |
| **Themes / settings** | Persist, validate, migrate, safe defaults, light/dark consistent | `normalize` clamps everything; corrupt JSON falls back to defaults; legacy theme ids migrated; 11 themes with contrast tests. **Not synced across windows**; last writer overwrites the whole object | `settingsService.ts`, `theme/registry.ts`, `useTerminalConfig.ts` | FUNC-06 | `settingsService`, `themeRegistry`, `themeContrast`, `designTokens`, `windowOpacity` | multi-window propagation |
| **Workspaces / session restore** | Save/restore layout; never kill live work silently | Restore works; **loading a workspace replaces all live tabs (kills running shells) without a warning**; layout keeps 10 tabs, ignores secondary windows and active tab/pane | `workspaces.ts`, `useSessionPersistence.ts`, `WorkspaceModal.tsx:132` | FUNC-02, FUNC-07 | `workspaces`, `workspaceRestore`, `sessionPersistence` | >10 tabs, multi-window persistence |
| **Multi-window / tab tear-off** | Drag tab out → live shell moves with its scrollback | Protocol is sound and rolls back on failure; rough edges listed in REL-08; output broadcast to all windows (PERF-04); settings not shared (FUNC-06) | `terminal_windows.rs`, `tabHandoff.ts`, `useTabDetach.ts`, `pty.rs HandoffGate` | REL-08 | `tabHandoff`, `tabTearOff`, `extraWindow`, `terminalViewAdopt`, Rust `HandoffGate` tests | failure/rollback with real `TerminalView`; close-during-move |
| **Git badge** | Branch/dirty state of the pane cwd, current | Updates on cwd change, tab switch, focus, footer button; **not after `git checkout`/`commit` in the same folder** | `useGitStatus.ts`, `usePaneCwd.ts`, `cwdCommand.ts:135-146` | FUNC-04 | `gitCache`, `gitIntegration` | settler + `usePaneCwd` integration |
| **Error handling** | Visible, recoverable | Spawn failure: in-pane overlay with Retry and OS tip; invalid cwd → falls back to HOME/parent with a visible note (frontend) but **silently** in Rust; crash-loop guard parks the pane; init failure of IPC has a 20 s `create_pty` timeout that reaps a late session | `spawnRecovery.ts`, `ptyService.ts:157-183`, `shell.rs:639-655`, `useSessionExit.ts:18-21` | crash counter is global across panes (FUNC-09); clipboard rejections unhandled (FUNC-10) | `spawnRecovery`, `ptyService`, `startupPaint` | frontend-init failure screen |
| **Shutdown with active sessions** | Bounded, no orphans | `exit_now`: hide windows → reap on worker thread bounded by 1.5 s → `process::exit(0)`; hard-killing the host also removed the console-attached tree (measured) | `lib.rs:79`, `shutdown.rs` | detached `Start-Process` children survive tab close by design (documented) | `shutdown` unit tests, `test_15/15b` | — |

## 2. Findings

Format: **Category / Severity / Confidence** · **Location** · **Root cause** · **Repro** · **Impact (user / technical)** · **Fix (complexity)** · **Verify**.

### FUNC-01 — Ctrl+Shift+F (search) most likely toggles twice when the terminal has focus
- **Functional / Medium / Likely** (both call sites and the xterm behaviour traced; † lead re-read both handlers; *a single keypress in the real app is still needed to promote it to Confirmed*). The analyst rated it High; Medium is used here because the palette/header paths still work.
- **Location:** `src/components/TerminalView.tsx:848-853` (hard-coded toggle, returns `false`) + `src/hooks/useAppShortcuts.ts:333-334` (`case "search"`) + `App.tsx:311`; `DEFAULT_KEYBINDINGS.search = "Ctrl+Shift+F"` (`settingsService.ts:32`).
- **Root cause:** xterm's `attachCustomKeyEventHandler` returning `false` stops xterm's own handling but does not `cancel()` the event (analyst verified `_keyDown` in the installed lib), so it still bubbles to the window listener, which matches the same combo and flips `isSearchVisible` again.
- **Repro:** focus a terminal, press Ctrl+Shift+F (2 minutes).
- **Impact:** user — the documented primary search shortcut appears dead; technical — invisible to the suite because `appShell.test.tsx:980` stubs `TerminalView`.
- **Fix (S):** delete the hard-coded branch (App already owns the binding and `matchShortcut` at `:857` already returns `false`), or make the App path a no-op when the event target is inside xterm; make `handleCloseSearch` the single close path.
- **Verify:** manual keypress; jsdom test mounting the real `TerminalView` with a fake xterm that invokes the registered handler and then the window listener.

### FUNC-02 — Destructive actions have no confirmation
- **Functional / Medium / Confirmed.**
- **Location:** `src/hooks/useTabs.ts:123-141` (close tab), `App.tsx:361` + `services/shortcuts.ts:9` (label "Close tab or pane" bound to `closeActiveTab`, which closes the whole tab incl. splits), `useTabs.ts:128-131` (last tab ⇒ window quits), `src/hooks/useSessionPersistence.ts:112-127` (`restoreWorkspace` → `setTabs(restored)` unmounts every pane), `WorkspaceModal.tsx:132`. Contrast `ShellPicker.tsx:24-26`, which *does* ask before switching shell.
- **Root cause:** no "has running foreground process" signal and no `confirm`/`onCloseRequested` anywhere in `src`.
- **Repro:** start a long build, press Ctrl+Shift+W; or load a saved workspace while shells are busy.
- **Impact:** user — loses builds, ssh sessions, AI-agent sessions in one keystroke; technical — inconsistent with the shell-switch confirmation and with `restorePrevious`, which preserves live tabs once the user has started working.
- **Fix (M):** add a cheap busy signal (backend query of the foreground child, or "pane connected and not at an idle prompt") and confirm for close-tab-with-busy-pane, multi-pane tab, last tab/window, and workspace load. Smallest useful first step: confirm workspace load and multi-pane tab close.
- **Verify:** unit tests on `closeTab`/`restoreWorkspace` + manual.

### FUNC-03 — Closing the active tab jumps to the last tab, not a neighbour
- **Functional / Low / Confirmed.** `useTabs.ts:135-139` selects `remaining[remaining.length-1]`; the session-exit path (`useSessionExit.ts:153-157`) selects the previous neighbour. **Impact:** surprising with many tabs; **Fix (S):** one shared helper (same index or most-recently-used); **Verify:** unit test on both paths.

### FUNC-04 — Git branch/dirty badge goes stale after git commands run in the same folder
- **Functional / Low–Medium / Likely.**
- **Location:** `services/cwdCommand.ts:135-146` (`createCwdSettler.push` delivers only the first or a *changed* path), `hooks/usePaneCwd.ts:174-193` (comments assume unchanged reports refresh the badge), `hooks/useGitStatus.ts:103-136`.
- **Root cause:** every backstop (OSC 7 per prompt, 5 s poll, focus, cd probes) reports the same directory, which the settler swallows, so the unchanged-dir refresh branch is unreachable in practice.
- **Repro:** `git checkout -b t` / `git commit` and watch the footer.
- **Impact:** user — wrong branch/dirty state until a tab switch, focus change (30 s cache TTL) or the refresh button.
- **Fix (S):** throttled `refreshBadge` (≤1 probe per 2–3 s for the active pane) on submitted command or prompt OSC, independent of the settler; also add `--no-optional-locks` (SEC-10).
- **Verify:** manual; integration test settler + `usePaneCwd`.

### FUNC-05 — The first tab can spawn with the backend default shell, ignoring the configured shell and `skipShellProfile`
- **Functional / Medium / Likely** (depends on IPC timing).
- **Location:** `hooks/useTabs.ts:49-55`, `hooks/useTerminalConfig.ts:76-92` (async `get_available_shells`), `TerminalView.tsx:517,1317-1320` (fixed 60 ms spawn timer), `App.tsx:275-284` (footer shows the *configured* shell).
- **Root cause:** nothing awaits the shell list on the first-spawn path; if it has not resolved, `selectedShell` is undefined and `create_pty` receives no shell path/args.
- **Repro:** set a non-default shell or `skipShellProfile`, cold start with an artificial 200 ms delay on `get_available_shells`, compare the first tab's process with the footer.
- **Impact:** user — wrong shell and slow PowerShell profile on tab 1 while the footer claims otherwise; technical — UI/reality divergence.
- **Fix (S–M):** make the first spawn wait (bounded ≤500 ms) for the shell list, or re-resolve while still connecting.
- **Verify:** log shell path at first `create_pty` under the delay.

### FUNC-06 — Settings are not synchronised between windows
- **Functional / Medium / Confirmed (absence).**
- **Location:** `settingsService.ts:199,412-429` (`localStorage["kai_user_settings"]`), `useTerminalConfig.ts:38-40`; no `storage` listener anywhere in `src` (grep).
- **Impact:** a theme/font/shortcut change in window A is not applied in window B until restart, and a later save from B overwrites A's change wholesale (`saveSettings(next)` writes the full object). New with multi-window (`50f4c8c`).
- **Fix (S–M):** listen to `storage` or the existing `emit_to_terminal_windows` (`terminal_windows.rs:113`), merge/normalise on receipt, make saves field-wise.
- **Verify:** two-window test changing theme in one.

### FUNC-07 — Session persistence gaps
- **Functional / Low–Medium / Confirmed.**
- **Location:** `tabFactory.ts:529` (`slice(0, MAX_PERSISTED_TABS=10)`), `App.tsx:247` / `useSessionPersistence.ts:63-67,89-93` (only the first window saves; active tab/pane not saved; save runs on every `tabs` change, not debounced).
- **Impact:** an 11th tab disappears after restart with no notice; a dragged-out tab or a secondary window is never persisted; restart always activates tab 0.
- **Fix (M):** window-keyed layout or a union across windows, warn or raise the cap, debounce (~500 ms), store `activeTabId`.
- **Verify:** restart test with 12 tabs and a torn-off tab.

### FUNC-08 — Restored hidden tabs show a spinner forever until first shown
- **Functional / Low / Confirmed.** `tabFactory.ts:608-619` sets status `connecting`; hidden panes never spawn, so `TabBar.tsx:70-71,526` runs a CSS spinner for each (10 restored tabs ⇒ 9 permanent animations; tooltip says "starting"). **Fix (S):** distinct "not started" status. **Verify:** snapshot test of restored tabs; no animated icons.

### FUNC-09 — Session-exit policy: exit status is never shown, failure output is lost, the crash counter is global
- **Functional / Low–Medium / Confirmed.**
- **Location:** `useSessionExit.ts:76-161,59` (`exitTimesRef`).
- **Impact:** any exit closes the pane/tab, so the error that killed a shell disappears and the exit code is never displayed ("press any key to restart" does not exist); 3 non-clean exits within 10 s *anywhere* (e.g. three `exit` after failed commands, `wsl --shutdown`) park the third pane with "Shell keeps exiting immediately", which is misleading.
- **Fix (M):** keep a dead pane showing the status when code ≠ 0 with a Restart action; make the counter per pane.
- **Verify:** unit tests on `useSessionExit` with interleaved panes.

### FUNC-10 — Keyboard and clipboard edge cases in the terminal key handler
- **Functional / Low / Likely.**
- **Location:** `TerminalView.tsx:794-859` (no AltGraph guard; app-level handler has one at `useAppShortcuts.ts:278`), `:802,424`, `App.tsx:411` (clipboard errors swallowed/unhandled), `useModalBehavior.ts:95` (palette returns focus to a pane the action may have hidden).
- **Impact:** on layouts where AltGr+Shift+C/V types a character the key is swallowed; `navigator.clipboard.readText()` fallback can prompt; an unhandled rejection if copy is denied.
- **Fix (S):** `if (event.getModifierState?.("AltGraph")) return true;` at the top; catch clipboard failures with a backend fallback; confirm focus return manually.
- **Verify:** AltGr keyboard-layout test; deny clipboard permission.

### FUNC-11 — Terminal features that are absent, with the user problem each would solve
- **Functional / Low / Confirmed.** (Listed only where a concrete user problem exists, not for parity.)
  - No OSC 52 → remote/tmux/vim yanks cannot reach the local clipboard.
  - No OSC 0/2 title → tabs are always "Terminal N", so many tabs are indistinguishable (rename exists).
  - No bell handling → long-running command completion cannot signal.
  - No terminal context menu → copy/paste/clear/split only by shortcut; a native WebView menu appears instead.
  - No `macOptionIsMeta` → Option+B/F word movement on macOS.
  - No `windowsPty` option → xterm cannot match ConPTY reflow behaviour (effect unmeasured; build here is ≥21376 so the default reflow stays on).
  - Multi-line paste without bracketed paste executes lines silently.
- **Fix:** each S–M, opt-in. **Verify:** per feature manual test.

### FUNC-12 — Spawn-time cwd/shell validation quirks
- **Functional / Low / Confirmed.** `shell.rs:639-655`: a missing cwd is silently replaced by its parent (a file path by its parent directory) and the user is only told by the frontend path for HOME fallback; `shell.rs:567-575`: on Windows `validate_and_resolve_shell` accepts any existing path including a directory (the `is_executable` check is `cfg(not(windows))`), producing `PtyCreationFailed` (handled). **Fix (S):** surface the substitution in the session info shown in the UI; check `is_file()` on Windows. **Verify:** unit tests.

### FUNC-13 — Tab-strip drag and menu details
- **Functional / Low / Likely.** Tear-off zone starts 48 px below the strip (`TabBar.tsx:96,103-114`): releasing there opens a new window without confirmation (Esc cancels); tab context menu has no arrow-key navigation; drag uses window-level pointer listeners without pointer capture (touch/pen path unverified). **Fix (S).** **Verify:** manual with mouse/touch.

*Also functional but classified elsewhere:* hand-off rough edges (REL-08), listener-before-spawn ordering (REL-09), typed-line recording (SEC-06), output drops (PERF-02).

## 3. Missing-functionality classification

**A. Critical missing functionality** (things whose absence can lose user work or violate a stated requirement)
1. Running-process protection on close/restore (FUNC-02) — *problem:* one keystroke kills hours of build/agent state.
2. Output flow control and no-silent-drop guarantee (PERF-01/02) — *problem:* floods can corrupt screen state or exhaust memory.
3. Per-window ACL for app commands (SEC-04) — *problem:* a compromise of the third-party-iframe windows (music/chat) is arbitrary process execution.
4. Update integrity verification (SEC-02) — *problem:* an installer is executed with only TLS as proof.

**B. Important usability improvements**
FUNC-01 (search shortcut), FUNC-04 (stale git badge), FUNC-05 (first-tab shell), FUNC-06 (settings sync), FUNC-07 (persistence), FUNC-09 (exit status visible/restart), FUNC-03.

**C. Reliability improvements**
REL-01 (lock scope), REL-04 (Unix kill escalation), REL-07 (login-shell startup hang), REL-08/09 (hand-off, listener order), PERF-03 (cwd event storm), RES-01/02 (background polling).

**D. Optional future enhancements**
FUNC-11 items (OSC 52, titles, bell, context menu, `macOptionIsMeta`), FUNC-13, FUNC-08 (cosmetic).

## 4. Missing tests for important workflows (consolidated)
1. Real `TerminalView` key-handler wiring and its interplay with `useAppShortcuts` (why FUNC-01 is invisible).
2. End-to-end output flush: rAF/timer flush, hidden-tab buffering, exit-flush ordering, 50 MB xterm discard, cap-induced loss.
3. Listener registration order vs spawn; double `handleExit`; respawn/Retry/`resetKey` with a real component.
4. `useWindowRefit` (zero tests), resize debounce and PTY resize call counts.
5. GPU attach/detach/context-loss with the real component.
6. Close/restore confirmation paths; `closeTab` neighbour selection.
7. Multi-window settings sync; persistence with >10 tabs; hand-off failure/rollback and close-during-move.
8. Git badge refresh after in-place git commands.
9. `SearchBar` with a real `SearchAddon`.
10. Command-history privacy (what is recorded) and multi-pane overwrite.
11. First-tab shell-selection race.
12. Palette focus return after actions that hide the previous terminal.
Backend gaps (Rust): cwd dedupe across reads, slow-`Drop` master, backpressure, multi-window event targeting, live PowerShell, exit-event semantics, SIGHUP-ignoring shell, EINTR, invalid-UTF-8-then-split — see TEST-AND-BENCHMARK-PLAN §5.
