import { useCallback, useEffect, type MutableRefObject } from "react";
import type { TerminalViewRef } from "../components/TerminalView";
import type { TerminalTab } from "../types/terminal";

/** Follow-up passes after window-restore animations settle (intermediate sizes). */
const REFIT_FOLLOW_UP_MS = [150, 500];

interface WindowRefitOptions {
  tabsRef: MutableRefObject<TerminalTab[]>;
  activeTabIdRef: MutableRefObject<string>;
  terminalRefs: MutableRefObject<Record<string, TerminalViewRef | null>>;
}

/**
 * Blank-on-reopen fix (Windows, Linux, macOS): another app taking focus (or
 * minimizing then restoring the OS window, or hiding/showing the WebView)
 * can leave xterm viewports laid out at 0x0 so panes paint blank until the
 * next tab switch. Re-fit every live pane of the active tab on every
 * visibility / focus / resize signal so the window always repaints with
 * real cols/rows on all three OSes.
 *
 * Every pane of the active tab is re-fit (all splits are visible at once)
 * across three passes: WebView2, WebKitGTK and WKWebView each deliver
 * intermediate sizes while a window-restore animation runs, which a single
 * synchronous fit misses.
 */
export function useWindowRefit({ tabsRef, activeTabIdRef, terminalRefs }: WindowRefitOptions) {
  const refitVisibleTerminals = useCallback(() => {
    const liveTabs = tabsRef.current;
    const tab = liveTabs.find((t) => t.id === activeTabIdRef.current) || liveTabs[0];
    if (!tab) return;
    const views = tab.panes
      .map((p) => terminalRefs.current[p.id])
      .filter((v): v is TerminalViewRef => v !== null && v !== undefined);
    if (views.length === 0) return;
    const pass = () => {
      for (const view of views) {
        try {
          view.refit();
        } catch {
          // Ignore refit errors during layout transitions.
        }
      }
    };
    pass();
    for (const delay of REFIT_FOLLOW_UP_MS) setTimeout(pass, delay);
  }, [tabsRef, activeTabIdRef, terminalRefs]);

  useEffect(() => {
    const onVisibility = () => {
      if (!document.hidden) refitVisibleTerminals();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", refitVisibleTerminals);
    let cancelled = false;
    const unlistens: Array<() => void> = [];
    // The listen promises resolve asynchronously: if the effect already
    // cleaned up (fast unmount / StrictMode double-invoke), unlisten right
    // away instead of pushing into an array nobody will drain again.
    const track = (u: () => void) => {
      if (cancelled) {
        try {
          u();
        } catch {
          // Already removed; safe to ignore.
        }
      } else {
        unlistens.push(u);
      }
    };
    void import("@tauri-apps/api/window")
      .then(({ getCurrentWindow }) => {
        if (cancelled) return;
        try {
          const win = getCurrentWindow();
          void win
            .onResized(() => refitVisibleTerminals())
            .then(track)
            .catch(() => {});
          void win
            .onFocusChanged((e) => {
              if (e.payload) refitVisibleTerminals();
            })
            .then(track)
            .catch(() => {});
        } catch {
          // Browser/mock mode: document + window listeners above suffice.
        }
      })
      .catch(() => {
        // Browser/mock mode: document + window listeners above suffice.
      });
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", refitVisibleTerminals);
      for (const u of unlistens) {
        try {
          u();
        } catch {
          // Already removed; safe to ignore.
        }
      }
    };
  }, [refitVisibleTerminals]);
}
