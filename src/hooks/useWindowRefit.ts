import { useCallback, useEffect, useMemo, type RefObject } from "react";
import type { TerminalViewRef } from "../components/TerminalView";
import type { TerminalTab } from "../types/terminal";

/** Follow-up passes after window-restore animations settle (intermediate sizes). */
const REFIT_FOLLOW_UP_MS = [150, 500];
/** A resize burst (an OS window drag emits an event per pixel) refits once it goes quiet this long. */
const RESIZE_SETTLE_MS = 100;
/** Signals closer together than this share one immediate pass (window focus fires several). */
const IMMEDIATE_COALESCE_MS = 50;

export interface RefitTimers {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  now: () => number;
}

const realTimers: RefitTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

export interface RefitScheduler {
  /** Focus / visibility signal: refit right away (coalesced), then again after the follow-ups. */
  now(): void;
  /** Resize signal: refit once, after the burst has gone quiet, then after the follow-ups. */
  burst(): void;
  dispose(): void;
}

/**
 * Decides WHEN to run a refit `pass` for the window-level signals.
 *
 * An OS window drag-resize delivers a resize event for every step. Each used to run
 * `fit()` on every pane at once plus two follow-up timers that were never cancelled, so a
 * 2-second drag queued hundreds of full-layout passes; the container's own
 * ResizeObserver (throttled in TerminalView) already follows the size live. Now a burst
 * collapses to one pass after it settles, a new signal cancels the follow-ups still pending
 * from the previous one, and several focus signals in the same instant share one pass.
 */
export function createRefitScheduler(
  rawPass: () => void,
  timers: RefitTimers = realTimers,
  followUps: readonly number[] = REFIT_FOLLOW_UP_MS,
  settleMs: number = RESIZE_SETTLE_MS
): RefitScheduler {
  // A pass that throws (layout in transition) must never cancel the passes after it.
  const pass = () => {
    try {
      rawPass();
    } catch {
      // Ignore refit errors during layout transitions.
    }
  };
  let settleTimer: unknown = null;
  let followUpTimers: unknown[] = [];
  let lastImmediateAt = -Infinity;
  let disposed = false;

  const cancelFollowUps = () => {
    for (const handle of followUpTimers) timers.clearTimeout(handle);
    followUpTimers = [];
  };
  const scheduleFollowUps = () => {
    cancelFollowUps();
    followUpTimers = followUps.map((delay) =>
      timers.setTimeout(() => {
        if (!disposed) pass();
      }, delay)
    );
  };
  const clearSettle = () => {
    if (settleTimer !== null) {
      timers.clearTimeout(settleTimer);
      settleTimer = null;
    }
  };

  return {
    now() {
      if (disposed) return;
      clearSettle();
      const at = timers.now();
      if (at - lastImmediateAt >= IMMEDIATE_COALESCE_MS) {
        lastImmediateAt = at;
        pass();
      }
      scheduleFollowUps();
    },
    burst() {
      if (disposed) return;
      clearSettle();
      cancelFollowUps(); // the burst is still going: earlier follow-ups would fit a stale size
      settleTimer = timers.setTimeout(() => {
        settleTimer = null;
        if (disposed) return;
        lastImmediateAt = timers.now();
        pass();
        scheduleFollowUps();
      }, settleMs);
    },
    dispose() {
      disposed = true;
      clearSettle();
      cancelFollowUps();
    },
  };
}

interface WindowRefitOptions {
  tabsRef: RefObject<TerminalTab[]>;
  activeTabIdRef: RefObject<string>;
  terminalRefs: RefObject<Record<string, TerminalViewRef | null>>;
  /** The active pane's terminal, refocused when the window is re-activated. */
  getActiveTerminal?: () => TerminalViewRef | null | undefined;
}

/**
 * Whether re-activating the window may move keyboard focus into the terminal:
 * only when nothing else owns it (the page body) or a terminal already did.
 * An open dialog, the search bar or a settings field keeps its focus.
 */
export function shouldRestoreTerminalFocus(active: Element | null): boolean {
  if (!active || active === document.body || active === document.documentElement) return true;
  return active.classList.contains("xterm-helper-textarea");
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
export function useWindowRefit({
  tabsRef,
  activeTabIdRef,
  terminalRefs,
  getActiveTerminal,
}: WindowRefitOptions) {
  // One refit pass over the panes of the tab that is active when it RUNS (a follow-up
  // must not fit the panes of a tab that was left meanwhile).
  const refitPass = useCallback(() => {
    const liveTabs = tabsRef.current;
    const tab = liveTabs.find((t) => t.id === activeTabIdRef.current) || liveTabs[0];
    if (!tab) return;
    for (const pane of tab.panes) {
      const view = terminalRefs.current[pane.id];
      if (!view) continue;
      try {
        view.refit();
      } catch {
        // Ignore refit errors during layout transitions.
      }
    }
  }, [tabsRef, activeTabIdRef, terminalRefs]);

  const scheduler = useMemo(() => createRefitScheduler(refitPass), [refitPass]);
  useEffect(() => () => scheduler.dispose(), [scheduler]);

  const refitVisibleTerminals = useCallback(() => scheduler.now(), [scheduler]);

  // Multi-click fix (Windows WebView2 especially): after Alt+Tab or a click
  // that re-activates the window, keyboard input did not reach the terminal
  // until it was clicked again. Put focus back in the active pane's terminal.
  const restoreFocus = useCallback(() => {
    if (!getActiveTerminal || typeof document === "undefined") return;
    if (!shouldRestoreTerminalFocus(document.activeElement)) return;
    requestAnimationFrame(() => {
      if (shouldRestoreTerminalFocus(document.activeElement)) getActiveTerminal()?.focus();
    });
  }, [getActiveTerminal]);

  useEffect(() => {
    const onWindowFocus = () => {
      refitVisibleTerminals();
      restoreFocus();
    };
    window.addEventListener("focus", onWindowFocus);
    return () => window.removeEventListener("focus", onWindowFocus);
  }, [refitVisibleTerminals, restoreFocus]);

  useEffect(() => {
    const onVisibility = () => {
      if (!document.hidden) refitVisibleTerminals();
    };
    document.addEventListener("visibilitychange", onVisibility);
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
            .onResized(() => scheduler.burst())
            .then(track)
            .catch(() => {});
          void win
            .onFocusChanged((e) => {
              if (e.payload) {
                refitVisibleTerminals();
                restoreFocus();
              }
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
      for (const u of unlistens) {
        try {
          u();
        } catch {
          // Already removed; safe to ignore.
        }
      }
    };
  }, [refitVisibleTerminals, restoreFocus, scheduler]);
}
