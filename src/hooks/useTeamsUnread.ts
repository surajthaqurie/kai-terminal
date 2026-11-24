import { useCallback, useMemo, useState } from "react";
import type { TerminalTab } from "../types/terminal";

/**
 * Unread Teams messages per tab, for the tab badge. `kai teams` reports its
 * count on its own pane's output (`core/teamsSignal`); a tab shows the sum of
 * its panes, so a split with the chat in one half still gets the badge.
 */
export function useTeamsUnread(tabs: readonly TerminalTab[]) {
  const [byPane, setByPane] = useState<Record<string, number>>({});

  /** Record one pane's count; 0 drops it. Equality-guarded: no idle re-renders. */
  const setPaneUnread = useCallback((paneId: string, count: number) => {
    setByPane((prev) => {
      if (count <= 0) {
        if (!(paneId in prev)) return prev;
        const next = { ...prev };
        delete next[paneId];
        return next;
      }
      return prev[paneId] === count ? prev : { ...prev, [paneId]: count };
    });
  }, []);

  const unreadByTab = useMemo(() => {
    const out: Record<string, number> = {};
    for (const tab of tabs) {
      let n = 0;
      for (const pane of tab.panes) n += byPane[pane.id] ?? 0;
      if (n > 0) out[tab.id] = n;
    }
    return out;
  }, [tabs, byPane]);

  return { setPaneUnread, unreadByTab };
}
