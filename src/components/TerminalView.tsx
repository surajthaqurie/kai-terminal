import {
  useEffect,
  useLayoutEffect,
  useRef,
  useImperativeHandle,
  forwardRef,
  useState,
  Suspense,
  lazy,
} from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type { SerializeAddon } from "@xterm/addon-serialize";
import {
  createLazyAddonSlot,
  loadImageAddon,
  loadSerializeAddon,
  type LazyAddonSlot,
} from "../services/xtermLazyAddons";
import { useTerminalSearch } from "../hooks/useTerminalSearch";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import type { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import { canFitPane, createPtySizeSync, serializeLatest, type PtySizeSync } from "./terminalFit";
import {
  GPU_REATTACH_DELAYS_MS,
  attachGpuRenderer,
  detachGpuRenderer,
  hiddenGpuBudget,
} from "./gpuRenderer";
import { ptyService, PtyService } from "../services/ptyService";
import { boundedSnapshot } from "../services/handoffSnapshot";
import { replayHandoff, spawnPaneShell } from "../services/paneSpawn";
import {
  claimPtyId,
  createEarlyPtyEvents,
  releasePtyId,
  type EarlyPtyEvent,
  type EarlyPtyEvents,
} from "../services/ptyEarlyEvents";
import {
  LISTENERS_WAIT_MS,
  SHELL_LIST_WAIT_MS,
  awaitBounded,
  waitUntil,
} from "../services/startupGate";
import { createTerminalKeyHandler, type TerminalKeyHandler } from "../services/terminalKeyHandler";
import { PaneAdoption, ShellProfile, SessionStatus, UserSettings } from "../types/terminal";
import { handoffFinish, type HandoffRelease } from "../services/terminalWindows";
import type { HandoffTerminal, PaneCapture } from "../services/tabHandoff";
import { SettingsService, DEFAULT_SETTINGS } from "../services/settingsService";
import { detectHostOs, launchFailureTip } from "./launchFailure";
import { createTerminalOutputPipeline } from "../services/terminalOutputPipeline";
import {
  diffAppearance,
  terminalAppearance,
  type TerminalAppearance,
} from "../services/terminalAppearance";
import {
  copyTextToClipboard,
  readAttachmentPasteText,
  readPasteContent,
} from "../services/clipboardService";
import { guardLinkClicks, isOpenLinkClick, openTerminalLink } from "../services/terminalLinks";
import { CODE_MODE_OSC, parseCodeModeSignal } from "../core/codeModeSignal";
import { TEAMS_OSC, parseTeamsSignal } from "../core/teamsSignal";
import { createPaneCwdTracker, type PaneCwdTracker } from "../services/paneCwdTracker";
import { TERMINAL_MODE_RESET_SEQ, scanAgentFinishedTail } from "../services/terminalModes";
import {
  STALE_REPLY_WINDOW_MS,
  preparePasteText,
  shouldAutoResetModes,
  stripStaleTerminalReplies,
  stripStuckInputReports,
} from "../services/terminalModes";
// Search UI only mounts on first toggle (Ctrl+Shift+F), so it stays out of
// the per-pane startup path.
const SearchBar = lazy(() => import("./SearchBar").then((m) => ({ default: m.SearchBar })));

/** A pane hidden longer than this gets an extra re-fit + repaint after it is shown again. */
const ATLAS_REBUILD_AFTER_HIDDEN_MS = 5_000;

export interface TerminalViewRef extends HandoffTerminal {
  clear: () => void;
  copySelection: () => Promise<string>;
  pasteText: (text: string) => void;
  focus: () => void;
  toggleSearch: () => void;
  /**
   * Re-fit the xterm viewport to its container and push the real cols/rows
   * to the backend PTY. Called when the OS window is restored / refocused /
   * resized: a terminal that was laid out while hidden (or while the
   * window was minimized) otherwise keeps a 0-size viewport and paints
   * blank until the next tab switch — the "reopen shows blank" bug.
   */
  refit: () => void;
}

interface TerminalViewProps {
  sessionId: string;
  selectedShell?: ShellProfile;
  /** False while the shell list is still loading; a new shell then waits briefly for it. Default true. */
  shellsReady?: boolean;
  cwd?: string;
  settings?: UserSettings;
  /**
   * Whether this pane's tab is currently visible. Hidden tabs defer PTY
   * spawn until first shown, so restoring 10 tabs at startup costs one PTY
   * instead of ten (startup hang fix). Defaults to true.
   */
  visible?: boolean;
  /**
   * Spawn generation: when incremented, the pane re-spawns its backend PTY
   * (used by the crash-loop Retry banner). Changing this never remounts
   * the xterm instance or the pane id, so split layouts survive retries.
   */
  resetKey?: number;
  /**
   * A shell already running in another window (a tab dragged here): attach to it
   * and redraw its screen instead of starting a new one. Read once, on mount.
   */
  adopt?: PaneAdoption;
  onSessionStatusChange?: (status: SessionStatus, message?: string) => void;
  /** `undefined` when the shell's exit status could not be determined. */
  onExit?: (exitCode?: number) => void;
  onCwdResolved?: (cwd: string) => void;
  onFocus?: () => void;
  /**
   * Code Mode of THIS terminal only: the project path when an agent started
   * by `kai <agent>` announces itself on this pane's output (see
   * `core/codeModeSignal`), `null` when it ends, the shell restarts, or the
   * pane closes. Other panes and tabs are never affected.
   */
  onCodeModeChange?: (project: string | null) => void;
  /**
   * Unread Teams messages when `kai teams` runs in THIS terminal (see
   * `core/teamsSignal`); 0 when it closes, the shell restarts, or the pane closes.
   */
  onTeamsUnreadChange?: (count: number) => void;
}

export const TerminalView = forwardRef<TerminalViewRef, TerminalViewProps>(
  (
    {
      sessionId,
      selectedShell,
      shellsReady = true,
      cwd,
      settings = DEFAULT_SETTINGS,
      visible = true,
      resetKey = 0,
      adopt,
      onSessionStatusChange,
      onExit,
      onCwdResolved,
      onFocus,
      onCodeModeChange,
      onTeamsUnreadChange,
    },
    ref
  ) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const xtermRef = useRef<Terminal | null>(null);
    const fitAddonRef = useRef<FitAddon | null>(null);
    const webglAddonRef = useRef<WebglAddon | null>(null);
    // The key handler below is attached once per terminal; it reads the
    // remapped copy / paste / zoom / terminal-local keys through this ref so a
    // Settings change applies to open panes without re-creating them.
    const fixedKeysRef = useRef(settings.fixedKeybindings);
    fixedKeysRef.current = settings.fixedKeybindings;
    const keybindingsRef = useRef(settings.keybindings);
    keybindingsRef.current = settings.keybindings;
    // Backend PTY session id returned by create_pty (UUID). This is distinct
    // from the frontend tab id (`sessionId`): all IPC read/write/resize/close
    // calls and output filtering MUST use the backend id, otherwise writes
    // hit SessionNotFound and output is dropped / leaks across tabs.
    const backendPtyIdRef = useRef<string | null>(null);
    const initSeqRef = useRef<number>(0);
    // Moving a tab between windows (see services/tabHandoff): the shell to attach
    // to on mount, the session this pane is attaching to (so closing the pane
    // mid-attach still ends it), the serializer that snapshots the screen, and the
    // writer for output that was held during a move that did not happen.
    const adoptRef = useRef(adopt);
    const pendingAdoptIdRef = useRef<string | null>(null);
    // Bumped when the terminal is torn down, so the image add-on finishing its load afterwards is
    // dropped. Search and Serialize have their own slots that do the same (`createLazyAddonSlot`).
    const lazyAddonEpochRef = useRef(0);
    // The serializer that snapshots the screen for a tab moved to another window, loaded on first use.
    const serializeSlotRef = useRef<LazyAddonSlot<SerializeAddon> | null>(null);
    serializeSlotRef.current ??= createLazyAddonSlot<SerializeAddon>(
      loadSerializeAddon,
      () => xtermRef.current
    );
    const serializeSlot = serializeSlotRef.current;
    // Find-in-terminal: the bar, the match count and the lazily loaded search add-on.
    const terminalSearch = useTerminalSearch(() => xtermRef.current, settings.theme);

    const resumeHeldRef = useRef<(released: HandoffRelease) => void>(() => {});
    // Last PTY spawn failure for this pane. When set, an in-pane overlay
    // offers Retry (re-spawn) so a bad shell binary / cwd never leaves the
    // user staring at a dead pane with "use the + button" as the only fix.
    const [launchError, setLaunchError] = useState<string | null>(null);

    // ---- Command line tracking (in memory only) --------------------------
    // Native shell autocompletion (ZSH autosuggestions, compinit,
    // bash-completion) is owned by the shell over the PTY. We do not inject
    // popup overlays over the buffer so Tab, arrow keys, and ghost text
    // behave identically to native terminals.
    //
    // The line buffer exists only so an Enter can be checked for "this line
    // probably changes the directory" (see `lineLikelyChangesCwd`). It is never
    // persisted: it cannot tell a password typed at a no-echo prompt, or text
    // typed into a TUI, from a command, so recording it (as an earlier version
    // did, in localStorage) stored secrets at rest.
    const lineBufferRef = useRef("");

    const trackInputData = (data: string) => {
      // Enter or multiline chunk/paste: keep only the unfinished last line.
      if (data.includes("\r") || data.includes("\n")) {
        const full = lineBufferRef.current + data;
        const parts = full.split(/\r\n|\r|\n/);
        lineBufferRef.current = (parts[parts.length - 1] || "").slice(-4096);
        return;
      }
      // Ctrl+C / Ctrl+U cancel the line.
      if (data === "\x03" || data === "\x15") {
        lineBufferRef.current = "";
        return;
      }
      // Ctrl+W deletes the last word.
      if (data === "\x17") {
        lineBufferRef.current = lineBufferRef.current.replace(/[^ \t\n]+\s*$/, "");
        return;
      }
      // Backspace / DEL.
      if (data === "\x7f" || data === "\b") {
        lineBufferRef.current = lineBufferRef.current.slice(0, -1);
        return;
      }
      // Escape sequences (arrows, alt combos): don't corrupt the buffer.
      if (data.startsWith("\x1b")) return;
      // Other control chars: ignore for buffer tracking.
      // eslint-disable-next-line no-control-regex -- control characters are matched on purpose, to strip or reject them
      if (/[\x00-\x1f]/.test(data)) return;
      lineBufferRef.current = (lineBufferRef.current + data).slice(-4096);
    };
    // ----------------------------------------------------------------------

    // The pty-output/pty-exit listeners are registered once per pane
    // (effect deps `[sessionId]`), so they must go through refs to always
    // call the LATEST callbacks/props. Otherwise `exit` fires a stale
    // `onExit` closure with a stale `tabs` snapshot and the pane/tab never
    // closes.
    const onExitRef = useRef(onExit);
    onExitRef.current = onExit;
    const onStatusRef = useRef(onSessionStatusChange);
    onStatusRef.current = onSessionStatusChange;
    const onCwdResolvedRef = useRef(onCwdResolved);
    onCwdResolvedRef.current = onCwdResolved;
    // Working-directory tracking: every source (spawn reply, `pty-cwd` events, shell folder
    // reports, focus, probes after `cd`, the poll) goes through one settler whose delivery is
    // the only path to the app. Created once per pane; see `paneCwdTracker`.
    const cwdTrackerRef = useRef<PaneCwdTracker | null>(null);
    if (!cwdTrackerRef.current) {
      cwdTrackerRef.current = createPaneCwdTracker({
        ptyId: () => backendPtyIdRef.current,
        readCwd: (id) => PtyService.getPtyCwd(id),
        deliver: (p) => onCwdResolvedRef.current?.(p),
      });
    }
    const cwdTracker = cwdTrackerRef.current;
    const onCodeModeChangeRef = useRef(onCodeModeChange);
    onCodeModeChangeRef.current = onCodeModeChange;
    const onTeamsUnreadChangeRef = useRef(onTeamsUnreadChange);
    onTeamsUnreadChangeRef.current = onTeamsUnreadChange;
    const onFocusRef = useRef(onFocus);
    onFocusRef.current = onFocus;
    const shellRef = useRef(selectedShell);
    shellRef.current = selectedShell;
    // True once the app has the shell list (or knows it cannot get one).
    const shellsReadyRef = useRef(shellsReady);
    shellsReadyRef.current = shellsReady;
    const listenersReadyRef = useRef<Promise<unknown> | undefined>(undefined);
    const cwdRef = useRef(cwd);
    cwdRef.current = cwd;
    const visibleRef = useRef(visible);
    visibleRef.current = visible;
    // Winning the WebGL renderer back after a context loss while this pane is on screen.
    const gpuRetryRef = useRef<{ attempt: number; timer: ReturnType<typeof setTimeout> | null }>({
      attempt: 0,
      timer: null,
    });
    const attachGpu = (term: Terminal) => {
      attachGpuRenderer(term, webglAddonRef, () => {
        // Lost: the pane runs on the DOM renderer now. A hidden pane waits until it is shown
        // (the visibility effect attaches again); a visible one retries on a short backoff.
        if (!visibleRef.current) return;
        const retry = gpuRetryRef.current;
        const delay = GPU_REATTACH_DELAYS_MS[retry.attempt];
        if (delay === undefined) return;
        retry.attempt += 1;
        if (retry.timer !== null) clearTimeout(retry.timer);
        retry.timer = setTimeout(() => {
          retry.timer = null;
          if (visibleRef.current && xtermRef.current === term) attachGpu(term);
        }, delay);
      });
    };
    const cancelGpuRetry = () => {
      const retry = gpuRetryRef.current;
      if (retry.timer !== null) clearTimeout(retry.timer);
      retry.timer = null;
    };
    // Remembers the grid the PTY has, so no-op resizes are skipped (a tab flip
    // re-fits to the same grid, and a ConPTY resize forces a reflow).
    const ptySizeSyncRef = useRef<PtySizeSync | null>(null);
    ptySizeSyncRef.current ??= createPtySizeSync(
      serializeLatest((id: string, cols: number, rows: number) =>
        ptyService.resizePty(id, cols, rows)
      )
    );
    const pushPtySize = (term: Terminal) =>
      ptySizeSyncRef.current?.push(backendPtyIdRef.current, term.cols, term.rows);
    // PTY events that arrive while `create_pty` is still in flight: the pane has
    // no session id yet, so they are held and replayed once it does (see
    // `ptyEarlyEvents`). `replayEarlyEventsRef` is owned by the mount effect,
    // which holds the output buffer and exit handling they must flow through.
    const spawningRef = useRef(false);
    const earlyEventsRef = useRef<EarlyPtyEvents | null>(null);
    earlyEventsRef.current ??= createEarlyPtyEvents();
    const replayEarlyEventsRef = useRef<(events: EarlyPtyEvent[]) => void>(() => {});
    /**
     * Fits xterm to its container, but only while the pane is really on screen
     * (see `canFitPane`). Returns whether a fit ran, so callers only resize the
     * PTY when it did.
     */
    const fitWhenShown = (): boolean => {
      const fitAddon = fitAddonRef.current;
      if (!fitAddon || !canFitPane(visibleRef.current, containerRef.current)) return false;
      fitAddon.fit();
      return true;
    };
    // Tracks whether the initial PTY spawn has been scheduled, so tab
    // switches don't re-spawn a live session.
    const initialLaunchScheduledRef = useRef(false);
    // Pending-output flusher owned by the mount effect (see `flushOutput`
    // there; it is a closure over that chunk's buffer). Synced via ref so the
    // show-time LAYOUT effect below can drain output that arrived while the
    // tab was hidden BEFORE the browser paints it — otherwise the first paint
    // shows the tab without those lines and they pop in a beat later.
    const flushPendingRef = useRef<() => void>(() => {});
    // Cross-chunk tail for AGENT_FINISHED_MARKER detection (the marker can
    // straddle two PTY output events). Bounded to the marker length.
    const agentFinishedTailRef = useRef("");
    // Ghost-typing auto-reset policy state: consecutive stripped input
    // reports on the normal buffer, plus whether the agent-finished marker
    // proved the TUI is gone (immediate reset). Both reset on every PTY
    // (re)spawn and whenever the alternate screen takes over (fresh TUI).
    const stuckReportCountRef = useRef(0);
    const agentFinishedSeenRef = useRef(false);
    // Epoch ms until which leftover terminal query replies (DA/CPR/OSC colour)
    // are dropped; opened when the agent-finished marker is seen.
    const staleReplyUntilRef = useRef(0);

    // Single writer for every paste route (key combo, toolbar button, native
    // paste event from the context menu / middle-click). Keeps history
    // tracking and the no-auto-Enter rule (preparePasteText) in one place.
    // Any size is delivered: writeToPty chunks the (already bracketed) paste
    // under the backend's per-call bound and sends the chunks in order, so the
    // ESC[200~ / ESC[201~ markers wrap the whole paste, not each chunk. A
    // failed chunk stops the rest and rejects once (one message below).
    const pasteToPty = (text: string) => {
      const backendId = backendPtyIdRef.current;
      const term = xtermRef.current;
      if (!text || !backendId || !term) return;

      // Pasted text updates the in-memory line buffer (cd detection only).
      trackInputData(text.replace(/[\r\n]+$/, ""));
      PtyService.writeToPty(backendId, preparePasteText(text, term.modes.bracketedPasteMode)).catch(
        (e: unknown) => {
          const msg = e instanceof Error ? e.message : String(e);
          term.writeln(`\r\n\x1b[31m[Paste failed: ${msg}]\x1b[0m\r\n`);
        }
      );
    };

    useImperativeHandle(ref, () => ({
      clear: () => {
        xtermRef.current?.clear();
      },
      refit: () => {
        const term = xtermRef.current;
        if (!term) return;
        try {
          if (fitWhenShown()) pushPtySize(term);
        } catch {
          // ignore hidden-tab layout errors
        }
      },
      copySelection: async () => {
        const selection = xtermRef.current?.getSelection();
        if (!selection) return "";
        // Same copy as the keyboard path: falls back when the clipboard API is denied, and never
        // rejects (the command palette does not await actions). "" when nothing was copied.
        return (await copyTextToClipboard(selection)) ? selection : "";
      },
      pasteText: (text: string) => pasteToPty(text),
      focus: () => {
        xtermRef.current?.focus();
      },
      toggleSearch: () => terminalSearch.toggle(),
      handoffSessionId: () => backendPtyIdRef.current,
      handoffCapture: async (): Promise<PaneCapture | null> => {
        const id = backendPtyIdRef.current;
        const term = xtermRef.current;
        if (!id || !term) return null;
        try {
          const serializer = await serializeSlot.ensure();
          if (!serializer) return null;
          // Everything received so far must be on screen before it is serialized.
          flushPendingRef.current();
          await Promise.race([
            new Promise<void>((resolve) => term.write("", resolve)),
            new Promise<void>((resolve) => setTimeout(resolve, 500)),
          ]);
          const snapshot = boundedSnapshot(
            (rows) => serializer.serialize({ scrollback: rows }),
            term.options.scrollback ?? 1000
          );
          return { ptyId: id, snapshot, cols: term.cols, rows: term.rows };
        } catch {
          return null;
        }
      },
      handoffRelease: () => {
        // The new window owns the session now: forget it WITHOUT closing it.
        releasePtyId(backendPtyIdRef.current);
        backendPtyIdRef.current = null;
        onCodeModeChangeRef.current?.(null);
        onTeamsUnreadChangeRef.current?.(0);
      },
      handoffResume: (released: HandoffRelease) => resumeHeldRef.current(released),
    }));

    // ---- Shared by starting a shell and attaching to a moved one ---------------------------
    /** The pane's session is `id`, running at the grid it was started at: make it live. */
    const markLive = (id: string, cols: number, rows: number) => {
      backendPtyIdRef.current = id;
      claimPtyId(id);
      // The shell runs at the grid measured BEFORE the async start. No backend id existed while
      // it ran, so any resize in that window (window maximize/restore at startup, web fonts
      // landing, a split) was dropped by `pushPtySize` and the shell would keep a stale, smaller
      // grid until the next manual resize. Re-fit now and send the difference.
      ptySizeSyncRef.current?.spawned(id, cols, rows);
      const term = xtermRef.current;
      try {
        if (term && fitWhenShown()) pushPtySize(term);
      } catch {
        // Ignore fit errors during hidden-tab layout.
      }
      setLaunchError(null);
      onStatusRef.current?.("connected");
    };
    /**
     * The session's events that arrived before the pane knew its id (its first prompt, or its
     * exit) go through the normal handlers now: after "connected", so an instant exit still
     * ends in "disconnected".
     */
    const replayHeld = (id: string) => {
      spawningRef.current = false;
      replayEarlyEventsRef.current(earlyEventsRef.current?.take(id) ?? []);
    };
    /** A launch failed: the overlay offers Retry, the scrollback gets one dim line. */
    const launchFailed = (seq: number, err: unknown, line: string) => {
      if (seq !== initSeqRef.current) return;
      const errorMsg = err instanceof Error ? err.message : String(err);
      setLaunchError(errorMsg);
      xtermRef.current?.writeln(`\r\n\x1b[2m${line}\x1b[0m`);
      onStatusRef.current?.("error", errorMsg);
    };
    /** A newer launch owns the early-event buffer once it has started. */
    const endLaunch = (seq: number) => {
      if (seq !== initSeqRef.current) return;
      spawningRef.current = false;
      earlyEventsRef.current?.clear();
    };

    const initPtySession = async (overrideShell?: ShellProfile) => {
      const term = xtermRef.current;
      const fitAddon = fitAddonRef.current;
      if (!term || !fitAddon) return;
      const mySeq = ++initSeqRef.current;

      // Best-effort close of the previous backend session for this tab
      // before spawning a replacement (prevents orphan PTY processes).
      // A moved shell this pane failed to attach to counts too: Retry starts a new shell, and the
      // moved one would otherwise keep running with no window showing it (REL-08).
      const previousId = backendPtyIdRef.current ?? pendingAdoptIdRef.current;
      backendPtyIdRef.current = null;
      pendingAdoptIdRef.current = null;
      releasePtyId(previousId);
      if (previousId) {
        try {
          await PtyService.closePty(previousId);
        } catch {
          // Already reaped by backend reader thread; safe to ignore.
        }
      }
      if (mySeq !== initSeqRef.current) return;

      // A fresh shell cannot still be running the previous shell's agent.
      onCodeModeChangeRef.current?.(null);
      onTeamsUnreadChangeRef.current?.(0);
      term.clear();
      onStatusRef.current?.("connecting");
      // Fresh PTY, fresh input modes: the xterm instance is REUSED across
      // respawns (Retry banner, crash recovery), so a previous TUI's stuck
      // mouse/focus/bracketed-paste modes would otherwise survive into the
      // new shell and ghost-type from the first mouse move. Screen-safe
      // (modes only) and idempotent — also clears the stuck-report policy
      // state so the new session starts unpenalized.
      stuckReportCountRef.current = 0;
      agentFinishedSeenRef.current = false;
      staleReplyUntilRef.current = 0;
      agentFinishedTailRef.current = "";
      try {
        term.write(TERMINAL_MODE_RESET_SEQ);
      } catch {
        // Emulator gone; the fresh backend has no stuck modes to inherit.
      }

      try {
        fitWhenShown();
      } catch {
        // Ignore fit errors during hidden-tab layout.
      }
      const cols = term.cols || 80;
      const rows = term.rows || 24;

      // The configured shell may still be loading on a cold start: starting now would spawn
      // the backend default while the footer shows the configured one (FUNC-05).
      if (!overrideShell && !shellRef.current && !shellsReadyRef.current) {
        await waitUntil(
          () => shellsReadyRef.current || mySeq !== initSeqRef.current,
          SHELL_LIST_WAIT_MS
        );
        if (mySeq !== initSeqRef.current) return;
      }
      await awaitBounded(listenersReadyRef.current, LISTENERS_WAIT_MS);
      if (mySeq !== initSeqRef.current) return;

      earlyEventsRef.current?.clear();
      spawningRef.current = true;
      try {
        const effShell = overrideShell ?? shellRef.current ?? selectedShell;
        if (overrideShell) {
          shellRef.current = overrideShell;
        }
        // Folder fallback, the parent-folder notice and reaping an overtaken spawn: see
        // `spawnPaneShell`.
        const sessionInfo = await spawnPaneShell({
          createPty: (req) => PtyService.createPty(req),
          closePty: (id) => PtyService.closePty(id),
          shellPath: effShell?.path ?? selectedShell?.path,
          args: effShell?.args ?? selectedShell?.args,
          cwd: cwdRef.current ?? cwd,
          cols,
          rows,
          isCurrent: () => mySeq === initSeqRef.current,
          notice: (text) => term.writeln(`\x1b[33m${text}\x1b[0m\r\n`),
        });
        if (!sessionInfo) return;
        markLive(sessionInfo.id, cols, rows);
        cwdTracker.sessionStarted(sessionInfo.cwd);
        replayHeld(sessionInfo.id);
      } catch (err: unknown) {
        launchFailed(mySeq, err, "[Shell failed to start]");
      } finally {
        endLaunch(mySeq);
      }
    };

    // Latest spawn closure (props change after mount: shell picker, cwd).
    // The resetKey effect below must re-spawn with CURRENT props, not the
    // ones captured on mount while the shell list was still loading.
    const initPtyRef = useRef<() => Promise<void>>(async () => {});
    initPtyRef.current = () => initPtySession();

    // Crash-loop Retry (all OSes): re-spawn the backend PTY in place when
    // the parent bumps `resetKey`. No-op on mount (key 0) so the initial
    // launch timer stays the single spawner — never a double spawn.
    const resetKeySeenRef = useRef(resetKey);
    useEffect(() => {
      if (resetKey === 0 || resetKey === resetKeySeenRef.current) return;
      resetKeySeenRef.current = resetKey;
      setLaunchError(null);
      void initPtyRef.current();
    }, [resetKey]);

    // The look this pane's xterm currently has (set when it is created, then by the
    // effect below), so a settings object that changed only OTHER things does no work.
    const appliedAppearanceRef = useRef<TerminalAppearance | null>(null);

    // React to settings changes dynamically: only the terminal's own look matters, and
    // only the work that look change needs is done (see `terminalAppearance`).
    useEffect(() => {
      const term = xtermRef.current;
      if (!term) return;

      const next = terminalAppearance(settings);
      const change = diffAppearance(appliedAppearanceRef.current, next);
      if (change.changed.size === 0) return;
      appliedAppearanceRef.current = next;

      if (change.changed.has("fontFamily")) term.options.fontFamily = settings.fontFamily;
      if (change.changed.has("fontSize")) term.options.fontSize = settings.fontSize;
      if (change.changed.has("lineHeight")) {
        term.options.lineHeight = settings.lineHeight ?? DEFAULT_SETTINGS.lineHeight;
      }
      if (change.changed.has("cursorBlink")) term.options.cursorBlink = settings.cursorBlink;
      if (change.changed.has("cursorStyle"))
        term.options.cursorStyle = settings.cursorStyle || "block";
      if (change.changed.has("scrollback")) term.options.scrollback = settings.scrollback;
      if (change.changed.has("theme") || change.changed.has("opacity")) {
        term.options.theme = SettingsService.getThemeColors(
          settings.theme,
          settings.opacity ?? 1.0
        );
      }
      try {
        if (change.rebuildGlyphs) {
          term.clearTextureAtlas?.();
          term.refresh(0, Math.max(0, term.rows - 1));
        }
        // Font family/size change cell metrics, so the grid changes without the
        // container resizing: the PTY must learn the new cols/rows too.
        if (change.refit && fitWhenShown()) pushPtySize(term);
      } catch {
        // ignore hidden-tab layout errors
      }
    }, [settings]);

    useEffect(() => {
      if (!containerRef.current) return;

      // Whether the pointer is over a link xterm recognised (OSC 8 or plain
      // URL). Read by guardLinkClicks so Ctrl+click on a link is not also
      // forwarded to a mouse-aware program, which would open it a second time.
      let overLink = false;
      const onLinkHover = () => {
        overLink = true;
      };
      const onLinkLeave = () => {
        overLink = false;
      };

      // 1. Initialize xterm.js instance with optimal terminal options for AI CLIs and TUIs
      const term = new Terminal({
        // Explicit hyperlinks (OSC 8, e.g. from git or CLIs) otherwise go through
        // xterm's default handler, which pops a "could potentially be dangerous"
        // confirm() dialog. Open them like every other terminal link instead;
        // the backend still validates the URL (http/https only).
        linkHandler: {
          activate: (event, uri) => {
            if (!isOpenLinkClick(event)) return;
            openTerminalLink(uri).catch((e: unknown) => {
              console.error("Could not open link:", e);
            });
          },
          hover: onLinkHover,
          leave: onLinkLeave,
        },
        allowTransparency: true,
        cursorBlink: settings.cursorBlink,
        cursorStyle: settings.cursorStyle || "block",
        fontFamily: settings.fontFamily,
        fontSize: settings.fontSize,
        lineHeight: settings.lineHeight ?? DEFAULT_SETTINGS.lineHeight,
        scrollback: settings.scrollback,
        allowProposedApi: true,
        convertEol: false, // Do not modify raw line endings from PTY
        theme: SettingsService.getThemeColors(settings.theme, settings.opacity ?? 1.0),
      });

      const fitAddon = new FitAddon();
      // Search and Serialize (the screen snapshot for a tab moved to another window) are loaded
      // when first used, see `useTerminalSearch` and `serializeSlot`.
      term.loadAddon(fitAddon);
      // xterm defaults to Unicode 6 cell widths, which count emoji and many
      // symbols as one cell. Shells, ConPTY and modern TUIs (AI CLIs) lay text
      // out with Unicode 11+ widths (two cells), so every such character
      // shifted the rest of the line and neighbouring glyphs overlapped.
      try {
        term.loadAddon(new Unicode11Addon());
        term.unicode.activeVersion = "11";
      } catch (e) {
        console.warn("Unicode 11 widths are unavailable:", e);
      }
      // Links in output (sign-in addresses, build logs, docs) are underlined on
      // hover and open in the browser on Ctrl+click (Cmd+click on macOS).
      term.loadAddon(
        new WebLinksAddon(
          (event, uri) => {
            if (!isOpenLinkClick(event)) return;
            openTerminalLink(uri).catch((e: unknown) => {
              console.error("Could not open link:", e);
            });
          },
          { hover: onLinkHover, leave: onLinkLeave }
        )
      );

      term.open(containerRef.current);
      // After open(): the screen element exists and xterm's Linkifier has
      // already attached its mousedown listener, so ours runs after it.
      const screenEl = term.element?.querySelector<HTMLElement>(".xterm-screen");
      const unguardLinkClicks = screenEl
        ? guardLinkClicks(
            screenEl,
            () => overLink,
            () => term.focus()
          )
        : () => {};
      // Inline images (iTerm2 protocol and Sixel), so `kai teams` can show the
      // pictures people send. Guarded: if the add-on cannot start here, the
      // terminal works exactly as before and the chat falls back to links.
      // Fetched after the pane is up (see `xtermLazyAddons`): the terminal paints without it.
      const addonEpoch = lazyAddonEpochRef.current;
      void loadImageAddon()
        .then((ImageAddon) => {
          if (lazyAddonEpochRef.current !== addonEpoch) return; // pane torn down meanwhile
          term.loadAddon(new ImageAddon({ storageLimit: 32 }));
        })
        .catch((e: unknown) => console.warn("Inline images are unavailable:", e));
      try {
        fitAddon.fit();
      } catch {
        // ignore initial layout errors
      }
      // GPU renderer must load AFTER open() (it needs the screen element).
      if (visibleRef.current) attachGpu(term);

      const onTextareaFocus = () => {
        onFocusRef.current?.();
        cwdTracker.check();
      };
      term.textarea?.addEventListener("focus", onTextareaFocus);

      // Native paste events (WebView context-menu Paste, middle-click on
      // Linux, IME/accessibility paste) would otherwise reach xterm's own
      // handler, which sends the raw text — a trailing newline then runs the
      // command. Capture them on the container (before xterm sees them) and
      // route through the same writer as the keyboard paste. Keyboard paste
      // preventDefaults its keydown, so this never fires twice for one paste.
      const container = containerRef.current;
      // Created below, once the terminal exists; the native paste handler cancels its fallback.
      let keyHandler: TerminalKeyHandler | undefined;
      const onNativePaste = (event: ClipboardEvent) => {
        keyHandler?.cancelPendingPaste();
        event.preventDefault();
        event.stopPropagation();
        const text = event.clipboardData?.getData("text/plain") ?? "";
        if (text) {
          pasteToPty(text);
        } else {
          // No text: the clipboard holds copied files or an image. A terminal
          // only takes text, so paste their paths (an image is saved to a PNG
          // first), which AI CLIs and `kai teams` attach as files.
          readAttachmentPasteText()
            .then(pasteToPty)
            .catch(() => {});
        }
      };
      container.addEventListener("paste", onNativePaste, true);

      xtermRef.current = term;
      // The terminal was just built from `settings`, so that look is already applied.
      appliedAppearanceRef.current = terminalAppearance(settings);
      fitAddonRef.current = fitAddon;

      // 2. Custom key event handler: universal copy/paste across
      // Windows / Linux / macOS + search toggle.
      // Native shell autocompletion (Tab, Arrows, Ghost text) passes directly to PTY.
      // Plain Ctrl+C (no selection) always reaches the shell as SIGINT.
      keyHandler = createTerminalKeyHandler({
        term,
        fixedKeys: () => fixedKeysRef.current,
        keybindings: () => keybindingsRef.current,
        copyText: copyTextToClipboard,
        readPaste: readPasteContent,
        paste: pasteToPty,
      });
      term.attachCustomKeyEventHandler(keyHandler.handle);

      // OSC 7 (bash, zsh, fish) and OSC 9;9 (Windows Terminal) folder reports:
      try {
        // The shell reporting its folder (OSC 7 / OSC 9;9) is only a SIGNAL here: the folder
        // itself is read from the backend, which has checked it (the host in an OSC 7 URL is
        // this machine, and the folder exists). Anything that can print to the terminal can
        // write these sequences (a `cat`ed file, a remote `ssh` shell), and taking their path
        // at face value would let it choose the folder the git panel and new tabs use (SEC-12).
        // The backend report also reaches us as a `pty-cwd` event when it changes.
        term.parser.registerOscHandler(7, () => {
          cwdTracker.check();
          return false;
        });

        // OSC 9;9 (Windows Terminal / ConEmu convention): same treatment as OSC 7.
        term.parser.registerOscHandler(9, (data) => {
          if (data.startsWith("9;")) cwdTracker.check();
          return false;
        });

        // Per-terminal Code Mode: the `kai <agent>` CLI announces start/end
        // on its own stdout, i.e. on THIS pane's output stream.
        term.parser.registerOscHandler(CODE_MODE_OSC, (data) => {
          const signal = parseCodeModeSignal(data);
          if (signal) onCodeModeChangeRef.current?.(signal.active ? signal.path : null);
          return signal !== null;
        });

        // `kai teams` reports its unread count on this pane's output, for the tab badge.
        term.parser.registerOscHandler(TEAMS_OSC, (data) => {
          const count = parseTeamsSignal(data);
          if (count !== null) onTeamsUnreadChangeRef.current?.(count);
          return count !== null;
        });
      } catch {
        // parser handler registration not supported in some mock environments
      }

      // 3. User keyboard input forwarding without altering terminal escape sequences
      const inputDisposable = term.onData((data) => {
        // Enter submits the line (the cwd may now really change), so it must
        // not hold the footer path back as "still typing".
        cwdTracker.keyTyped(data);
        const backendId = backendPtyIdRef.current;
        if (backendId) {
          // Ghost-typing filter: when a fullscreen TUI dies without
          // restoring its DECSET modes, the emulator keeps translating
          // every mouse move / focus change into SGR/X10/focus reports
          // (the "[<35;..." garbage in the screenshot). A shell prompt on
          // the NORMAL buffer never consumes those, so strip them before
          // they reach the PTY. Fullscreen TUIs run on the ALTERNATE
          // screen, where reports pass through untouched and mouse keeps
          // working — entering it also clears the stuck-report tracking,
          // so a fresh TUI start is never penalized for old leaks.
          // The emulator-side reset is gentle (see shouldAutoResetModes):
          // the first stray report is only dropped, so a TUI that enables
          // mouse a beat before switching screens never loses its mouse
          // from one unlucky pointer move during launch.
          let forward = data;
          try {
            const onAlternate = term.buffer.active.type === "alternate";
            if (onAlternate) {
              stuckReportCountRef.current = 0;
              agentFinishedSeenRef.current = false;
              staleReplyUntilRef.current = 0;
            } else {
              // Replies to terminal queries the (now exited) agent made
              // would be typed into the shell as garbage and leave a lone
              // ESC pending; only dropped inside the short post-agent window.
              if (Date.now() < staleReplyUntilRef.current) {
                const noReplies = stripStaleTerminalReplies(data);
                if (noReplies.length !== data.length) data = noReplies;
              }
              const stripped = stripStuckInputReports(data, false);
              if (stripped.length !== data.length) {
                forward = stripped;
                stuckReportCountRef.current += 1;
                if (
                  shouldAutoResetModes(stuckReportCountRef.current, agentFinishedSeenRef.current)
                ) {
                  try {
                    term.write(TERMINAL_MODE_RESET_SEQ);
                  } catch {
                    // Emulator gone; dropping the reports is enough.
                  }
                }
              }
            }
          } catch {
            forward = data;
          }
          if (!forward) return;
          // Peek the pending line BEFORE Enter commits/clears it: the
          // post-command cwd probe fires only for directory-changing lines.
          // Previously every Enter (even bare Enter or `ls`) paid 3 IPC
          // probes plus 3 git spawns and full re-render cascades — the felt
          // input lag on Windows. Other lines rely on the OSC/focus/interval
          // backstops, which stay untouched.
          const submitted =
            forward.includes("\r") || forward.includes("\n")
              ? `${lineBufferRef.current} ${forward}`
              : "";
          trackInputData(forward);
          ptyService.writeToPty(backendId, forward).catch(() => {
            // Backend already reaped the session; status update arrives via pty-exit.
          });
          // Directory- or branch-changing lines are re-checked once the command has had time
          // (see `paneCwdTracker`); other lines rely on the shell's reports and the poll.
          cwdTracker.lineSubmitted(submitted);
        }
        // Dead pane: input is ignored (use Close pane). No auto-restart.
      });

      // 4. Output streaming (batched per animation frame to avoid UI freeze
      // on high-volume output) & process exit event listeners. Filtering uses
      // the backend PTY id so concurrent tabs stay isolated.
      let unlistenOutput: (() => void) | undefined;
      let unlistenExit: (() => void) | undefined;
      let unlistenCwd: (() => void) | undefined;
      // Set on cleanup BEFORE the async listener promises below resolve:
      // without this, unmounting a pane quickly leaks all three global
      // Tauri listeners (cleanup sees `undefined` and never unlistens),
      // so tab churn grows memory and duplicates output handling.
      let listenersCancelled = false;
      const trackUnlisten = (
        promise: Promise<() => void>,
        assign: (unlisten: () => void) => void
      ) => {
        return promise.then((unlisten) => {
          if (listenersCancelled) {
            try {
              unlisten();
            } catch {
              // Already removed; safe to ignore.
            }
          } else {
            assign(unlisten);
          }
        });
      };
      // Buffering, per-frame chunked writes to xterm and flow-control acknowledgements
      // (only once xterm has parsed the bytes): see `terminalOutputPipeline`.
      const output = createTerminalOutputPipeline({
        term,
        ack: (bytes) => {
          const id = backendPtyIdRef.current;
          if (id) void PtyService.ackOutput(id, bytes);
        },
      });
      const flushOutput = output.flush;
      // Exposed for the show-time layout effect: a tab that flipped from
      // hidden to visible flushes buffered output synchronously so the first
      // paint already contains it.
      flushPendingRef.current = flushOutput;

      // `counted`: the backend counted these bytes as sent to this pane (a live event).
      // Output handed over by a window move (`HandoffRelease`) was never sent as events.
      const handleOutput = (payload: { id: string; data: string }, counted = true) => {
        output.push(payload.data, counted);
        // Ghost-typing auto-recovery: `kai` Code Mode runs print
        // "[kai] Agent finished" once the agent child settles. The CLI
        // already resets terminal modes on its stdout, but when that
        // reset is lost (killed mid-flush, piped output, older CLI) the
        // emulator-side mouse/focus/bracketed-paste modes stay stuck and
        // every mouse move / window focus injects escape sequences the
        // shell echoes as stray typed text. Re-feed the same DECSET
        // resets via term.write (output path: parsed as mode changes,
        // screen-safe) so the pane self-heals without user action.
        try {
          const scan = scanAgentFinishedTail(agentFinishedTailRef.current, payload.data);
          agentFinishedTailRef.current = scan.tail;
          if (scan.hit) {
            // Latch proof the agent is gone: the next stray mouse /
            // focus report (if the CLI-side reset was lost) resets the
            // emulator immediately instead of waiting for a repeat.
            agentFinishedSeenRef.current = true;
            staleReplyUntilRef.current = Date.now() + STALE_REPLY_WINDOW_MS;
            term.write(TERMINAL_MODE_RESET_SEQ);
          }
        } catch {
          // Best-effort hardening; output rendering above already ran.
        }
      };

      // Sessions whose exit was already handled: the same exit can arrive from the hand-off
      // result AND the replayed early events, and reporting it twice would count one crash twice.
      const exitHandled = new Set<string>();
      const handleExit = (payload: { id: string; exit_code?: number | null }) => {
        if (payload.id) {
          if (exitHandled.has(payload.id)) return;
          exitHandled.add(payload.id);
        }
        flushOutput();
        releasePtyId(backendPtyIdRef.current);
        backendPtyIdRef.current = null;
        onCodeModeChangeRef.current?.(null);
        onTeamsUnreadChangeRef.current?.(0);
        // The backend sends `null` when it could not read the exit status
        // (child.wait() failed). That is NOT a clean exit: treating it as 0
        // skipped the crash-loop / instant-death guards and could quit the app
        // from its last tab. Pass it on as unknown.
        const exitCode = payload.exit_code ?? undefined;
        onStatusRef.current?.("disconnected");
        // Immediately close the pane or tab cleanly like a native terminal
        onExitRef.current?.(exitCode);
      };

      // Events for a session this pane has not been told about yet (see
      // `ptyEarlyEvents`) are held while `create_pty` is in flight.
      replayEarlyEventsRef.current = (events) => {
        for (const e of events) {
          if (e.id !== backendPtyIdRef.current) continue;
          if (e.kind === "output") handleOutput(e);
          else handleExit(e);
        }
      };

      const listenerPromises: Promise<unknown>[] = [];
      listenerPromises.push(
        trackUnlisten(
          ptyService.onPtyOutput((payload) => {
            if (payload.id === backendPtyIdRef.current) handleOutput(payload);
            else if (spawningRef.current) {
              earlyEventsRef.current?.hold({ kind: "output", id: payload.id, data: payload.data });
            }
          }),
          (unlisten) => {
            unlistenOutput = unlisten;
          }
        )
      );

      listenerPromises.push(
        trackUnlisten(
          ptyService.onPtyExit((payload) => {
            if (payload.id === backendPtyIdRef.current) handleExit(payload);
            else if (spawningRef.current) {
              earlyEventsRef.current?.hold({
                kind: "exit",
                id: payload.id,
                exit_code: payload.exit_code,
              });
            }
          }),
          (unlisten) => {
            unlistenExit = unlisten;
          }
        )
      );

      listenerPromises.push(
        trackUnlisten(
          ptyService.onPtyCwd((payload) => {
            if (payload.id === backendPtyIdRef.current && payload.cwd) {
              cwdTracker.report(payload.cwd);
            }
          }),
          (unlisten) => {
            unlistenCwd = unlisten;
          }
        )
      );
      // Resolves once every Tauri-side listener exists. A shell must not start before that:
      // its first prompt would be emitted to nobody (REL-09).
      listenersReadyRef.current = Promise.all(listenerPromises);

      // 5. Container resize handling (debounced 150 ms so drag-resize and
      // rapid layout changes send at most one IPC resize each).
      let resizeTimer: ReturnType<typeof setTimeout> | null = null;
      const resizeObserver = new ResizeObserver(() => {
        if (resizeTimer) return;
        resizeTimer = setTimeout(() => {
          resizeTimer = null;
          try {
            // The trailing timer can fire after the tab was hidden: never size
            // the PTY from a hidden pane (see `fitWhenShown`).
            if (fitWhenShown()) pushPtySize(term);
          } catch {
            // Ignore layout errors during component unmount
          }
        }, 150);
      });

      resizeObserver.observe(containerRef.current);

      // Web fonts (bundled / installed) can finish loading after the first
      // fit(), which measured fallback-font cells. The container size does not
      // change when that happens, so the ResizeObserver stays silent and the
      // grid (and PTY) would keep the wrong rows/cols until the next resize.
      let fontsDisposed = false;
      const refitAfterFonts = () => {
        if (fontsDisposed) return;
        try {
          term.clearTextureAtlas?.();
          if (fitWhenShown()) pushPtySize(term);
        } catch {
          // Ignore layout errors during component unmount
        }
      };
      const fontSet = typeof document !== "undefined" ? document.fonts : undefined;
      void fontSet?.ready?.then(refitAfterFonts);
      fontSet?.addEventListener?.("loadingdone", refitAfterFonts);

      // Output a moved shell printed while no window was showing it (the backend
      // held it) goes back into this terminal when the move is cancelled.
      resumeHeldRef.current = (released) => {
        for (const chunk of released.data) handleOutput({ id: "", data: chunk }, false);
        flushOutput();
        const id = backendPtyIdRef.current;
        if (released.exited && id) handleExit({ id, exit_code: released.exit_code });
      };

      // Attach to a shell that is already running (a tab dragged in from another
      // window) instead of starting one: redraw its screen from the snapshot, then
      // the output it printed during the move, then carry on live. Live events for
      // the session wait in `earlyEvents` until the held output is in, so nothing is
      // written out of order.
      const adoptSession = async (a: PaneAdoption) => {
        const mySeq = ++initSeqRef.current;
        onStatusRef.current?.("connecting");
        await awaitBounded(listenersReadyRef.current, LISTENERS_WAIT_MS);
        if (mySeq !== initSeqRef.current) return;
        earlyEventsRef.current?.clear();
        spawningRef.current = true;
        pendingAdoptIdRef.current = a.ptyId;
        try {
          const released = await replayHandoff({
            term,
            adoption: a,
            finish: handoffFinish,
            isCurrent: () => mySeq === initSeqRef.current,
          });
          if (!released) return;
          pendingAdoptIdRef.current = null;
          markLive(a.ptyId, a.cols, a.rows);
          replayHeld(a.ptyId);
          if (released.exited) handleExit({ id: a.ptyId, exit_code: released.exit_code });
          cwdTracker.check(a.ptyId);
        } catch (err: unknown) {
          launchFailed(mySeq, err, "[Could not attach to the moved shell]");
        } finally {
          endLaunch(mySeq);
        }
      };

      // Launch initial PTY session (deferred):
      // - A moved shell is attached to straight away (it is already running).
      // - Hidden tabs skip the spawn entirely; the `visible` effect below
      //   launches on first show (startup thundering-herd fix).
      // - Visible panes wait one paint (~60 ms) so the window renders
      //   before the blocking-ish spawn IPC, avoiding "not responding".
      let initialTimer: ReturnType<typeof setTimeout> | null = null;
      const adoption = adoptRef.current;
      if (adoption) {
        initialLaunchScheduledRef.current = true;
        initialTimer = setTimeout(() => {
          initialTimer = null;
          void adoptSession(adoption);
        }, 0);
      } else if (visibleRef.current) {
        initialLaunchScheduledRef.current = true;
        initialTimer = setTimeout(() => {
          initialTimer = null;
          void initPtySession();
        }, 60);
      }

      // Clean disposal on unmount or session switch: close the BACKEND session
      // id (not the tab id) so no orphan child process survives.
      return () => {
        initSeqRef.current += 1;
        listenersCancelled = true;
        flushPendingRef.current = () => {};
        if (initialTimer) clearTimeout(initialTimer);
        output.dispose();
        term.textarea?.removeEventListener("focus", onTextareaFocus);
        container.removeEventListener("paste", onNativePaste, true);
        keyHandler?.cancelPendingPaste();
        detachGpuRenderer(webglAddonRef);
        inputDisposable.dispose();
        resizeObserver.disconnect();
        fontsDisposed = true;
        fontSet?.removeEventListener?.("loadingdone", refitAfterFonts);
        if (resizeTimer) clearTimeout(resizeTimer);
        if (unlistenOutput) unlistenOutput();
        if (unlistenExit) unlistenExit();
        if (unlistenCwd) unlistenCwd();
        // A pane closed while it was still attaching to a moved shell ends it too.
        const backendId = backendPtyIdRef.current ?? pendingAdoptIdRef.current;
        backendPtyIdRef.current = null;
        pendingAdoptIdRef.current = null;
        releasePtyId(backendId);
        spawningRef.current = false;
        replayEarlyEventsRef.current = () => {};
        resumeHeldRef.current = () => {};
        serializeSlot.reset();
        terminalSearch.reset();
        lazyAddonEpochRef.current += 1;
        if (backendId) {
          ptyService.closePty(backendId).catch(() => {
            // Already reaped; safe to ignore.
          });
        }
        cancelGpuRetry();
        cwdTracker.dispose();
        onCodeModeChangeRef.current?.(null);
        onTeamsUnreadChangeRef.current?.(0);
        unguardLinkClicks();
        term.dispose();
      };
      // sessionId scopes the tab lifetime; shell/cwd changes apply on next launch.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sessionId]);

    // Hold a WebGL context while this pane is on screen (see attachGpuRenderer).
    // Hidden panes KEEP theirs until more than MAX_HIDDEN_GPU_PANES are hidden
    // at once, then the longest-hidden one is released (see `gpuBudget`), so
    // many tabs never exhaust the browser's context cap. A time-based release
    // made every switch back to a tab left for a while rebuild the renderer
    // (shader compile + glyph atlas) on the UI thread: a stall, then a frame
    // of stale glyphs. Idempotent with the mount-time attach above.
    //
    // LAYOUT effect: a re-attach (for a pane that WAS released) must land before
    // the browser paints the re-shown tab. As a plain effect it ran after the
    // first paint, so the DOM renderer's stale frame (old glyph rows at the
    // pre-hide layout) flashed before the GPU canvas replaced it — the "random
    // text flash on tab switch".
    const releaseGpuRef = useRef(() => detachGpuRenderer(webglAddonRef));
    // When this pane last went hidden (null while visible / never hidden): a tab
    // idle for a while gets an extra post-paint re-fit + repaint on return.
    const hiddenAtRef = useRef<number | null>(null);
    useLayoutEffect(() => {
      const term = xtermRef.current;
      if (!term) return;
      const release = releaseGpuRef.current;
      if (visible) {
        hiddenGpuBudget.show(release);
        gpuRetryRef.current.attempt = 0; // a fresh start every time the pane is shown
        attachGpu(term);
        return;
      }
      cancelGpuRetry();
      hiddenAtRef.current = Date.now();
      // Only a pane that actually holds a context counts against the budget
      // (panes that mounted hidden never attached one).
      if (webglAddonRef.current) hiddenGpuBudget.hide(release);
      return () => hiddenGpuBudget.show(release);
      // Runs on visibility changes only: `attachGpu` is recreated every render, and re-running this
      // on each render would re-attach the renderer and churn the hidden-pane budget.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [visible]);

    // Periodic live CWD synchronization for the visible pane (ensures footer updates on cd).
    // Polled at 5 s (not 1.5 s): each tick is a backend IPC + mutex grab,
    // and with several splits the old cadence contended with an already
    // slow PowerShell startup. Skipped while the window is hidden.
    useEffect(() => {
      if (!visible) return;
      const timer = setInterval(() => {
        if (typeof document !== "undefined" && document.hidden) return;
        // Quiet: an unchanged folder on a timer is not a sign the shell ran anything, so it
        // must not force a `git status` every few seconds while Kai sits idle.
        cwdTracker.poll();
      }, 5000);
      return () => clearInterval(timer);
    }, [visible, cwdTracker]); // cwdTracker is created once per pane

    // First-show launcher for tabs that mounted hidden: spawn the PTY on
    // first visibility, or re-fit an already-live session (hidden mount
    // fit() is a no-op, so cols/rows would otherwise stay 80x24).
    //
    // LAYOUT effect (tab-switch smoothness fix): the tab's container flips
    // from display:none to display:block in this commit, and the browser
    // paints IMMEDIATELY after React commits. A plain effect ran after that
    // first paint, so the re-fit, forced refresh and scrollToBottom landed a
    // frame late — the user saw one frame of stale content (glyph rows laid
    // out for the 0-size hidden container at the old scroll position, i.e.
    // the "random text flash" when switching tabs) before it corrected
    // itself. Running fit/refresh/scroll synchronously before paint means
    // the very first painted frame of the re-shown tab is already correct.
    useLayoutEffect(() => {
      if (!visible) return;
      const term = xtermRef.current;
      if (!term) return;
      // Consumed on every show (even the first one) so a pane that mounted
      // hidden is never mistaken for one that sat idle after being visible.
      const hiddenAt = hiddenAtRef.current;
      hiddenAtRef.current = null;
      if (!initialLaunchScheduledRef.current && !backendPtyIdRef.current) {
        initialLaunchScheduledRef.current = true;
        void initPtySession();
        return;
      }
      const wasIdle = hiddenAt !== null && Date.now() - hiddenAt > ATLAS_REBUILD_AFTER_HIDDEN_MS;
      try {
        // Output that arrived while the tab was hidden sits in the mount
        // effect's pending buffer (rAF stalls for hidden tabs). Drain it
        // synchronously so the first paint includes the newest lines.
        flushPendingRef.current();
        // A kept WebGL renderer can return from display:none with a glyph atlas
        // that no longer matches its canvas (the canvas is resized from 0 and the
        // WebView may reclaim GPU memory at any time, not only after a long
        // idle): rows then paint as scrambled glyph fragments. Rebuild the atlas
        // on EVERY show, before the first paint. It only re-rasterizes the
        // glyphs on screen, so it is cheap next to showing garbage.
        try {
          webglAddonRef.current?.clearTextureAtlas();
        } catch {
          // Addon already disposed (context loss); the DOM renderer has no atlas.
        }
        fitAddonRef.current?.fit();
        pushPtySize(term);
        // A tab that was hidden (display:none) never repainted while output
        // streamed in, and fit() is a no-op while hidden. Without a forced
        // full repaint the re-shown tab keeps stale/ghost glyph rows (text
        // from the previous state) until the next dirty update.
        term.refresh(0, Math.max(0, term.rows - 1));
        // Land on the newest lines in the same pre-paint pass.
        term.scrollToBottom();
      } catch {
        // ignore hidden-tab layout errors
      }
      // Safety pass after the first paint, ONLY for a tab that sat idle: it can
      // come back with a discarded GPU canvas or a container that is only
      // measured one frame later, which the pre-paint pass above cannot see.
      // Re-fit and repaint once more so the pane never stays blank until the
      // next switch. Quick flips skip it: a second full-screen repaint on every
      // switch would only add lag.
      if (!wasIdle) return;
      const settle = requestAnimationFrame(() => {
        try {
          if (fitWhenShown()) pushPtySize(term);
          term.refresh(0, Math.max(0, term.rows - 1));
        } catch {
          // ignore hidden-tab layout errors
        }
      });
      return () => cancelAnimationFrame(settle);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [visible]);

    return (
      <div
        className="terminal-container"
        onMouseDownCapture={() => onFocusRef.current?.()}
        onClickCapture={() => onFocusRef.current?.()}
        style={{
          backgroundColor: SettingsService.getThemeBackgroundColor(
            settings.theme,
            settings.opacity ?? 1.0
          ),
          position: "relative",
          // Read by `.terminal-xterm-host .xterm`; the fit addon subtracts it.
          ["--terminal-padding-x" as string]: `${settings.terminalPaddingX ?? DEFAULT_SETTINGS.terminalPaddingX}px`,
          ["--terminal-padding-y" as string]: `${settings.terminalPaddingY ?? DEFAULT_SETTINGS.terminalPaddingY}px`,
        }}
      >
        {terminalSearch.visible && (
          <Suspense fallback={null}>
            <SearchBar
              onSearch={terminalSearch.search}
              onSearchNext={terminalSearch.next}
              onSearchPrevious={terminalSearch.previous}
              onClose={terminalSearch.close}
              results={terminalSearch.results}
            />
          </Suspense>
        )}
        <div
          ref={containerRef}
          className="terminal-xterm-host"
          role="log"
          aria-label="Terminal output"
        />
        {launchError && (
          <div className="terminal-launch-error" role="alert" aria-label="Terminal failed to start">
            <div className="terminal-launch-error-text">
              <strong className="terminal-launch-error-title">Shell failed to start</strong>
              <span className="terminal-launch-error-detail" title={launchError}>
                {launchError}
              </span>
              <span className="terminal-launch-error-tip">{launchFailureTip(detectHostOs())}</span>
            </div>
            <button
              type="button"
              className="btn btn-primary btn-small"
              onClick={() => {
                setLaunchError(null);
                void initPtySession();
              }}
            >
              Retry
            </button>
          </div>
        )}
      </div>
    );
  }
);

TerminalView.displayName = "TerminalView";
