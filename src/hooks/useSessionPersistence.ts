import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import {
  PersistedTab,
  forgetPersistedLayout,
  loadPersistedActiveIndex,
  loadPersistedLayout,
  savePersistedLayout,
  tabFromPersisted,
} from "../services/tabFactory";
import { sanitizeWorkspaceForRestore, type Workspace } from "../services/workspaces";
import { onIndividualWindowClose } from "../services/appWindow";
import { openTerminalWindow } from "../services/terminalWindows";
import {
  clearPreviousWindows,
  liveTerminalWindowLabels,
  previousWindows,
  restoreSeedOf,
  type SavedWindowLayout,
} from "../services/windowLayouts";
import type { TerminalTab } from "../types/terminal";
import { useLatest } from "./useLatest";

interface SessionPersistenceOptions {
  tabs: TerminalTab[];
  setTabs: Dispatch<SetStateAction<TerminalTab[]>>;
  setActiveTabId: (id: string) => void;
  /** The tab in front: saved with the layout so a restart comes back to it. */
  activeTabId?: string;
  /** Opt-in: load the previous session immediately instead of offering it. */
  autoRestoreSession: boolean | undefined;
  /**
   * Only the first window saves the layout and offers to restore it. An extra
   * window shares the same storage and would overwrite the first one's layout.
   */
  enabled?: boolean;
}

/** Quiet time before a changed layout is written to storage. */
const SAVE_DEBOUNCE_MS = 500;

const toTabs = (persisted: PersistedTab[]) => persisted.map(tabFromPersisted);

/**
 * Persists the safe UI layout (titles, color, cwd, pane structure — never
 * history) and handles bringing a previous session or a saved workspace back.
 */
export function useSessionPersistence({
  tabs,
  setTabs,
  setActiveTabId,
  activeTabId,
  autoRestoreSession,
  enabled = true,
}: SessionPersistenceOptions) {
  // Which restored tab to bring to the front (read once, with the offered layout).
  const [pendingActive] = useState<number | null>(() =>
    enabled ? loadPersistedActiveIndex() : null
  );
  // Tabs from the previous launch, offered once via banner (never auto-run).
  const [pendingRestore, setPendingRestore] = useState<PersistedTab[] | null>(() => {
    if (!enabled) return null;
    const persisted = loadPersistedLayout();
    return persisted && persisted.length > 0 ? persisted : null;
  });

  // The other windows that were open when the app last quit (FUNC-07), read once the live
  // windows are known. Offered together with this window's tabs.
  const [pendingWindows, setPendingWindows] = useState<SavedWindowLayout[]>([]);
  const launchAt = useRef(Date.now());
  const mainHadLayout = useRef(pendingRestore !== null);
  // Set when this window was closed while others stayed open: nothing is saved after that.
  const forgotten = useRef(false);

  // The starter tab opened at launch. While it is the ONLY tab, restoring the
  // previous session may replace it (that is the point of "Load session");
  // once the user has opened, closed or reshuffled tabs, restored tabs are
  // added next to the live ones so no running shell is ever killed.
  const starterId = useRef<string | undefined>(tabs[0]?.id);
  const tabsRef = useLatest(tabs);
  const onlyStarter = tabs.length === 1 && tabs[0]?.id === starterId.current;

  const applyRestoredTabs = useCallback(
    (restored: TerminalTab[], activeIndex?: number | null) => {
      setTabs(restored);
      setActiveTabId((restored[activeIndex ?? 0] ?? restored[0]).id);
    },
    [setTabs, setActiveTabId]
  );

  const restorePrevious = useCallback(
    (offer: PersistedTab[], activeIndex: number | null = pendingActive) => {
      const restored = toTabs(offer);
      if (restored.length === 0) return;
      const live = tabsRef.current;
      if (live.length === 1 && live[0].id === starterId.current) {
        applyRestoredTabs(restored, activeIndex);
        return;
      }
      setTabs((prev) => [...prev, ...restored]);
      setActiveTabId((restored[activeIndex ?? 0] ?? restored[0]).id);
    },
    [applyRestoredTabs, setTabs, setActiveTabId, tabsRef, pendingActive]
  );

  /** Reopens saved windows, each with its own tabs (the shells start when shown). */
  const openWindows = useCallback((windows: SavedWindowLayout[]) => {
    for (const w of windows) {
      void openTerminalWindow({ seed: restoreSeedOf(w) }).catch((err: unknown) =>
        console.warn("Could not reopen a window from the last session:", err)
      );
    }
  }, []);

  /** The previous session's windows were offered: drop them from storage (and the offer). */
  const settleWindows = useCallback(() => {
    clearPreviousWindows(
      pendingWindows.map((w) => w.label),
      launchAt.current
    );
    setPendingWindows([]);
  }, [pendingWindows]);

  // What the offer contains. Without a saved layout of its own (it was closed before the others)
  // this window takes the newest saved window's tabs, and the rest reopen as windows.
  const offerTabs = pendingRestore ?? pendingWindows[0]?.tabs ?? null;
  const offerActive = pendingRestore ? pendingActive : (pendingWindows[0]?.activeIndex ?? null);
  const offerWindows = pendingRestore ? pendingWindows : pendingWindows.slice(1);

  // Persist on tab change. While the previous session is still waiting for a
  // decision AND nothing has changed since launch, the saved layout is left
  // alone so the offer is not overwritten by the fresh starter tab. As soon as
  // the user opens or closes a tab their work is saved again; the offer itself
  // stays loadable (from memory) until it is loaded or dismissed.
  //
  // Written at most every SAVE_DEBOUNCE_MS (a layout change used to serialise and write the
  // whole layout synchronously each time, and a cwd report is a layout change), and flushed when
  // the window hides or unmounts so the last change is never lost.
  const latestSave = useLatest({ tabs, activeTabId });
  const holdBackSave = pendingRestore !== null && onlyStarter;
  const holdBackRef = useLatest(holdBackSave);
  const pendingWindowsRef = useLatest(pendingWindows);
  const onlyStarterRef = useLatest(onlyStarter);
  const flushSave = useCallback(() => {
    if (holdBackRef.current || forgotten.current) return;
    savePersistedLayout(latestSave.current.tabs, latestSave.current.activeTabId);
    // New work replaces the previous session in storage (the offer stays loadable from memory
    // until it is loaded or dismissed), so stale windows are not offered at the next launch.
    if (!onlyStarterRef.current && pendingWindowsRef.current.length > 0) {
      clearPreviousWindows(
        pendingWindowsRef.current.map((w) => w.label),
        launchAt.current
      );
    }
  }, [latestSave, holdBackRef, onlyStarterRef, pendingWindowsRef]);

  // Closed while other windows stay open: this window's tabs leave the session (FUNC-07).
  useEffect(() => {
    if (!enabled) return;
    return onIndividualWindowClose(() => {
      forgotten.current = true;
      forgetPersistedLayout();
    });
  }, [enabled]);

  // The windows of the previous session: saved ones whose label no live window has.
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void liveTerminalWindowLabels().then((live) => {
      if (cancelled || !live) return;
      const previous = previousWindows(live);
      if (previous.length > 0) setPendingWindows(previous);
    });
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  useEffect(() => {
    if (!enabled || holdBackSave) return;
    const timer = setTimeout(flushSave, SAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [tabs, activeTabId, holdBackSave, enabled, flushSave]);

  // The window is hiding or closing: write now rather than lose the last 500 ms of changes.
  useEffect(() => {
    if (!enabled) return;
    window.addEventListener("pagehide", flushSave);
    return () => {
      window.removeEventListener("pagehide", flushSave);
      flushSave();
    };
  }, [enabled, flushSave]);

  // Opt-in auto-restore: when enabled in settings, the previous session
  // loads immediately without asking (previous default behavior).
  useEffect(() => {
    if (autoRestoreSession && pendingRestore && pendingRestore.length > 0) {
      restorePrevious(pendingRestore);
      setPendingRestore(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRestoreSession]);

  // Auto-restore also brings the previous session's other windows back once they are known.
  useEffect(() => {
    if (!autoRestoreSession || pendingWindows.length === 0) return;
    if (mainHadLayout.current) {
      openWindows(pendingWindows);
    } else {
      restorePrevious(pendingWindows[0].tabs, pendingWindows[0].activeIndex);
      openWindows(pendingWindows.slice(1));
    }
    settleWindows();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingWindows, autoRestoreSession]);

  const restoreSession = useCallback(() => {
    if (offerTabs && offerTabs.length > 0) restorePrevious(offerTabs, offerActive);
    openWindows(offerWindows);
    setPendingRestore(null);
    settleWindows();
  }, [offerTabs, offerActive, offerWindows, restorePrevious, openWindows, settleWindows]);

  const dismissRestore = useCallback(() => {
    setPendingRestore(null);
    settleWindows();
  }, [settleWindows]);

  const restoreWorkspace = useCallback(
    (ws: Workspace) => {
      if (!ws.tabs || ws.tabs.length === 0) return;
      // Re-validate persisted data at restore time: drops malformed tabs and
      // clears un-restorable cwd values. A folder that is gone by spawn time
      // opens in HOME instead (see spawnRecovery).
      // Fresh pane ids are minted below so no backend PTY session is reused.
      const safe = sanitizeWorkspaceForRestore(ws);
      if (safe.tabs.length === 0) return;
      applyRestoredTabs(toTabs(safe.tabs));
      // The user chose a different layout: the previous-session offer no longer
      // applies (and must stop holding back the saved layout).
      setPendingRestore(null);
      settleWindows();
    },
    [applyRestoredTabs, settleWindows]
  );

  /** Tabs in the offer, across this window and the windows that would reopen. */
  const offerTabCount =
    (offerTabs?.length ?? 0) + offerWindows.reduce((n, w) => n + w.tabs.length, 0);

  return {
    pendingRestore,
    pendingWindows,
    offerTabCount,
    offerWindowCount: offerTabs ? offerWindows.length + 1 : 0,
    restoreSession,
    dismissRestore,
    restoreWorkspace,
  };
}
