import {
  isAltGraph,
  isCopyKeyEvent,
  isPasteKeyEvent,
  matchBuiltinShortcut,
  matchShortcut,
  matchTerminalAction,
} from "./shortcuts";
import type { UserSettings } from "../types/terminal";

/** What the key handler needs from the emulator (xterm's `Terminal` satisfies it). */
export interface KeyHandlerTerm {
  hasSelection(): boolean;
  getSelection(): string;
  selectAll(): void;
  clear(): void;
  scrollToTop(): void;
  scrollToBottom(): void;
}

export interface TerminalKeyHandlerDeps {
  term: KeyHandlerTerm;
  /** Read at every key, so a Settings change applies to open panes. */
  fixedKeys: () => UserSettings["fixedKeybindings"];
  keybindings: () => UserSettings["keybindings"] | undefined;
  /** Puts text on the clipboard; must never throw. */
  copyText: (text: string) => Promise<unknown>;
  /** Reads the clipboard for a paste that no `paste` event answered. */
  readPaste: () => Promise<string>;
  /** Writes pasted text to the shell. */
  paste: (text: string) => void;
  /** How long to wait for the WebView's own `paste` event before reading the clipboard. */
  pasteFallbackMs?: number;
}

export interface TerminalKeyHandler {
  /** xterm's custom key handler: `false` = xterm must not send this key to the shell. */
  handle: (event: KeyboardEvent) => boolean;
  /** Forget a keyboard paste that is still waiting for its `paste` event (it arrived, or teardown). */
  cancelPendingPaste: () => void;
}

/**
 * The terminal's own key handling, taken out of `TerminalView` (ARCH-03) so it can be tested
 * without a component: copy and paste, the terminal-local actions, and keeping keys that belong
 * to the app (zoom, tab jump, user-bound shortcuts) from also reaching the shell.
 */
export function createTerminalKeyHandler(deps: TerminalKeyHandlerDeps): TerminalKeyHandler {
  const { term } = deps;
  let pasteFallback: ReturnType<typeof setTimeout> | undefined;
  const cancelPendingPaste = () => clearTimeout(pasteFallback);

  const handle = (event: KeyboardEvent): boolean => {
    // AltGr (Windows reports it as Ctrl+Alt): on many layouts AltGr+Shift+<letter> TYPES a
    // character, so none of the Ctrl-based shortcuts below may swallow it (FUNC-10).
    if (isAltGraph(event)) return true;
    const fixed = deps.fixedKeys();

    // Copy: Ctrl+Shift+C (Win/Linux), Cmd+C / Cmd+Shift+C (macOS), Ctrl+Insert (Win/Linux).
    // Plain Ctrl+C always reaches the shell as SIGINT; Shift+Insert is paste on every OS.
    if (isCopyKeyEvent(event, term.hasSelection(), fixed)) {
      if (event.type === "keydown") {
        // Never an unhandled rejection: a denied or missing clipboard is not an error here.
        void deps.copyText(term.getSelection());
      }
      return false;
    }

    // Paste: Ctrl+Shift+V (Win/Linux), Cmd+V (macOS), Shift+Insert. The keydown is NOT
    // cancelled, so the WebView does a native paste: it fires a `paste` event (the single
    // writer) and never shows a clipboard permission prompt. If no paste event arrives, the
    // backend reads the clipboard instead. Auto-repeat keydowns are swallowed so a held combo
    // cannot queue duplicate pastes.
    if (isPasteKeyEvent(event, fixed)) {
      if (event.type === "keydown") {
        if (event.repeat) {
          event.preventDefault();
          event.stopPropagation();
        } else {
          cancelPendingPaste();
          pasteFallback = setTimeout(() => {
            deps
              .readPaste()
              .then(deps.paste)
              .catch(() => {});
          }, deps.pasteFallbackMs ?? 150);
        }
      }
      return false;
    }

    // Terminal-local keys: select all, clear, jump to the top / bottom of the scrollback.
    const localAction = matchTerminalAction(event, fixed);
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

    // App-level zoom (Ctrl+= / - / 0) and tab jump (Ctrl+1-9) are handled by App on the bubbled
    // event; keep xterm from also sending the matching control byte to the shell.
    if (matchBuiltinShortcut(event, fixed)) return false;

    // User-bound app shortcuts (Settings > Shortcuts), search included, belong to App's window
    // handler. Returning `false` only stops xterm from sending the key to the shell (a bare F-key
    // as its escape code, Alt+<key> as ESC+<key>); it does not cancel the event, which still
    // bubbles to that handler. Handling search here as well flipped the bar twice.
    const bindings = deps.keybindings();
    if (bindings && matchShortcut(event, bindings)) return false;
    return true;
  };

  return { handle, cancelPendingPaste };
}
