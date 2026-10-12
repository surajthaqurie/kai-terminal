import { useEffect, useRef, useImperativeHandle, forwardRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import "@xterm/xterm/css/xterm.css";
import { ptyService, PtyService } from "../services/ptyService";
import { isPasteKeyEvent } from "../services/shortcuts";
import { ShellProfile, SessionStatus, UserSettings } from "../types/terminal";
import { SettingsService, DEFAULT_SETTINGS } from "../services/settingsService";
import { SearchBar } from "./SearchBar";

export interface TerminalViewRef {
  clear: () => void;
  copySelection: () => Promise<string>;
  pasteText: (text: string) => void;
  restart: () => void;
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
    // `exit` leaves the shell dead: track it so the pane always offers an
    // explicit Restart / Close affordance instead of a terminal the user
    // "is not able to close". Cleared on (re)connect.
    const [exitedCode, setExitedCode] = useState<number | null>(null);
    // The pty-output/pty-exit listeners are registered once per pane
    // (effect deps `[sessionId]`), so they must go through refs to always
    // call the LATEST callbacks/props. Otherwise `exit` fires a stale
    // `onExit` closure with a stale `tabs` snapshot and the pane/tab never
    // closes.
    const onExitRef = useRef(onExit);
    onExitRef.current = onExit;
    const onStatusRef = useRef(onSessionStatusChange);
    onStatusRef.current = onSessionStatusChange;
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
          PtyService.writeToPty(backendId, text).catch((e) => {
            console.error("Paste failed:", e);
          });
        }
      },
      restart: () => {
        void initPtySession();
      },
      focus: () => {
        xtermRef.current?.focus();
      },
      toggleSearch: () => {
        setIsSearchVisible((prev) => !prev);
      },
    }));

    const initPtySession = async () => {
      const term = xtermRef.current;
      const fitAddon = fitAddonRef.current;
      if (!term || !fitAddon) return;
      const mySeq = ++initSeqRef.current;
      setExitedCode(null);

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
      term.writeln("\x1b[36m[Initializing PTY Session...]\x1b[0m\r\n");
      onStatusRef.current?.("connecting");

      try {
        fitAddon.fit();
      } catch {
        // Ignore fit errors during hidden-tab layout.
      }
      const cols = term.cols || 80;
      const rows = term.rows || 24;

      try {
        const sessionInfo = await PtyService.createPty({
          shell_path: shellRef.current?.path ?? selectedShell?.path,
          args: shellRef.current?.args ?? selectedShell?.args,
          cwd: (() => {
            const c = cwdRef.current ?? cwd;
            return c && c.trim() ? c.trim() : undefined;
          })(),
          cols,
          rows,
        });
        if (mySeq !== initSeqRef.current) {
          // A newer restart superseded this attempt; reap the orphan.
          try {
            await PtyService.closePty(sessionInfo.id);
          } catch {
            // ignore
          }
          return;
        }

        backendPtyIdRef.current = sessionInfo.id;
        onStatusRef.current?.("connected");
        term.writeln(
          `\x1b[32m[Connected to ${shellRef.current?.name || selectedShell?.name || "Shell"} (PID ${sessionInfo.pid ?? "N/A"})]\x1b[0m\r\n`
        );
      } catch (err: unknown) {
        if (mySeq !== initSeqRef.current) return;
        const errorMsg = err instanceof Error ? err.message : String(err);
        term.writeln(`\r\n\x1b[31m[Failed to launch shell: ${errorMsg}]\x1b[0m\r\n`);
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

      xtermRef.current = term;
      fitAddonRef.current = fitAddon;
      searchAddonRef.current = searchAddon;

      // 2. Custom key event handler: universal copy/paste across
      // Windows / Linux / macOS + search toggle. Plain Ctrl+C (no selection)
      // always reaches the shell as SIGINT.
      term.attachCustomKeyEventHandler((event: KeyboardEvent) => {
        const mod = event.ctrlKey || event.metaKey;
        // Copy: Ctrl+Shift+C (Win/Linux), Cmd+C (macOS), Ctrl+Insert
        const isCopy =
          (mod &&
            event.code === "KeyC" &&
            (event.shiftKey || event.metaKey) &&
            term.hasSelection()) ||
          (event.shiftKey && event.code === "Insert" && term.hasSelection());
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

      // 3. User keyboard input forwarding without altering terminal escape sequences
      const inputDisposable = term.onData((data) => {
        const backendId = backendPtyIdRef.current;
        if (backendId) {
          ptyService.writeToPty(backendId, data).catch(() => {
            // Backend already reaped the session; status update arrives via pty-exit.
          });
        } else {
          // Terminal disconnected/exited: Enter restarts a fresh shell session
          if (data === "\r" || data === "\n") {
            void initPtySession();
          }
        }
      });

      // 4. Output streaming (batched per animation frame to avoid UI freeze
      // on high-volume output) & process exit event listeners. Filtering uses
      // the backend PTY id so concurrent tabs stay isolated.
      let unlistenOutput: (() => void) | undefined;
      let unlistenExit: (() => void) | undefined;
      let pendingOutput = "";
      let rafScheduled = false;

      const flushOutput = () => {
        rafScheduled = false;
        if (pendingOutput) {
          const chunk = pendingOutput;
          pendingOutput = "";
          try {
            term.write(chunk);
          } catch {
            // Terminal disposed; drop remaining output.
          }
        }
      };

      const scheduleFlush = () => {
        if (!rafScheduled) {
          rafScheduled = true;
          requestAnimationFrame(flushOutput);
        }
      };

      ptyService
        .onPtyOutput((payload) => {
          if (payload.id === backendPtyIdRef.current) {
            // Bound the pending buffer so a flood of output cannot grow
            // frontend memory without limit (xterm scrollback is also bounded).
            pendingOutput += payload.data;
            if (pendingOutput.length > 1_048_576) {
              pendingOutput = pendingOutput.slice(-1_048_576);
            }
            scheduleFlush();
          }
        })
        .then((unlisten) => {
          unlistenOutput = unlisten;
        });

      ptyService
        .onPtyExit((payload) => {
          if (payload.id === backendPtyIdRef.current) {
            flushOutput();
            backendPtyIdRef.current = null;
            const exitCode = payload.exit_code ?? 0;
            setExitedCode(exitCode);
            if (exitCode === 0) {
              term.writeln("\r\n\x1b[90m[Process completed — press Enter to restart]\x1b[0m\r\n");
            } else {
              term.writeln(
                `\r\n\x1b[33m[Process exited with code ${exitCode} — press Enter to restart]\x1b[0m\r\n`
              );
            }
            onStatusRef.current?.("disconnected");
            // Notify the parent on the next tick so the "press Enter"
            // message above is flushed to the screen before the tab
            // unmounts (auto-close). Uses the ref so the exit of a tab
            // opened long after mount still closes the right pane.
            const code = exitCode;
            setTimeout(() => onExitRef.current?.(code), 0);
          }
        })
        .then((unlisten) => {
          unlistenExit = unlisten;
        });

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
      // - Visible panes wait one paint (~50 ms) so the window renders
      //   before the blocking-ish spawn IPC, avoiding "not responding".
      let initialTimer: ReturnType<typeof setTimeout> | null = null;
      if (visibleRef.current) {
        initialLaunchScheduledRef.current = true;
        initialTimer = setTimeout(() => {
          initialTimer = null;
          void initPtySession();
        }, 50);
      }

      // Clean disposal on unmount or session switch: close the BACKEND session
      // id (not the tab id) so no orphan child process survives.
      return () => {
        initSeqRef.current += 1;
        if (initialTimer) clearTimeout(initialTimer);
        inputDisposable.dispose();
        resizeObserver.disconnect();
        if (resizeTimer) clearTimeout(resizeTimer);
        if (unlistenOutput) unlistenOutput();
        if (unlistenExit) unlistenExit();
        const backendId = backendPtyIdRef.current;
        backendPtyIdRef.current = null;
        if (backendId) {
          ptyService.closePty(backendId).catch(() => {
            // Already reaped; safe to ignore.
          });
        }
        term.dispose();
      };
      // sessionId scopes the tab lifetime; shell/cwd changes apply on restart.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sessionId]);

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
          className="xterm-viewport"
          role="log"
          aria-label="Terminal output"
        />
        {exitedCode !== null && (
          <div
            role="status"
            aria-label="Terminal session exited"
            style={{
              position: "absolute",
              left: 8,
              right: 8,
              bottom: 8,
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "8px 12px",
              borderRadius: 8,
              background: "rgba(0,0,0,0.75)",
              color: "#fff",
              fontSize: 12,
              zIndex: 5,
            }}
          >
            <span style={{ flex: 1 }}>
              Shell exited{exitedCode !== 0 ? ` (code ${exitedCode})` : ""} after `exit`. This pane
              is dead — restart it or close it.
            </span>
            <button
              type="button"
              onClick={() => void initPtySession()}
              style={{
                padding: "4px 10px",
                borderRadius: 6,
                border: "1px solid #4ade80",
                background: "#166534",
                color: "#fff",
                cursor: "pointer",
              }}
            >
              Restart
            </button>
            <button
              type="button"
              onClick={() => onExitRef.current?.(exitedCode ?? 0)}
              style={{
                padding: "4px 10px",
                borderRadius: 6,
                border: "1px solid #f87171",
                background: "#7f1d1d",
                color: "#fff",
                cursor: "pointer",
              }}
            >
              Close pane
            </button>
          </div>
        )}
      </div>
    );
  }
);

TerminalView.displayName = "TerminalView";
