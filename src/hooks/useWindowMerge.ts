import { useCallback, useEffect, useState } from "react";
import { isTauriAvailable } from "../services/ptyService";
import { mergeTerminalWindows, takeIncomingTabs, type TabSeed } from "../services/terminalWindows";
import { currentWindowLabel, liveTerminalWindowLabels } from "../services/windowLayouts";

/** Fired by the backend when another window handed tabs to this one. */
const TAB_INCOMING_EVENT = "kai-tab-incoming";
/** Fired by the backend when another window asks this one to move all its tabs into it. */
const MERGE_INTO_EVENT = "kai-merge-into";

interface WindowMergeOptions {
  /** Adds tabs moved here from another window. */
  receiveTabs: (seeds: TabSeed[]) => void;
  /** Moves every tab of this window into `target` (this window then closes). */
  moveAllTo: (target: string) => Promise<void>;
  notify: (kind: "error" | "info", message: string) => void;
}

/**
 * Bringing windows back together: tabs dropped on this window from another one
 * arrive here, "Merge all windows" moves every other window's tabs into this one,
 * and `otherWindows` lists the windows a tab can be moved to (for the tab menu).
 */
export function useWindowMerge({ receiveTabs, moveAllTo, notify }: WindowMergeOptions) {
  const [otherWindows, setOtherWindows] = useState<string[]>([]);

  const refreshOtherWindows = useCallback(async () => {
    const [labels, me] = await Promise.all([liveTerminalWindowLabels(), currentWindowLabel()]);
    const others = (labels ?? []).filter((l) => l !== me).sort();
    setOtherWindows((prev) => (prev.join("\n") === others.join("\n") ? prev : others));
    return others;
  }, []);

  useEffect(() => {
    if (!isTauriAvailable()) return;
    let cancelled = false;
    const offs: Array<() => void> = [];
    const drain = async () => {
      const seeds = await takeIncomingTabs();
      if (!cancelled && seeds.length > 0) receiveTabs(seeds);
    };
    const onFocus = () => void refreshOtherWindows();
    void (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      const subscriptions = await Promise.all([
        listen(TAB_INCOMING_EVENT, () => {
          void drain();
          void refreshOtherWindows();
        }),
        listen<string>(MERGE_INTO_EVENT, (event) => {
          if (typeof event.payload === "string" && event.payload) {
            void moveAllTo(event.payload);
          }
        }),
      ]).catch((err: unknown) => {
        console.warn("Could not listen for tabs from other windows:", err);
        return [] as Array<() => void>;
      });
      if (cancelled) subscriptions.forEach((off) => off());
      else offs.push(...subscriptions);
      // Anything handed over before this window was listening.
      await drain();
    })();
    void refreshOtherWindows();
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      offs.forEach((off) => off());
      window.removeEventListener("focus", onFocus);
    };
  }, [receiveTabs, moveAllTo, refreshOtherWindows]);

  /** Moves every other window's tabs into this one. */
  const mergeAllWindows = useCallback(async () => {
    if (!isTauriAvailable()) {
      notify("info", "Extra windows need the desktop app.");
      return;
    }
    try {
      const asked = await mergeTerminalWindows();
      if (asked === 0) notify("info", "There is only one window.");
    } catch (err) {
      notify(
        "error",
        `Could not merge windows: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }, [notify]);

  return { otherWindows, refreshOtherWindows, mergeAllWindows };
}
