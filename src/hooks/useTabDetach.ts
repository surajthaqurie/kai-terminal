import { useCallback, useRef, type MutableRefObject } from "react";
import { detachTab, type HandoffTerminal } from "../services/tabHandoff";
import { isTauriAvailable } from "../services/ptyService";
import type { TerminalTab } from "../types/terminal";

interface TabDetachOptions {
  tabsRef: MutableRefObject<TerminalTab[]>;
  /** Terminals by pane id (the same handles the toolbar uses). */
  terminalRefs: MutableRefObject<Record<string, HandoffTerminal | null | undefined>>;
  /**
   * Removes the tab from this window once it has moved. Its shells were released
   * first, so removing the tab does not close them.
   */
  removeTab: (id: string) => void;
  notify: (kind: "error" | "info", message: string) => void;
}

/** The new window opens with its tab strip under the pointer, not its corner. */
const WINDOW_OFFSET = { x: 140, y: 20 };

/**
 * Moves a tab, with its running shells, into a new window (drag it out of the
 * tab bar, or "Move to new window"). One move at a time; a failure leaves the
 * tab exactly where it was and says why.
 */
export function useTabDetach({ tabsRef, terminalRefs, removeTab, notify }: TabDetachOptions) {
  const busy = useRef(false);

  return useCallback(
    async (tabId: string, screenX?: number, screenY?: number) => {
      if (busy.current) return;
      if (!isTauriAvailable()) {
        notify("info", "Extra windows need the desktop app.");
        return;
      }
      const tab = tabsRef.current.find((t) => t.id === tabId);
      if (!tab) return;
      if (tabsRef.current.length < 2) {
        notify("info", "A window needs at least one tab. Open another tab first.");
        return;
      }
      const at =
        typeof screenX === "number" && typeof screenY === "number" && (screenX || screenY)
          ? {
              x: Math.round(screenX - WINDOW_OFFSET.x),
              y: Math.round(screenY - WINDOW_OFFSET.y),
            }
          : undefined;
      busy.current = true;
      try {
        const result = await detachTab(tab, terminalRefs.current, at);
        if (result.ok) removeTab(tab.id);
        else notify("error", result.reason);
      } finally {
        busy.current = false;
      }
    },
    [tabsRef, terminalRefs, removeTab, notify]
  );
}
