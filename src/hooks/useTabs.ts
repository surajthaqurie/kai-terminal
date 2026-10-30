import { useCallback, useEffect, useRef, useState } from "react";
import { closeAppWindow } from "../services/appWindow";
import {
  cleanCwdForStore,
  normalizeCwdForCompare,
  recordRecentProject,
  resolveEffectiveProjectDir,
} from "../services/projectService";
import {
  closePane,
  setLayoutSplitRatio,
  splitRefusal,
  splitRefusalMessage,
  splitTab,
} from "../services/paneLayout";
import { createDefaultTab } from "../services/tabFactory";
import type { SessionStatus, SplitDirection, TerminalTab } from "../types/terminal";
import { useLatest } from "./useLatest";

/** How long the "split refused" notice stays on screen. */
const PANE_NOTICE_MS = 4000;

interface TabsOptions {
  /** Global toolbar working directory (fallback for pane splits). */
  cwd: string;
  /** Effective shell binary for new sessions (custom path wins over profile). */
  effectiveShellPath: string | undefined;
  setLastError: (message: string | null) => void;
}

/**
 * Tab + pane state and every operation on it. All state transitions are
 * pure `setTabs` updates; `tabsRef` / `activeTabIdRef` mirror the latest
 * values for long-lived callbacks (pty-exit, Tauri events) that must never
 * see a stale `tabs` snapshot.
 */
export function useTabs({ cwd, effectiveShellPath, setLastError }: TabsOptions) {
  // Fast startup: always open with a single fresh tab so the window paints
  // immediately (one PTY). A previous session, if any, is offered via an
  // explicit "Restore session" banner instead of auto-spawning N shells —
  // unless the user opted into auto-restore in settings.
  const initialTabsRef = useRef<TerminalTab[] | null>(null);
  if (initialTabsRef.current === null) {
    initialTabsRef.current = [createDefaultTab("Terminal 1")];
  }
  const [tabs, setTabs] = useState<TerminalTab[]>(initialTabsRef.current);
  const [activeTabId, setActiveTabId] = useState<string>(
    initialTabsRef.current[0]?.id ?? "session-1"
  );
  const tabsRef = useLatest(tabs);
  const cwdRef = useLatest(cwd);
  const activeTabIdRef = useLatest(activeTabId);

  // Transient, non-error notice shown when a pane split is refused.
  const [paneNotice, setPaneNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!paneNotice) return;
    const timer = setTimeout(() => setPaneNotice(null), PANE_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [paneNotice]);

  const dismissPaneNotice = useCallback(() => setPaneNotice(null), []);

  const activeTab = tabs.find((t) => t.id === activeTabId) || tabs[0];
  const activePaneId = activeTab?.activePaneId || activeTab?.panes[0]?.id;
  const activePane = activeTab?.panes.find((p) => p.id === activePaneId);

  const newTab = useCallback(
    (opts?: { cwd?: string; shellPath?: string }) => {
      // A brand-new tab starts at the default (home) location, like the
      // first tab at app launch: no cwd is passed and the backend resolves
      // it to HOME/USERPROFILE at spawn. Only explicit callers (open-with
      // a folder, single-instance open) can seed a different directory.
      const dir = opts?.cwd;
      if (dir) recordRecentProject(dir);
      // Titles are always "Terminal N". Number from live tabs (not a stale
      // closure) plus a collision skip, so spam-clicking "+" and closing
      // tabs never yields duplicate titles.
      const usedTitles = new Set(tabsRef.current.map((t) => t.title));
      let n = tabsRef.current.length + 1;
      while (usedTitles.has(`Terminal ${n}`)) n += 1;
      const tab = createDefaultTab(`Terminal ${n}`, opts?.shellPath ?? effectiveShellPath, dir);
      setTabs((prev) => [...prev, tab]);
      setActiveTabId(tab.id);
    },
    [effectiveShellPath, tabsRef]
  );

  /**
   * Focus a tab already living in `dir`, or open a fresh one there. Reads
   * live refs (never state closures) so it targets the current tabs even
   * from long-lived Tauri event listeners. Used by the single-instance
   * `kai-open-project` path forward.
   */
  const openOrFocusDir = useCallback(
    (dir: string) => {
      const cleaned = cleanCwdForStore(dir);
      if (!cleaned) return;
      const norm = normalizeCwdForCompare(cleaned);
      const found = tabsRef.current.find((t) =>
        [t.cwd, ...t.panes.map((p) => p.cwd), cwdRef.current].some(
          (c) => c && normalizeCwdForCompare(cleanCwdForStore(c)) === norm
        )
      );
      if (found) {
        setActiveTabId(found.id);
        return;
      }
      newTab({ cwd: cleaned });
    },
    [newTab, tabsRef, cwdRef]
  );

  const closeTab = useCallback(
    (id: string) => {
      // Last tab: closing it quits the app on desktop (fallback: keep it
      // in browser/mock so the window never ends up empty).
      if (tabs.length <= 1) {
        void closeAppWindow();
        return;
      }
      const remaining = tabs.filter((t) => t.id !== id);
      setTabs(remaining);
      if (activeTabId === id) {
        setActiveTabId(remaining[remaining.length - 1].id);
      }
    },
    [tabs, activeTabId]
  );

  const renameTab = useCallback((id: string, title: string) => {
    setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, title } : t)));
  }, []);

  const reorderTabs = useCallback((fromId: string, toId: string) => {
    if (fromId === toId) return;
    setTabs((prev) => {
      const fromIdx = prev.findIndex((t) => t.id === fromId);
      const toIdx = prev.findIndex((t) => t.id === toId);
      if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) return prev;
      const next = [...prev];
      const [moved] = next.splice(fromIdx, 1);
      next.splice(toIdx, 0, moved);
      return next;
    });
  }, []);

  const moveTab = useCallback((id: string, dir: -1 | 1) => {
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.id === id);
      const swapIdx = idx + dir;
      if (idx < 0 || swapIdx < 0 || swapIdx >= prev.length) return prev;
      const next = [...prev];
      [next[idx], next[swapIdx]] = [next[swapIdx], next[idx]];
      return next;
    });
  }, []);

  const moveTabToIndex = useCallback((id: string, toIndex: number) => {
    setTabs((prev) => {
      const fromIdx = prev.findIndex((t) => t.id === id);
      if (fromIdx < 0) return prev;
      const clamped = Math.max(0, Math.min(prev.length - 1, toIndex));
      if (clamped === fromIdx) return prev;
      const next = [...prev];
      const [moved] = next.splice(fromIdx, 1);
      next.splice(clamped, 0, moved);
      return next;
    });
  }, []);

  const setTabColor = useCallback((id: string, color: string | undefined) => {
    setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, color } : t)));
  }, []);

  const splitPane = useCallback(
    (direction: SplitDirection) => {
      if (direction !== "horizontal" && direction !== "vertical") return;
      // A refused split used to be a silent no-op; say why (limit / size floor).
      const liveTab = tabsRef.current.find((t) => t.id === activeTabId);
      if (liveTab) {
        const refusal = splitRefusal(liveTab, direction);
        if (refusal) {
          setPaneNotice(splitRefusalMessage(refusal));
          return;
        }
      }
      setPaneNotice(null);
      setTabs((prev) =>
        prev.map((tab) => {
          if (tab.id !== activeTabId) return tab;
          // Split ONLY the active pane: inherit the active pane's cwd
          // (proper parent path chain: active pane -> tab -> toolbar).
          const fromPane = tab.panes.find((p) => p.id === tab.activePaneId);
          const inheritCwd =
            resolveEffectiveProjectDir(fromPane?.cwd, tab.cwd, cwd.trim() || undefined) ||
            undefined;
          const next = splitTab(tab, tab.id, direction, (id) => ({
            id,
            // A split opens in the shell of the terminal it was split from.
            shellPath: fromPane?.shellPath ?? effectiveShellPath,
            cwd: inheritCwd,
            status: "connecting",
            parentId: fromPane?.id,
          }));
          return { ...tab, ...next };
        })
      );
    },
    [activeTabId, effectiveShellPath, cwd, tabsRef]
  );

  const closeActivePane = useCallback(() => {
    setTabs((prev) =>
      prev.map((tab) => {
        if (tab.id !== activeTabId || tab.panes.length <= 1) return tab;
        return { ...tab, ...closePane(tab) };
      })
    );
  }, [activeTabId]);

  /** Moves keyboard focus to the next pane of the active tab (wraps). */
  const focusNextPane = useCallback(() => {
    if (!activeTab || activeTab.panes.length <= 1) return;
    const idx = activeTab.panes.findIndex((p) => p.id === activePaneId);
    if (idx < 0) return;
    const nextId = activeTab.panes[(idx + 1) % activeTab.panes.length].id;
    setTabs((prev) =>
      prev.map((t) => (t.id === activeTab.id ? { ...t, activePaneId: nextId } : t))
    );
  }, [activeTab, activePaneId]);

  /** Selects the next / previous tab (wraps). */
  const cycleTab = useCallback(
    (step: 1 | -1) => {
      const idx = tabs.findIndex((t) => t.id === activeTabId);
      if (idx >= 0 && tabs.length > 1) {
        setActiveTabId(tabs[(idx + step + tabs.length) % tabs.length].id);
      }
    },
    [tabs, activeTabId]
  );

  /** Ctrl+1..8 select by position; Ctrl+9 selects the last tab. */
  const gotoTab = useCallback(
    (index: number | "last") => {
      const liveTabs = tabsRef.current;
      const tab = liveTabs[index === "last" ? liveTabs.length - 1 : index];
      if (tab) setActiveTabId(tab.id);
    },
    [tabsRef]
  );

  /**
   * Fires on every click/pointer-down/focus inside a pane (4 call sites per
   * click). Returns the SAME array when the pane is already active so React
   * bails out instead of re-rendering the whole shell on every click while
   * selecting text.
   */
  const focusPane = useCallback((tabId: string, paneId: string) => {
    setTabs((prev) =>
      prev.some((t) => t.id === tabId && t.activePaneId !== paneId)
        ? prev.map((t) => (t.id === tabId ? { ...t, activePaneId: paneId } : t))
        : prev
    );
  }, []);

  const setPaneStatus = useCallback(
    (tabId: string, paneId: string, status: SessionStatus, message?: string) => {
      if (status === "error" && message) setLastError(message);
      setTabs((prev) =>
        prev.map((t) =>
          t.id === tabId
            ? {
                ...t,
                status,
                errorMessage: message,
                panes: t.panes.map((p) =>
                  p.id === paneId ? { ...p, status, errorMessage: message } : p
                ),
              }
            : t
        )
      );
    },
    [setLastError]
  );

  /**
   * Runs one terminal in another shell: records the binary on the pane (it is
   * what a saved session restores) and bumps `resetKey`, which re-spawns that
   * pane's PTY in place. The pane id, its split and its folder are unchanged.
   */
  const setPaneShell = useCallback((tabId: string, paneId: string, shellPath: string) => {
    setTabs((prev) =>
      prev.map((t) =>
        t.id === tabId && t.panes.some((p) => p.id === paneId)
          ? {
              ...t,
              status: "connecting" as const,
              errorMessage: undefined,
              shellPath: t.panes.length === 1 ? shellPath : t.shellPath,
              panes: t.panes.map((p) =>
                p.id === paneId
                  ? {
                      ...p,
                      shellPath,
                      status: "connecting" as const,
                      errorMessage: undefined,
                      resetKey: (p.resetKey ?? 0) + 1,
                    }
                  : p
              ),
            }
          : t
      )
    );
  }, []);

  /** Drag-to-resize: per-split ratio stored inside each tab's layout tree. */
  const resizeSplit = useCallback((tabId: string, splitId: string, ratio: number) => {
    setTabs((prev) =>
      prev.map((t) =>
        t.id === tabId && t.layout
          ? { ...t, layout: setLayoutSplitRatio(t.layout, splitId, ratio) }
          : t
      )
    );
  }, []);

  return {
    tabs,
    setTabs,
    activeTabId,
    setActiveTabId,
    tabsRef,
    activeTabIdRef,
    activeTab,
    activePaneId,
    activePane,
    paneNotice,
    dismissPaneNotice,
    newTab,
    openOrFocusDir,
    closeTab,
    renameTab,
    reorderTabs,
    moveTab,
    moveTabToIndex,
    setTabColor,
    splitPane,
    closeActivePane,
    focusNextPane,
    cycleTab,
    gotoTab,
    focusPane,
    setPaneStatus,
    setPaneShell,
    resizeSplit,
  };
}
