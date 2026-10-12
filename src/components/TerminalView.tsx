import { useEffect, useRef, useImperativeHandle, forwardRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import "@xterm/xterm/css/xterm.css";
import { ptyService, PtyService } from "../services/ptyService";
import { isCopyKeyEvent, isPasteKeyEvent } from "../services/shortcuts";
import { ShellProfile, SessionStatus, UserSettings } from "../types/terminal";
import { SettingsService, DEFAULT_SETTINGS } from "../services/settingsService";
import {
  completionRemainder,
  currentToken,
  getCompletions,
  loadCommandHistory,
  recordCommand,
  saveCommandHistory,
} from "../services/autocomplete";
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
    // explicit Close affordance instead of a terminal the user
    // "is not able to close". Cleared on (re)connect.
    const [exitedCode, setExitedCode] = useState<number | null>(null);

    // ---- Inline command autocomplete -------------------------------------
    // Fish-style helper over local history + builtin commands. The shell
    // keeps native Tab completion; we only intercept Tab while our popup
    // has a match, otherwise the keystroke passes through untouched.
    const lineBufferRef = useRef("");
    const historyRef = useRef<string[]>([]);
    const [suggestions, setSuggestions] = useState<string[]>([]);
    const [selectedSuggestion, setSelectedSuggestion] = useState(0);
    const suggestionsRef = useRef<string[]>([]);
    suggestionsRef.current = suggestions;
    const selectedRef = useRef(0);
    selectedRef.current = selectedSuggestion;
    const lineBufferForSuggestRef = useRef("");
    // Whether the backend has data for this pane (avoids popup on dead pane).
    const hasBackendRef = useRef(false);

    const refreshSuggestions = (line: string) => {
      lineBufferForSuggestRef.current = line;
      if (!hasBackendRef.current || exitedCode !== null) {
        setSuggestions([]);
        return;
      }
      const token = currentToken(line);
      if (!token) {
        setSuggestions([]);
        return;
      }
      const matches = getCompletions(token, historyRef.current);
      setSuggestions(matches);
      setSelectedSuggestion(0);
    };

    const commitLineBuffer = () => {
      const line = lineBufferRef.current;
      lineBufferRef.current = "";
      setSuggestions([]);
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
        setSuggestions([]);
        return;
      }
      // Ctrl+W deletes the last word.
      if (data === "\x17") {
        lineBufferRef.current = lineBufferRef.current.replace(/[^ \t\n]+\s*$/, "");
        refreshSuggestions(lineBufferRef.current);
        return;
      }
      // Backspace / DEL.
      if (data === "\x7f" || data === "\b") {
        lineBufferRef.current = lineBufferRef.current.slice(0, -1);
        refreshSuggestions(lineBufferRef.current);
        return;
      }
      // Escape sequences (arrows, alt combos): don't corrupt the buffer.
      if (data.startsWith("\x1b")) return;
      // Other control chars: ignore for completion tracking.
      if (/[\x00-\x1f]/.test(data)) return;
      const next = (lineBufferRef.current + data).slice(-4096);
      lineBufferRef.current = next;
      refreshSuggestions(next);
    };

    const acceptSuggestion = (suggestion: string) => {
      const token = currentToken(lineBufferForSuggestRef.current || lineBufferRef.current);
      const remainder = completionRemainder(token, suggestion);
      const backendId = backendPtyIdRef.current;
      if (remainder && backendId) {
        lineBufferRef.current = (lineBufferRef.current + remainder).slice(-4096);
        ptyService.writeToPty(backendId, remainder).catch(() => {});
      }
      setSuggestions([]);
      xtermRef.current?.focus();
    };
    const acceptSuggestionRef = useRef(acceptSuggestion);
    acceptSuggestionRef.current = acceptSuggestion;
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
          // completions stay in sync.
          lineBufferRef.current = (lineBufferRef.current + text).slice(-4096);
          refreshSuggestions(lineBufferRef.current);
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
      hasBackendRef.current = false;
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
          // A newer init superseded this attempt; reap the orphan.
          try {
            await PtyService.closePty(sessionInfo.id);
          } catch {
            // ignore
          }
          return;
        }

        backendPtyIdRef.current = sessionInfo.id;
        hasBackendRef.current = true;
        onStatusRef.current?.("connected");
        if (sessionInfo.cwd) {
          onCwdResolvedRef.current?.(sessionInfo.cwd);
        }
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

      xtermRef.current = term;
      fitAddonRef.current = fitAddon;
      searchAddonRef.current = searchAddon;

      // 2. Custom key event handler: universal copy/paste across
      // Windows / Linux / macOS + search toggle + autocomplete popup.
      // Plain Ctrl+C (no selection) always reaches the shell as SIGINT.
      term.attachCustomKeyEventHandler((event: KeyboardEvent) => {
        // Autocomplete popup navigation (only when we have matches).
        // Tab is intercepted ONLY here; otherwise it passes through so
        // native shell completion keeps working.
        const popupOpen = suggestionsRef.current.length > 0;
        if (popupOpen && event.type === "keydown" && !event.ctrlKey && !event.metaKey && !event.altKey) {
          if (event.code === "Tab") {
            event.preventDefault();
            event.stopPropagation();
            const list = suggestionsRef.current;
            acceptSuggestionRef.current(list[selectedRef.current] ?? list[0]);
            return false;
          }
          if (event.code === "ArrowDown") {
            event.preventDefault();
            event.stopPropagation();
            setSelectedSuggestion((prev) =>
              prev + 1 >= suggestionsRef.current.length ? 0 : prev + 1
            );
            return false;
          }
          if (event.code === "ArrowUp") {
            event.preventDefault();
            event.stopPropagation();
            setSelectedSuggestion((prev) =>
              prev - 1 < 0 ? suggestionsRef.current.length - 1 : prev - 1
            );
            return false;
          }
          if (event.code === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            setSuggestions([]);
            return false;
          }
        }
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
                  refreshSuggestions(lineBufferRef.current);
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
      const inputDisposable = term.onData((data) => {
        const backendId = backendPtyIdRef.current;
        if (backendId) {
          trackInputData(data);
          ptyService.writeToPty(backendId, data).catch(() => {
            // Backend already reaped the session; status update arrives via pty-exit.
          });
        }
        // Dead pane: input is ignored (use Close pane). No auto-restart.
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
            hasBackendRef.current = false;
            const exitCode = payload.exit_code ?? 0;
            setExitedCode(exitCode);
            setSuggestions([]);
            if (exitCode === 0) {
              term.writeln("\r\n\x1b[90m[Process completed]\x1b[0m\r\n");
            } else {
              term.writeln(`\r\n\x1b[33m[Process exited with code ${exitCode}]\x1b[0m\r\n`);
            }
            onStatusRef.current?.("disconnected");
            // Notify the parent on the next tick so the message above is
            // flushed to the screen before the tab unmounts (auto-close).
            // Uses the ref so the exit of a tab opened long after mount
            // still closes the right pane.
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
        hasBackendRef.current = false;
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
          className="terminal-xterm-host"
          role="log"
          aria-label="Terminal output"
        />
        {suggestions.length > 0 && exitedCode === null && (
          <div
            className="terminal-autocomplete"
            role="listbox"
            aria-label="Command suggestions. Press Tab to accept, Escape to dismiss."
          >
            <div className="terminal-autocomplete-hint">
              <span>Tab to accept</span>
              <span>↑↓ to navigate</span>
              <span>Esc to dismiss</span>
            </div>
            {suggestions.map((s, idx) => (
              <button
                key={`${s}-${idx}`}
                type="button"
                role="option"
                aria-selected={idx === selectedSuggestion}
                className={`terminal-autocomplete-item ${idx === selectedSuggestion ? "selected" : ""}`}
                onMouseEnter={() => setSelectedSuggestion(idx)}
                onClick={() => acceptSuggestion(s)}
                title={s}
              >
                <span className="terminal-autocomplete-text">{s}</span>
                <kbd className="terminal-autocomplete-key">{idx === selectedSuggestion ? "Tab" : ""}</kbd>
              </button>
            ))}
          </div>
        )}
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
              is dead — close it.
            </span>
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
