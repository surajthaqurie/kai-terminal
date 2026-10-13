import { useEffect, useRef, useImperativeHandle, forwardRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import "@xterm/xterm/css/xterm.css";
import { ptyService, PtyService } from "../services/ptyService";
import { isCopyKeyEvent, isPasteKeyEvent } from "../services/shortcuts";
import { ShellProfile, SessionStatus, UserSettings } from "../types/terminal";
import { SettingsService, DEFAULT_SETTINGS } from "../services/settingsService";
import { loadCommandHistory, recordCommand, saveCommandHistory } from "../services/autocomplete";
import { SearchBar } from "./SearchBar";

export interface TerminalViewRef {
  clear: () => void;
  copySelection: () => Promise<string>;
  pasteText: (text: string) => void;
  focus: () => void;
  toggleSearch: () => void;
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
  onSessionStatusChange?: (status: SessionStatus, message?: string) => void;
  onExit?: (exitCode: number) => void;
  onCwdResolved?: (cwd: string) => void;
  onFocus?: () => void;
}

export const TerminalView = forwardRef<TerminalViewRef, TerminalViewProps>(
  (
    {
      sessionId,
      selectedShell,
      cwd,
      settings = DEFAULT_SETTINGS,
      visible = true,
      onSessionStatusChange,
      onExit,
      onCwdResolved,
      onFocus,
    },
    ref
  ) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const xtermRef = useRef<Terminal | null>(null);
    const fitAddonRef = useRef<FitAddon | null>(null);
    const searchAddonRef = useRef<SearchAddon | null>(null);
    // Backend PTY session id returned by create_pty (UUID). This is distinct
    // from the frontend tab id (`sessionId`): all IPC read/write/resize/close
    // calls and output filtering MUST use the backend id, otherwise writes
    // hit SessionNotFound and output is dropped / leaks across tabs.
    const backendPtyIdRef = useRef<string | null>(null);
    const initSeqRef = useRef<number>(0);
    const [isSearchVisible, setIsSearchVisible] = useState(false);

    // ---- Command line tracking & history ---------------------------------
    // Native Kali/Linux terminal autocompletion (ZSH autosuggestions, compinit,
    // bash-completion) is owned by the shell over the PTY. We do not inject
    // popup overlays over the buffer so Tab, arrow keys, and ghost text
    // behave identically to native Kali terminals.
    const lineBufferRef = useRef("");
    const historyRef = useRef<string[]>([]);

    const commitLineBuffer = () => {
      const line = lineBufferRef.current;
      lineBufferRef.current = "";
      if (line.trim()) {
        historyRef.current = recordCommand(historyRef.current, line);
        saveCommandHistory(historyRef.current);
      }
    };

    const trackInputData = (data: string) => {
      // Enter submits the line.
      if (data === "\r" || data === "\n" || data === "\r\n") {
        commitLineBuffer();
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
    const onFocusRef = useRef(onFocus);
    onFocusRef.current = onFocus;
    const shellRef = useRef(selectedShell);
    shellRef.current = selectedShell;
    const cwdRef = useRef(cwd);
    cwdRef.current = cwd;
    const visibleRef = useRef(visible);
    visibleRef.current = visible;
    // Tracks whether the initial PTY spawn has been scheduled, so tab
    // switches don't re-spawn a live session.
    const initialLaunchScheduledRef = useRef(false);

    useImperativeHandle(ref, () => ({
      clear: () => {
        xtermRef.current?.clear();
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
        if (text && backendId) {
          // Pasted text becomes part of the current line buffer so
          // command history stays in sync.
          lineBufferRef.current = (lineBufferRef.current + text).slice(-4096);
          PtyService.writeToPty(backendId, text).catch((e) => {
            console.error("Paste failed:", e);
          });
        }
      },
      focus: () => {
        xtermRef.current?.focus();
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
        onStatusRef.current?.("connected");
        if (sessionInfo.cwd) {
          onCwdResolvedRef.current?.(sessionInfo.cwd);
        }
      } catch (err: unknown) {
        if (mySeq !== initSeqRef.current) return;
        const errorMsg = err instanceof Error ? err.message : String(err);
        term.writeln(`\r\n\x1b[31m[Failed to launch shell: ${errorMsg}]\x1b[0m\r\n`);
        term.writeln(
          `\x1b[33m[Tip: if this persists, check your PowerShell profile or pick Command Prompt as the default shell in Settings.]\x1b[0m\r\n`
        );
        onStatusRef.current?.("error", errorMsg);
      }
    };

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

      const onTextareaFocus = () => {
        onFocusRef.current?.();
        const backendId = backendPtyIdRef.current;
        if (backendId) {
          void PtyService.getPtyCwd(backendId).then((resolved) => {
            if (resolved) onCwdResolvedRef.current?.(resolved);
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
                if (text && backendId) {
                  lineBufferRef.current = (lineBufferRef.current + text).slice(-4096);
                  ptyService.writeToPty(backendId, text).catch(() => {});
                }
              })
              .catch(() => {});
          }
          return false;
        }
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
              onCwdResolvedRef.current?.(p);
            }
          } catch {
            if (data.startsWith("file://")) {
              let p = data.replace(/^file:\/\/[^/]*\//, "/");
              if (/^\/[a-zA-Z]:/.test(p)) {
                p = p.slice(1);
              }
              if (p) onCwdResolvedRef.current?.(p);
            }
          }
          return false;
        });

        // Register OSC 9;9 handler (Windows Terminal / ConEmu CWD reporting)
        term.parser.registerOscHandler(9, (data) => {
          if (data.startsWith("9;")) {
            const p = data.slice(2);
            if (p) onCwdResolvedRef.current?.(p);
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
            onCwdResolvedRef.current?.(resolved);
          }
        });
      };

      const inputDisposable = term.onData((data) => {
        const backendId = backendPtyIdRef.current;
        if (backendId) {
          trackInputData(data);
          ptyService.writeToPty(backendId, data).catch(() => {
            // Backend already reaped the session; status update arrives via pty-exit.
          });
          // When a command is submitted (e.g. cd /location), trigger CWD detection
          if (data.includes("\r") || data.includes("\n")) {
            setTimeout(checkLiveCwd, 100);
            setTimeout(checkLiveCwd, 300);
            setTimeout(checkLiveCwd, 800);
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
      let pendingOutput = "";
      let rafScheduled = false;
      // Single xterm write of a 1 MB flood blocks the UI thread long
      // enough for Windows to flag the window "Not Responding".
      const MAX_TERM_WRITE_CHARS = 65536;

      const flushOutput = () => {
        rafScheduled = false;
        if (pendingOutput) {
          const chunk = pendingOutput;
          pendingOutput = "";
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
            requestAnimationFrame(doFlush);
          } catch {
            doFlush();
          }
          setTimeout(doFlush, 250);
        }
      };

      trackUnlisten(
        ptyService.onPtyOutput((payload) => {
          if (payload.id === backendPtyIdRef.current) {
            // Bound the pending buffer so a flood of output cannot grow
            // frontend memory without limit (xterm scrollback is also bounded).
            pendingOutput += payload.data;
            if (pendingOutput.length > 1_048_576) {
              pendingOutput = pendingOutput.slice(-1_048_576);
            }
            scheduleFlush();
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
            onCwdResolvedRef.current?.(payload.cwd);
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
            const backendId = backendPtyIdRef.current;
            if (term.cols && term.rows && backendId) {
              ptyService.resizePty(backendId, term.cols, term.rows).catch(() => {});
            }
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
        term.textarea?.removeEventListener("focus", onTextareaFocus);
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
        term.dispose();
      };
      // sessionId scopes the tab lifetime; shell/cwd changes apply on next launch.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sessionId]);

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
              onCwdResolvedRef.current?.(resolved);
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
        const backendId = backendPtyIdRef.current;
        if (term.cols && term.rows && backendId) {
          ptyService.resizePty(backendId, term.cols, term.rows).catch(() => {});
        }
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
          <SearchBar
            onSearch={handleSearch}
            onSearchNext={handleSearchNext}
            onSearchPrevious={handleSearchPrevious}
            onClose={handleCloseSearch}
          />
        )}
        <div
          ref={containerRef}
          className="terminal-xterm-host"
          role="log"
          aria-label="Terminal output"
        />
      </div>
    );
  }
);

TerminalView.displayName = "TerminalView";
