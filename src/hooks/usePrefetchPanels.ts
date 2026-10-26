import { useEffect } from "react";
import { prefetchPrimaryPanels, prefetchSecondaryPanels } from "../components/lazyPanels";

const SECONDARY_DELAY_MS = 800;
const IDLE_TIMEOUT_MS = 1500;

/**
 * Idle prefetch of on-demand panels: first open of Settings / palette /
 * AI providers paid a chunk-parse jank on Windows WebView2. Warm them once
 * after first paint so opens feel instant. Never blocks startup.
 * Starts early (requestIdleCallback or 800 ms) and also on first pointer
 * activity, so opening Settings before the timer still hits a warm chunk
 * instead of a blank Suspense fallback.
 */
export function usePrefetchPanels() {
  useEffect(() => {
    let cancelled = false;
    let idleHandle: number | null = null;
    const prefetch = () => {
      if (cancelled) return;
      prefetchPrimaryPanels();
      setTimeout(() => {
        if (!cancelled) prefetchSecondaryPanels();
      }, SECONDARY_DELAY_MS);
    };
    const prefetchOnce = () => {
      prefetch();
      window.removeEventListener("pointerdown", prefetchOnce);
      window.removeEventListener("keydown", prefetchOnce);
    };
    window.addEventListener("pointerdown", prefetchOnce);
    window.addEventListener("keydown", prefetchOnce);
    if (typeof window.requestIdleCallback === "function") {
      idleHandle = window.requestIdleCallback(prefetchOnce, { timeout: IDLE_TIMEOUT_MS });
    } else {
      idleHandle = window.setTimeout(prefetchOnce, SECONDARY_DELAY_MS) as unknown as number;
    }
    return () => {
      cancelled = true;
      window.removeEventListener("pointerdown", prefetchOnce);
      window.removeEventListener("keydown", prefetchOnce);
      if (idleHandle !== null) {
        if (typeof window.cancelIdleCallback === "function") {
          try {
            window.cancelIdleCallback(idleHandle);
          } catch {
            clearTimeout(idleHandle);
          }
        } else {
          clearTimeout(idleHandle);
        }
      }
    };
  }, []);
}
