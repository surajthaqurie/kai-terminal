import { useCallback, useEffect, useRef } from "react";
import { onIndividualWindowClose } from "../services/appWindow";
import {
  currentWindowLabel,
  forgetWindowLayout,
  saveWindowLayout,
} from "../services/windowLayouts";
import type { TerminalTab } from "../types/terminal";
import { useLatest } from "./useLatest";

/** Quiet time before a changed layout is written (same as the main window). */
const SAVE_DEBOUNCE_MS = 500;

/**
 * Saves the tabs of a terminal window other than `main` (FUNC-07), so the next launch can bring
 * the window back: debounced, flushed when the page hides. When the user closes this window
 * while others stay open, its entry is forgotten and nothing is written after that.
 */
export function useExtraWindowLayout({
  tabs,
  activeTabId,
  enabled,
}: {
  tabs: TerminalTab[];
  activeTabId: string | undefined;
  enabled: boolean;
}) {
  const labelRef = useRef<string | null>(null);
  const forgottenRef = useRef(false);
  const latest = useLatest({ tabs, activeTabId });

  const flush = useCallback(() => {
    const label = labelRef.current;
    if (!enabled || forgottenRef.current || !label) return;
    saveWindowLayout(label, latest.current.tabs, latest.current.activeTabId);
  }, [enabled, latest]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void currentWindowLabel().then((label) => {
      if (cancelled) return;
      labelRef.current = label;
      flush(); // the layout may have been due before the label was known
    });
    const unsubscribe = onIndividualWindowClose(() => {
      forgottenRef.current = true;
      if (labelRef.current) forgetWindowLayout(labelRef.current);
    });
    window.addEventListener("pagehide", flush);
    return () => {
      cancelled = true;
      unsubscribe();
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [enabled, flush]);

  useEffect(() => {
    if (!enabled) return;
    const timer = setTimeout(flush, SAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [tabs, activeTabId, enabled, flush]);
}
