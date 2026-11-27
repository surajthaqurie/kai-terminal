import { useCallback, useMemo, useRef, type RefObject } from "react";
import { detachTab, moveTabToWindow, type HandoffTerminal } from "../services/tabHandoff";
import { isTauriAvailable } from "../services/ptyService";
import { terminalWindowAt, terminalWindowName } from "../services/terminalWindows";
import type { TerminalTab } from "../types/terminal";

interface TabDetachOptions {
  tabsRef: RefObject<TerminalTab[]>;
  /** Terminals by pane id (the same handles the toolbar uses). */
  terminalRefs: RefObject<Record<string, HandoffTerminal | null | undefined>>;
  /**
   * Removes the tab from this window once it has moved. Its shells were released
   * first, so removing the tab does not close them. Removing the last tab closes
   * the window (that is how a window merged into another one goes away).
   */
  removeTab: (id: string) => void;
  notify: (kind: "error" | "info", message: string) => void;
}

/** The new window opens with its tab strip under the pointer, not its corner. */
const WINDOW_OFFSET = { x: 140, y: 20 };

export interface TabMoves {
  /**
   * A tab dragged out of the bar (with the drop point) or "Move to new window". Dropped
   * over another Kai window it merges into that window; anywhere else it opens a new one.
   */
  detach: (tabId: string, screenX?: number, screenY?: number) => Promise<void>;
  /** Moves a tab into another open window ("Move to Main window"). */
  moveTo: (tabId: string, target: string) => Promise<void>;
  /** Moves every tab of this window into `target`; the emptied window then closes. */
  moveAllTo: (target: string) => Promise<void>;
}

/**
 * Moves tabs, with their running shells, between windows: out into a new window,
 * or back into one that is already open (merging windows). One move at a time; a
 * failure leaves the tab exactly where it was and says why.
 */
export function useTabDetach({
  tabsRef,
  terminalRefs,
  removeTab,
  notify,
}: TabDetachOptions): TabMoves {
  const busy = useRef(false);

  /** Runs one move with the busy guard; false when another move was already running. */
  const exclusive = useCallback(async (work: () => Promise<void>) => {
    if (busy.current) return false;
    busy.current = true;
    try {
      await work();
      return true;
    } finally {
      busy.current = false;
    }
  }, []);

  /** Hands `tab` to `target`; true when it moved (and was removed here). */
  const sendTo = useCallback(
    async (tab: TerminalTab, target: string) => {
      const result = await moveTabToWindow(tab, terminalRefs.current, target);
      if (!result.ok) {
        notify("error", result.reason);
        return false;
      }
      removeTab(tab.id);
      return true;
    },
    [terminalRefs, removeTab, notify]
  );

  const detach = useCallback(
    async (tabId: string, screenX?: number, screenY?: number) => {
      if (!isTauriAvailable()) {
        notify("info", "Extra windows need the desktop app.");
        return;
      }
      const tab = tabsRef.current.find((t) => t.id === tabId);
      if (!tab) return;
      const dropped =
        typeof screenX === "number" && typeof screenY === "number" && (screenX || screenY);
      await exclusive(async () => {
        // Dropped onto another Kai window: merge the tab into it.
        const target = dropped ? await terminalWindowAt(screenX, screenY) : null;
        if (target) {
          await sendTo(tab, target);
          return;
        }
        if (tabsRef.current.length < 2) {
          notify(
            "info",
            dropped
              ? "Drop the tab on another Kai window to move it there."
              : "A window needs at least one tab. Open another tab first."
          );
          return;
        }
        const at = dropped
          ? {
              x: Math.round(screenX - WINDOW_OFFSET.x),
              y: Math.round(screenY - WINDOW_OFFSET.y),
            }
          : undefined;
        const result = await detachTab(tab, terminalRefs.current, at);
        if (result.ok) removeTab(tab.id);
        else notify("error", result.reason);
      });
    },
    [tabsRef, terminalRefs, removeTab, notify, exclusive, sendTo]
  );

  const moveTo = useCallback(
    async (tabId: string, target: string) => {
      const tab = tabsRef.current.find((t) => t.id === tabId);
      if (!tab) return;
      await exclusive(async () => {
        await sendTo(tab, target);
      });
    },
    [tabsRef, exclusive, sendTo]
  );

  const moveAllTo = useCallback(
    async (target: string) => {
      const ran = await exclusive(async () => {
        // A snapshot: each successful move removes the tab here, and the last one
        // closes this window. Stop at the first failure so nothing is half-moved.
        for (const tab of [...tabsRef.current]) {
          if (!(await sendTo(tab, target))) return;
        }
      });
      if (!ran) {
        notify(
          "info",
          `Could not merge into ${terminalWindowName(target)}: a tab is still moving.`
        );
      }
    },
    [tabsRef, exclusive, sendTo, notify]
  );

  return useMemo(() => ({ detach, moveTo, moveAllTo }), [detach, moveTo, moveAllTo]);
}
