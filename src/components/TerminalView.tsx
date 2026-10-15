import {
  useEffect,
  useRef,
  useImperativeHandle,
  forwardRef,
  useState,
  Suspense,
  lazy,
} from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import { ptyService, PtyService } from "../services/ptyService";
import {
  isCopyKeyEvent,
  isPasteKeyEvent,
  matchBuiltinShortcut,
  matchTerminalAction,
} from "../services/shortcuts";
import { ShellProfile, SessionStatus, UserSettings } from "../types/terminal";
import { SettingsService, DEFAULT_SETTINGS } from "../services/settingsService";
import { loadCommandHistory, recordCommand, saveCommandHistory } from "../services/autocomplete";
import { TerminalOutputBuffer } from "../services/terminalOutputBuffer";
import {
  CD_PROBE_DELAYS_MS,
  CWD_SETTLE_MS,
  createCwdSettler,
  lineLikelyChangesCwd,
  lineLikelyChangesCodeMode,
  type CwdSettler,
} from "../services/cwdCommand";
import { TERMINAL_MODE_RESET_SEQ, scanAgentFinishedTail } from "../services/terminalModes";
import {
  STALE_REPLY_WINDOW_MS,
  shouldAutoResetModes,
  stripStaleTerminalReplies,
  stripStuckInputReports,
} from "../services/terminalModes";
// Search UI only mounts on first toggle (Ctrl+Shift+F), so it stays out of
// the per-pane startup path.
const SearchBar = lazy(() => import("./SearchBar").then((m) => ({ default: m.SearchBar })));

/**
 * GPU (WebGL) renderer for xterm. The default DOM renderer is the main cause
 * of typing/scroll lag and dropped frames under heavy output (TUIs, AI CLIs,
 * builds), so panes use WebGL whenever the WebView supports it.
 *
 * - Attached only to VISIBLE panes: browsers cap live WebGL contexts (~16), and
 *   hidden tabs stay mounted, so they release theirs and fall back to DOM.
 * - Any failure (no WebGL2, blocklisted GPU, context loss) silently keeps / falls
 *   back to the DOM renderer — never breaks the terminal.
 * - Escape hatch: `localStorage.kai_renderer = "dom"` forces the DOM renderer.
 */
function gpuRendererDisabled(): boolean {
  try {
    return window.localStorage.getItem("kai_renderer") === "dom";
  } catch {
    return false;
  }
}

function attachGpuRenderer(term: Terminal, slot: { current: WebglAddon | null }): void {
  if (slot.current || gpuRendererDisabled()) return;
  try {
    const addon = new WebglAddon();
    addon.onContextLoss(() => {
      try {
        addon.dispose();
      } catch {
        // Already disposed with the terminal.
      }
      if (slot.current === addon) slot.current = null;
    });
    term.loadAddon(addon);
    slot.current = addon;
    term.refresh(0, Math.max(0, term.rows - 1));
  } catch {
    // WebGL2 unavailable: the DOM renderer keeps working.
    slot.current = null;
  }
}

/** How long a hidden pane keeps its WebGL context before releasing it. */
const GPU_RELEASE_DELAY_MS = 15_000;

function detachGpuRenderer(slot: { current: WebglAddon | null }): void {
  const addon = slot.current;
  slot.current = null;
  if (!addon) return;
  try {
    addon.dispose();
  } catch {
    // Already disposed; safe to ignore.
  }
}

// Terminal input-mode recovery (ghost-typing fix): the shared constants and
// the chunk scanner live in src/services/terminalModes.ts (same bytes the CLI
// emits on stdout after an agent run). Re-exported here for tests and callers.
export {
  AGENT_FINISHED_MARKER,
  TERMINAL_MODE_RESET_SEQ,
  scanAgentFinishedTail,
  shouldAutoResetModes,
  stripStuckInputReports,
} from "../services/terminalModes";

export interface TerminalViewRef {
  clear: () => void;
  copySelection: () => Promise<string>;
  pasteText: (text: string) => void;
  focus: () => void;
  toggleSearch: () => void;
  /**
   * Feed the DECSET mode-reset sequence to the emulator (output path).
   * Recovery for "ghost typing": a dead TUI left mouse/focus/bracketed-
   * paste reporting on, so every mouse move or window focus injects escape
   * sequences the shell echoes as stray input. Screen-safe (modes only).
   */
  resetModes: () => void;
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
  onSessionStatusChange?: (status: SessionStatus, message?: string) => void;
  onExit?: (exitCode: number) => void;
  onCwdResolved?: (cwd: string) => void;
  onFocus?: () => void;
  /**
   * Fires whenever the user submits a command line (Enter) in this pane,
   * BEFORE the shell runs it. Used by the app shell to re-sync cheap
   * external state that can change out from under the UI — e.g. `kai code
   * .` / `kai stop code` run inside Kai's own tab write the state file but
   * produce no window-focus event, so focus-only polling never notices.
   * Handlers must stay cheap (no spawns): the cwd/git probes keep their
   * own stricter gating below.
   */
  onCommandSubmitted?: () => void;
}

export const TerminalView = forwardRef<TerminalViewRef, TerminalViewProps>(
  (
    {
      sessionId,
      selectedShell,
      cwd,
      settings = DEFAULT_SETTINGS,
      visible = true,
      resetKey = 0,
      onSessionStatusChange,
      onExit,
      onCwdResolved,
      onFocus,
      onCommandSubmitted,
    },
    ref
  ) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const xtermRef = useRef<Terminal | null>(null);
    const fitAddonRef = useRef<FitAddon | null>(null);
    const searchAddonRef = useRef<SearchAddon | null>(null);
    const webglAddonRef = useRef<WebglAddon | null>(null);
    // Backend PTY session id returned by create_pty (UUID). This is distinct
    // from the frontend tab id (`sessionId`): all IPC read/write/resize/close
    // calls and output filtering MUST use the backend id, otherwise writes
    // hit SessionNotFound and output is dropped / leaks across tabs.
    const backendPtyIdRef = useRef<string | null>(null);
    const initSeqRef = useRef<number>(0);
    const [isSearchVisible, setIsSearchVisible] = useState(false);
    // Last PTY spawn failure for this pane. When set, an in-pane overlay
    // offers Retry (re-spawn) so a bad shell binary / cwd never leaves the
    // user staring at a dead pane with "use the + button" as the only fix.
    const [launchError, setLaunchError] = useState<string | null>(null);

    // ---- Command line tracking & history ---------------------------------
    // Native Kali/Linux terminal autocompletion (ZSH autosuggestions, compinit,
    // bash-completion) is owned by the shell over the PTY. We do not inject
    // popup overlays over the buffer so Tab, arrow keys, and ghost text
    // behave identically to native Kali terminals.
    const lineBufferRef = useRef("");
    const historyRef = useRef<string[]>([]);

    const commitLine = (line: string) => {
      const trimmed = line.trim();
      if (trimmed) {
        historyRef.current = recordCommand(historyRef.current, trimmed);
        saveCommandHistory(historyRef.current);
      }
    };

    const trackInputData = (data: string) => {
      // Enter or multiline chunk/paste: split and commit completed lines.
      if (data.includes("\r") || data.includes("\n")) {
        const full = lineBufferRef.current + data;
        const parts = full.split(/\r\n|\r|\n/);
        for (let i = 0; i < parts.length - 1; i++) {
          commitLine(parts[i]);
        }
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
    // Footer path gate: changed directories are held until typing stops and
    // the candidate settles (see createCwdSettler); deliver() is the only
    // place that reaches the app. Created once per pane.
    const lastKeyAtRef = useRef(0);
    const cwdSettlerRef = useRef<CwdSettler | null>(null);
    if (!cwdSettlerRef.current) {
      cwdSettlerRef.current = createCwdSettler((p) => onCwdResolvedRef.current?.(p), {
        isTyping: () => Date.now() - lastKeyAtRef.current < CWD_SETTLE_MS,
      });
    }
    const settleCwd = (p: string) => cwdSettlerRef.current?.push(p);
    const onCommandSubmittedRef = useRef(onCommandSubmitted);
    onCommandSubmittedRef.current = onCommandSubmitted;
    const onFocusRef = useRef(onFocus);
    onFocusRef.current = onFocus;
    const shellRef = useRef(selectedShell);
    shellRef.current = selectedShell;
    const cwdRef = useRef(cwd);
    cwdRef.current = cwd;
    const visibleRef = useRef(visible);
    visibleRef.current = visible;
    // `<backendId>:<cols>x<rows>` last pushed to the PTY; skips no-op resizes
    // (a tab flip re-fits to the same grid, and a ConPTY resize forces a reflow).
    const lastPtySizeRef = useRef<string>("");
    const pushPtySize = (term: Terminal) => {
      const backendId = backendPtyIdRef.current;
      if (!term.cols || !term.rows || !backendId) return;
      const key = `${backendId}:${term.cols}x${term.rows}`;
      if (key === lastPtySizeRef.current) return;
      lastPtySizeRef.current = key;
      ptyService.resizePty(backendId, term.cols, term.rows).catch(() => {});
    };
    // Tracks whether the initial PTY spawn has been scheduled, so tab
    // switches don't re-spawn a live session.
    const initialLaunchScheduledRef = useRef(false);
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

    useImperativeHandle(ref, () => ({
      clear: () => {
        xtermRef.current?.clear();
      },
      refit: () => {
        const term = xtermRef.current;
        const fitAddon = fitAddonRef.current;
        if (!term || !fitAddon) return;
        try {
          fitAddon.fit();
        } catch {
          return;
        }
        const backendId = backendPtyIdRef.current;
        if (term.cols && term.rows && backendId) {
          ptyService.resizePty(backendId, term.cols, term.rows).catch(() => {});
        }
      },
      copySelection: async () => {
        const selection = xtermRef.current?.getSelection();
        if (selection) {
          await navigator.clipboard.writeText(selection);
          return selection;
        }
        return "";
      },
      pasteText: (text: string) => {
        const backendId = backendPtyIdRef.current;
        const term = xtermRef.current;
        if (!text || !backendId) return;

        const byteLen = new TextEncoder().encode(text).length;
        if (byteLen > 1_048_576) {
          term?.writeln(
            `\r\n\x1b[33m[Input rejected: payload size (${byteLen} bytes) exceeds maximum limit of 1048576 bytes; paste smaller chunks instead of losing data silently]\x1b[0m\r\n`
          );
          return;
        }

        // Pasted text updates the line buffer so command history stays in sync.
        trackInputData(text);
        PtyService.writeToPty(backendId, text).catch((e) => {
          const msg = e instanceof Error ? e.message : String(e);
          term?.writeln(`\r\n\x1b[31m[Paste failed: ${msg}]\x1b[0m\r\n`);
        });
      },
      focus: () => {
        xtermRef.current?.focus();
      },
      resetModes: () => {
        try {
          xtermRef.current?.write(TERMINAL_MODE_RESET_SEQ);
        } catch {
          // Terminal disposed; nothing to reset.
        }
      },
      toggleSearch: () => {
        setIsSearchVisible((prev) => !prev);
      },
    }));

    const initPtySession = async (overrideShell?: ShellProfile) => {
      const term = xtermRef.current;
      const fitAddon = fitAddonRef.current;
      if (!term || !fitAddon) return;
      const mySeq = ++initSeqRef.current;

      // Best-effort close of the previous backend session for this tab
      // before spawning a replacement (prevents orphan PTY processes).
      const previousId = backendPtyIdRef.current;
      backendPtyIdRef.current = null;
      if (previousId) {
        try {
          await PtyService.closePty(previousId);
        } catch {
          // Already reaped by backend reader thread; safe to ignore.
        }
      }
      if (mySeq !== initSeqRef.current) return;

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
        fitAddon.fit();
      } catch {
        // Ignore fit errors during hidden-tab layout.
      }
      const cols = term.cols || 80;
      const rows = term.rows || 24;

      try {
        const effShell = overrideShell ?? shellRef.current ?? selectedShell;
        if (overrideShell) {
          shellRef.current = overrideShell;
        }
        const sessionInfo = await PtyService.createPty({
          shell_path: effShell?.path ?? selectedShell?.path,
          args: effShell?.args ?? selectedShell?.args,
          cwd: (() => {
            const c = cwdRef.current ?? cwd;
            return c && c.trim() ? c.trim() : undefined;
          })(),
          cols,
          rows,
        });
        if (mySeq !== initSeqRef.current) {
          // A newer init superseded this attempt; reap the orphan.
          try {
            await PtyService.closePty(sessionInfo.id);
          } catch {
            // ignore
          }
          return;
        }

        backendPtyIdRef.current = sessionInfo.id;
        setLaunchError(null);
        onStatusRef.current?.("connected");
        if (sessionInfo.cwd) {
          cwdSettlerRef.current?.reset();
          settleCwd(sessionInfo.cwd);
        }
      } catch (err: unknown) {
        if (mySeq !== initSeqRef.current) return;
        const errorMsg = err instanceof Error ? err.message : String(err);
        setLaunchError(errorMsg);
        term.writeln(`\r\n\x1b[31m[Failed to launch shell: ${errorMsg}]\x1b[0m\r\n`);
        term.writeln(
          `\x1b[33m[Tip: if this persists, check your PowerShell profile or pick Command Prompt as the default shell in Settings.]\x1b[0m\r\n`
        );
        onStatusRef.current?.("error", errorMsg);
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
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [resetKey]);

    // React to settings changes dynamically
    useEffect(() => {
      const term = xtermRef.current;
      if (!term) return;

      term.options.fontFamily = settings.fontFamily;
      term.options.fontSize = settings.fontSize;
      term.options.cursorBlink = settings.cursorBlink;
      term.options.cursorStyle = settings.cursorStyle || "block";
      term.options.scrollback = settings.scrollback;
      term.options.theme = SettingsService.getThemeColors(settings.theme, settings.opacity ?? 1.0);
      try {
        fitAddonRef.current?.fit();
      } catch {
        // ignore hidden-tab layout errors
      }
    }, [settings]);

    useEffect(() => {
      historyRef.current = loadCommandHistory();
    }, []);

    useEffect(() => {
      if (!containerRef.current) return;

      // 1. Initialize xterm.js instance with optimal terminal options for AI CLIs and TUIs
      const term = new Terminal({
        allowTransparency: true,
        cursorBlink: settings.cursorBlink,
        cursorStyle: settings.cursorStyle || "block",
        fontFamily: settings.fontFamily,
        fontSize: settings.fontSize,
        lineHeight: 1.2,
        scrollback: settings.scrollback,
        allowProposedApi: true,
        convertEol: false, // Do not modify raw line endings from PTY
        theme: SettingsService.getThemeColors(settings.theme, settings.opacity ?? 1.0),
      });

      const fitAddon = new FitAddon();
      const searchAddon = new SearchAddon();

      term.loadAddon(fitAddon);
      term.loadAddon(searchAddon);

      term.open(containerRef.current);
      try {
        fitAddon.fit();
      } catch {
        // ignore initial layout errors
      }
      // GPU renderer must load AFTER open() (it needs the screen element).
      if (visibleRef.current) attachGpuRenderer(term, webglAddonRef);

      const onTextareaFocus = () => {
        onFocusRef.current?.();
        const backendId = backendPtyIdRef.current;
        if (backendId) {
          void PtyService.getPtyCwd(backendId).then((resolved) => {
            if (resolved) settleCwd(resolved);
          });
        }
      };
      term.textarea?.addEventListener("focus", onTextareaFocus);

      xtermRef.current = term;
      fitAddonRef.current = fitAddon;
      searchAddonRef.current = searchAddon;

      // 2. Custom key event handler: universal copy/paste across
      // Windows / Linux / macOS + search toggle.
      // Native shell autocompletion (Tab, Arrows, Ghost text) passes directly to PTY.
      // Plain Ctrl+C (no selection) always reaches the shell as SIGINT.
      term.attachCustomKeyEventHandler((event: KeyboardEvent) => {
        // Copy: Ctrl+Shift+C (Win/Linux), Cmd+C / Cmd+Shift+C (macOS),
        // Ctrl+Insert (Win/Linux). Plain Ctrl+C always reaches the shell as
        // SIGINT; Shift+Insert is paste on every OS, never copy.
        const isCopy = isCopyKeyEvent(event, term.hasSelection());
        if (isCopy) {
          if (event.type === "keydown") {
            const selection = term.getSelection();
            navigator.clipboard.writeText(selection).catch(() => {});
          }
          return false;
        }
        // Paste: Ctrl+Shift+V (Win/Linux), Cmd+V (macOS), Shift+Insert.
        // preventDefault/stopPropagation are load-bearing: without them the
        // WebView ALSO performs a native paste into xterm's hidden textarea,
        // which surfaces via onData as a second writeToPty — "paste once,
        // appears twice". The explicit clipboard.readText below must be the
        // single writer. Auto-repeat keydowns are swallowed the same way so
        // a held combo cannot queue duplicate pastes.
        const isPaste = isPasteKeyEvent(event);
        if (isPaste) {
          event.preventDefault();
          event.stopPropagation();
          if (event.type === "keydown" && !event.repeat) {
            navigator.clipboard
              .readText()
              .then((text) => {
                const backendId = backendPtyIdRef.current;
                if (!text || !backendId) return;

                const byteLen = new TextEncoder().encode(text).length;
                if (byteLen > 1_048_576) {
                  term.writeln(
                    `\r\n\x1b[33m[Input rejected: payload size (${byteLen} bytes) exceeds maximum limit of 1048576 bytes; paste smaller chunks instead of losing data silently]\x1b[0m\r\n`
                  );
                  return;
                }

                trackInputData(text);
                ptyService.writeToPty(backendId, text).catch((e) => {
                  const msg = e instanceof Error ? e.message : String(e);
                  term.writeln(`\r\n\x1b[31m[Paste failed: ${msg}]\x1b[0m\r\n`);
                });
              })
              .catch(() => {});
          }
          return false;
        }
        // Terminal-local keys: Ctrl+Shift+A select all, Ctrl+Shift+K clear,
        // Ctrl+Shift+Home / End jump to the top / bottom of the scrollback.
        const localAction = matchTerminalAction(event);
        if (localAction) {
          event.preventDefault();
          if (event.type === "keydown") {
            if (localAction === "selectAll") term.selectAll();
            else if (localAction === "clear") term.clear();
            else if (localAction === "scrollTop") term.scrollToTop();
            else term.scrollToBottom();
          }
          return false;
        }
        // App-level zoom (Ctrl+= / - / 0) and tab jump (Ctrl+1-9) are handled
        // by App on the bubbled event; keep xterm from also sending the
        // matching control byte to the shell.
        if (matchBuiltinShortcut(event)) return false;
        // Handle Ctrl+Shift+F for toggling search
        if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.code === "KeyF") {
          if (event.type === "keydown") {
            setIsSearchVisible((prev) => !prev);
          }
          return false;
        }
        return true;
      });

      // Register OSC 7 handler (supported by bash, zsh, fish for CWD reporting)
      try {
        term.parser.registerOscHandler(7, (data) => {
          try {
            const url = new URL(data);
            let p = decodeURIComponent(url.pathname);
            if (/^\/[a-zA-Z]:/.test(p)) {
              p = p.slice(1);
            }
            if (p) {
              settleCwd(p);
            }
          } catch {
            if (data.startsWith("file://")) {
              let p = data.replace(/^file:\/\/[^/]*\//, "/");
              if (/^\/[a-zA-Z]:/.test(p)) {
                p = p.slice(1);
              }
              if (p) settleCwd(p);
            }
          }
          return false;
        });

        // Register OSC 9;9 handler (Windows Terminal / ConEmu CWD reporting)
        term.parser.registerOscHandler(9, (data) => {
          if (data.startsWith("9;")) {
            const p = data.slice(2);
            if (p) settleCwd(p);
          }
          return false;
        });
      } catch {
        // parser handler registration not supported in some mock environments
      }

      // 3. User keyboard input forwarding without altering terminal escape sequences
      const checkLiveCwd = () => {
        const backendId = backendPtyIdRef.current;
        if (!backendId) return;
        void PtyService.getPtyCwd(backendId).then((resolved) => {
          if (resolved) {
            settleCwd(resolved);
          }
        });
      };

      const inputDisposable = term.onData((data) => {
        lastKeyAtRef.current = Date.now();
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
          if (submitted && lineLikelyChangesCwd(submitted)) {
            // Triple-tap: the shell's next prompt (OSC 7 / OSC 9;9 /
            // getPtyCwd truth) can land well after 300 ms on slow commands
            // and heavy profiles, and a single early probe reads the pre-cd
            // directory — the "footer never updates after cd" report. See
            // CD_PROBE_DELAYS_MS: each tap lands in its own backend throttle
            // window, converging on the post-cd truth even when the user
            // idles afterwards. Cheap (one IPC each, cd-gated).
            for (const delay of CD_PROBE_DELAYS_MS) {
              setTimeout(checkLiveCwd, delay);
            }
          }
          // Notify the app shell about EVERY submitted line (cheap: the
          // handler only re-reads the active-project state file). This is
          // what picks up `kai code .` / `kai stop code` typed into Kai's
          // own tab — no focus change happens then, so focus polling alone
          // would leave the Code Mode badge stale.
          if (submitted) {
            onCommandSubmittedRef.current?.();
            // POST-execution re-sync for state-changing `kai` lines: the
            // pre-Enter sync above runs BEFORE the CLI writes/removes the
            // state file (after its indexing pass), so without these the
            // badge stays stale until the next focus event or command.
            if (lineLikelyChangesCodeMode(submitted)) {
              const resync = () => onCommandSubmittedRef.current?.();
              setTimeout(resync, 800);
              setTimeout(resync, 2500);
              setTimeout(resync, 6000);
            }
          }
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
        void promise.then((unlisten) => {
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
      let pendingOutput = new TerminalOutputBuffer();
      let rafScheduled = false;
      let rafId: number | null = null;
      let flushTimer: ReturnType<typeof setTimeout> | null = null;
      // Single xterm write of a 1 MB flood blocks the UI thread long
      // enough for Windows to flag the window "Not Responding".
      const MAX_TERM_WRITE_CHARS = 65536;

      const flushOutput = () => {
        rafScheduled = false;
        if (rafId !== null) {
          try {
            cancelAnimationFrame(rafId);
          } catch {
            // ignore
          }
          rafId = null;
        }
        if (flushTimer !== null) {
          clearTimeout(flushTimer);
          flushTimer = null;
        }
        if (!pendingOutput.isEmpty) {
          const chunk = pendingOutput.flush();
          try {
            for (let off = 0; off < chunk.length; off += MAX_TERM_WRITE_CHARS) {
              term.write(chunk.slice(off, off + MAX_TERM_WRITE_CHARS));
            }
          } catch {
            // Terminal disposed; drop remaining output.
          }
        }
      };

      const scheduleFlush = () => {
        if (!rafScheduled) {
          rafScheduled = true;
          // rAF stalls for hidden/background tabs, which would let
          // pendingOutput sit until the 1 MB cap; the timeout guarantees
          // progress so memory stays bounded either way.
          let flushed = false;
          const doFlush = () => {
            if (!flushed) {
              flushed = true;
              flushOutput();
            }
          };
          try {
            rafId = requestAnimationFrame(doFlush);
          } catch {
            doFlush();
          }
          flushTimer = setTimeout(doFlush, 250);
        }
      };

      trackUnlisten(
        ptyService.onPtyOutput((payload) => {
          if (payload.id === backendPtyIdRef.current) {
            // Bounded FIFO (see TerminalOutputBuffer): a flood of output
            // appends O(1) per chunk with memory capped at ~1 MB, instead of
            // re-copying a megabyte string on every event. xterm scrollback
            // bounds the rendered side as before.
            pendingOutput.append(payload.data);
            scheduleFlush();
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
          }
        }),
        (unlisten) => {
          unlistenOutput = unlisten;
        }
      );

      trackUnlisten(
        ptyService.onPtyExit((payload) => {
          if (payload.id === backendPtyIdRef.current) {
            flushOutput();
            backendPtyIdRef.current = null;
            const exitCode = payload.exit_code ?? 0;
            onStatusRef.current?.("disconnected");
            // Immediately close the pane or tab cleanly like a native terminal
            onExitRef.current?.(exitCode);
          }
        }),
        (unlisten) => {
          unlistenExit = unlisten;
        }
      );

      trackUnlisten(
        ptyService.onPtyCwd((payload) => {
          if (payload.id === backendPtyIdRef.current && payload.cwd) {
            settleCwd(payload.cwd);
          }
        }),
        (unlisten) => {
          unlistenCwd = unlisten;
        }
      );

      // 5. Container resize handling (debounced 150 ms so drag-resize and
      // rapid layout changes send at most one IPC resize each).
      let resizeTimer: ReturnType<typeof setTimeout> | null = null;
      const resizeObserver = new ResizeObserver(() => {
        if (resizeTimer) return;
        resizeTimer = setTimeout(() => {
          resizeTimer = null;
          try {
            fitAddon.fit();
            pushPtySize(term);
          } catch {
            // Ignore layout errors during component unmount
          }
        }, 150);
      });

      resizeObserver.observe(containerRef.current);

      // Launch initial PTY session (deferred):
      // - Hidden tabs skip the spawn entirely; the `visible` effect below
      //   launches on first show (startup thundering-herd fix).
      // - Visible panes wait one paint (~60 ms) so the window renders
      //   before the blocking-ish spawn IPC, avoiding "not responding".
      let initialTimer: ReturnType<typeof setTimeout> | null = null;
      if (visibleRef.current) {
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
        if (initialTimer) clearTimeout(initialTimer);
        if (rafId !== null) {
          try {
            cancelAnimationFrame(rafId);
          } catch {
            // ignore
          }
          rafId = null;
        }
        if (flushTimer !== null) {
          clearTimeout(flushTimer);
          flushTimer = null;
        }
        term.textarea?.removeEventListener("focus", onTextareaFocus);
        detachGpuRenderer(webglAddonRef);
        inputDisposable.dispose();
        resizeObserver.disconnect();
        if (resizeTimer) clearTimeout(resizeTimer);
        if (unlistenOutput) unlistenOutput();
        if (unlistenExit) unlistenExit();
        if (unlistenCwd) unlistenCwd();
        const backendId = backendPtyIdRef.current;
        backendPtyIdRef.current = null;
        if (backendId) {
          ptyService.closePty(backendId).catch(() => {
            // Already reaped; safe to ignore.
          });
        }
        cwdSettlerRef.current?.dispose();
        term.dispose();
      };
      // sessionId scopes the tab lifetime; shell/cwd changes apply on next launch.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sessionId]);

    // Hold a WebGL context only while this pane is on screen (see
    // attachGpuRenderer): hidden tabs release it so many tabs never exhaust the
    // browser's context cap. Idempotent with the mount-time attach above.
    // The release is delayed: dropping the context on every hide and rebuilding
    // it (shader compile + glyph atlas) on every show made quick tab flips
    // visibly laggy. Re-showing within the grace period reuses the live
    // renderer; a pane left hidden still frees its context so many tabs never
    // exhaust the cap (context loss is handled by `attachGpuRenderer`).
    useEffect(() => {
      const term = xtermRef.current;
      if (!term) return;
      if (visible) {
        attachGpuRenderer(term, webglAddonRef);
        return;
      }
      const timer = setTimeout(() => detachGpuRenderer(webglAddonRef), GPU_RELEASE_DELAY_MS);
      return () => clearTimeout(timer);
    }, [visible]);

    // Periodic live CWD synchronization for the visible pane (ensures footer updates on cd).
    // Polled at 5 s (not 1.5 s): each tick is a backend IPC + mutex grab,
    // and with several splits the old cadence contended with an already
    // slow PowerShell startup. Skipped while the window is hidden.
    useEffect(() => {
      if (!visible) return;
      const timer = setInterval(() => {
        if (typeof document !== "undefined" && document.hidden) return;
        const backendId = backendPtyIdRef.current;
        if (backendId) {
          void PtyService.getPtyCwd(backendId).then((resolved) => {
            if (resolved) {
              settleCwd(resolved);
            }
          });
        }
      }, 5000);
      return () => clearInterval(timer);
    }, [visible]);

    // First-show launcher for tabs that mounted hidden: spawn the PTY on
    // first visibility, or re-fit an already-live session (hidden mount
    // fit() is a no-op, so cols/rows would otherwise stay 80x24).
    useEffect(() => {
      if (!visible) return;
      const term = xtermRef.current;
      if (!term) return;
      if (!initialLaunchScheduledRef.current && !backendPtyIdRef.current) {
        initialLaunchScheduledRef.current = true;
        void initPtySession();
        return;
      }
      try {
        fitAddonRef.current?.fit();
        pushPtySize(term);
      } catch {
        // ignore hidden-tab layout errors
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [visible]);

    const handleSearch = (
      term: string,
      options: { caseSensitive: boolean; wholeWord: boolean; regex: boolean }
    ) => {
      if (!term) {
        searchAddonRef.current?.clearDecorations();
        return;
      }
      searchAddonRef.current?.findNext(term, options);
    };

    const handleSearchNext = (
      term: string,
      options: { caseSensitive: boolean; wholeWord: boolean; regex: boolean }
    ) => {
      if (term) {
        searchAddonRef.current?.findNext(term, options);
      }
    };

    const handleSearchPrevious = (
      term: string,
      options: { caseSensitive: boolean; wholeWord: boolean; regex: boolean }
    ) => {
      if (term) {
        searchAddonRef.current?.findPrevious(term, options);
      }
    };

    const handleCloseSearch = () => {
      setIsSearchVisible(false);
      searchAddonRef.current?.clearDecorations();
      xtermRef.current?.focus();
    };

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
        }}
      >
        {isSearchVisible && (
          <Suspense fallback={null}>
            <SearchBar
              onSearch={handleSearch}
              onSearchNext={handleSearchNext}
              onSearchPrevious={handleSearchPrevious}
              onClose={handleCloseSearch}
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
          <div
            className="terminal-launch-error"
            role="alert"
            aria-label="Terminal failed to start"
            style={{
              position: "absolute",
              inset: "auto 12px 12px 12px",
              padding: "10px 12px",
              borderRadius: 8,
              background: "rgba(20, 8, 8, 0.92)",
              border: "1px solid #f38ba8",
              color: "#f5e0e8",
              fontSize: 12,
              display: "flex",
              gap: 10,
              alignItems: "center",
              justifyContent: "space-between",
            }}
          >
            <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
              Shell failed to start: {launchError} — check Settings → Shell or pick another profile,
              then retry.
            </span>
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
