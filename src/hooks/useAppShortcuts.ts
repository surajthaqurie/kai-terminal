import { useEffect } from "react";
import {
  isTypingTarget,
  isXtermInput,
  matchBuiltinShortcut,
  matchShortcut,
  type ShortcutActionId,
} from "../services/shortcuts";
import type { KeybindingsConfig, SplitDirection } from "../types/terminal";
import { useLatest } from "./useLatest";

export interface AppShortcutHandlers {
  keybindings: KeybindingsConfig;
  newTab: () => void;
  closeActiveTab: () => void;
  toggleCommandPalette: () => void;
  toggleSearch: () => void;
  toggleSettings: () => void;
  splitPane: (direction: SplitDirection) => void;
  closeActivePane: () => void;
  cycleTab: (step: 1 | -1) => void;
  focusNextPane: () => void;
  gotoTab: (index: number | "last") => void;
  zoomFont: (delta: 1 | -1 | 0) => void;
  toggleMusic: () => void;
  musicEvent: (name: string) => void;
  reviewChanges: () => void;
}

const MODIFIER_KEYS = new Set(["Control", "Shift", "Alt", "Meta"]);

/**
 * Centralized application shortcuts: honors user-configured bindings,
 * works on Windows / Linux / macOS (Ctrl and Cmd treated as equivalent),
 * fires for Alt-based combos too, and stays active while focus is in
 * toolbar inputs (all bindings require a modifier, so normal typing is
 * never hijacked). Terminal keys (e.g. plain Ctrl+C) still reach the shell.
 *
 * The listener is registered once and reads the latest `handlers` on every
 * key press, so it never acts on a stale tab / directory snapshot.
 */
export function useAppShortcuts(handlers: AppShortcutHandlers) {
  const latest = useLatest(handlers);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const h = latest.current;
      if (!(e.ctrlKey || e.metaKey || e.altKey)) return;
      // Never steal plain typing: every registered binding includes
      // Ctrl/Cmd or Alt, so typing in inputs is safe. Only skip when the
      // event target is a text field AND no modifier combo matches — handled
      // implicitly by matchShortcut returning null there.
      if (MODIFIER_KEYS.has(e.key)) return;
      const primary = e.ctrlKey || e.metaKey;
      if (primary && e.shiftKey && e.code === "KeyG") {
        e.preventDefault();
        h.reviewChanges();
        return;
      }
      // Universal New-Tab accelerator on every OS: Ctrl+T (Windows/Linux)
      // and Cmd+T (macOS), with or without Shift. A bare Ctrl/Cmd+T never
      // produces shell text, so it is safe to hijack — except while typing
      // in an input (rename box, shortcut recorder, search field), where
      // it must not fire and steal the keystroke.
      if (primary && !e.altKey && e.code === "KeyT" && !isTypingTarget(e.target)) {
        e.preventDefault();
        h.newTab();
        return;
      }
      const action: ShortcutActionId | null = matchShortcut(e, h.keybindings);
      if (!action) {
        // Fixed shortcuts (user bindings above win): Ctrl+= / - / 0 zoom the
        // terminal font for this session; Ctrl+1-9 jump to a tab. Skipped in
        // text fields, but the terminal's own hidden input counts as terminal.
        if (isTypingTarget(e.target) && !isXtermInput(e.target)) return;
        const builtin = matchBuiltinShortcut(e);
        if (!builtin) return;
        e.preventDefault();
        if (builtin.type === "zoom") h.zoomFont(builtin.delta);
        else h.gotoTab(builtin.index);
        return;
      }
      e.preventDefault();
      switch (action) {
        case "newTab":
          return h.newTab();
        case "closeTab":
          return h.closeActiveTab();
        case "commandPalette":
          return h.toggleCommandPalette();
        case "search":
          return h.toggleSearch();
        case "settings":
          return h.toggleSettings();
        case "splitHorizontal":
          return h.splitPane("horizontal");
        case "splitVertical":
          return h.splitPane("vertical");
        case "closePane":
          return h.closeActivePane();
        case "nextTab":
          return h.cycleTab(1);
        case "prevTab":
          return h.cycleTab(-1);
        case "nextPane":
          return h.focusNextPane();
        case "toggleMusic":
          return h.toggleMusic();
        case "musicPlayPause":
          return h.musicEvent("kai-music-toggle-play");
        case "musicNext":
          return h.musicEvent("kai-music-next");
        case "musicMute":
          return h.musicEvent("kai-music-mute");
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [latest]);
}
