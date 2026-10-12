import { useState, useEffect, useRef, useCallback, Fragment } from "react";
import { Toolbar } from "./components/Toolbar";
import { TabBar } from "./components/TabBar";
import { TerminalView, TerminalViewRef } from "./components/TerminalView";
import { CommandPalette, CommandAction } from "./components/CommandPalette";
import { SettingsModal } from "./components/SettingsModal";
import { AiCliPanel } from "./components/AiCliPanel";
import { DiagnosticsModal } from "./components/DiagnosticsModal";
import { WorkspaceModal } from "./components/WorkspaceModal";
import { PtyService, isTauriAvailable } from "./services/ptyService";
import { SettingsService } from "./services/settingsService";
import {
  getGitInfoCached,
  invalidateGitCache,
  loadRecentProjects,
  recordRecentProject,
  openProjectInEditor,
  runGitAction,
  getProjectIntelligence,
  ProjectIntelligenceInfo,
} from "./services/projectService";
import {
  matchShortcut,
  isMacPlatform,
  platformLabel,
  ShortcutActionId,
} from "./services/shortcuts";
import { splitTab, closePane, clampPaneFraction } from "./services/paneLayout";
import { PersistedTabV2, sanitizeTab, Workspace } from "./services/workspaces";
import {
  ShellProfile,
  TerminalTab,
  UserSettings,
  TerminalPane,
  SplitDirection,
} from "./types/terminal";
import {
  Plus,
  Search,
  Settings,
  Trash2,
  RefreshCw,
  XCircle,
  Bot,
  Activity,
  Columns,
  Rows,
  Code,
  Edit3,
  FolderOpen,
  ArrowRight,
  ArrowLeft,
} from "lucide-react";
import "./App.css";

const LAYOUT_KEY = "terminal_tab_layout_v1";

let tabSeq = 0;

/** Collision-safe tab id (frontend-only; distinct from backend PTY UUIDs). */
function newTabId(): string {
  tabSeq += 1;
  let rand = "";
  try {
    rand =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID().slice(0, 8)
        : Math.floor(Math.random() * 0xffffffff).toString(16);
  } catch {
    rand = Math.floor(Math.random() * 0xffffffff).toString(16);
  }
  return `session-${Date.now()}-${tabSeq}-${rand}`;
}

interface PersistedTab {
  title: string;
  color?: string;
  shellPath?: string;
  cwd?: string;
  splitDirection?: PersistedTabV2["splitDirection"];
  panes?: Array<{ shellPath?: string; cwd?: string }>;
}

function loadPersistedLayout(): PersistedTab[] | null {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    // Only restore titles/cwd/shellPath/pane structure — never command history.
    // Tolerant: accepts v1 tabs and v2 tabs with panes (see workspaces.ts).
    return parsed
      .filter((t) => typeof t === "object" && t !== null)
      .slice(0, 10)
      .map((t) => sanitizeTab(t))
      .filter((t): t is PersistedTabV2 => t !== null)
      .map((t) => ({
        title: t.title,
        color: t.color,
        shellPath: t.shellPath,
        cwd: t.cwd,
        splitDirection: t.splitDirection,
        panes: t.panes,
      }));
  } catch {
    return null;
  }
}

/**
 * Closes the whole app window (desktop). Returns true when the close was
 * issued. Browser/mock fallback returns false so callers can recycle the
 * tab instead of leaving a dead pane.
 */
async function closeAppWindow(): Promise<boolean> {
  if (!isTauriAvailable()) return false;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().close();
    return true;
  } catch (err) {
    console.error("Failed to close app window:", err);
    return false;
  }
}
function createDefaultTab(
  title: string,
  shellPath?: string,
  cwd?: string,
  persisted?: PersistedTab
): TerminalTab {
  const tabId = newTabId();
  const panes: TerminalPane[] =
    persisted?.panes && persisted.panes.length > 1
      ? persisted.panes.slice(0, 4).map((p, i) => ({
          id: `${tabId}-p${i + 1}`,
          shellPath: p.shellPath ?? shellPath,
          cwd: p.cwd ?? cwd,
          status: "connecting" as const,
        }))
      : [
          {
            id: `${tabId}-p1`,
            shellPath,
            cwd,
            status: "connecting" as const,
          },
        ];
  const splitDirection = panes.length > 1 ? (persisted?.splitDirection ?? "vertical") : "none";
  return {
    id: tabId,
    title,
    color: persisted?.color,
    shellPath,
    cwd,
    status: "connecting",
    panes,
    activePaneId: panes[0].id,
    splitDirection,
  };
}

export function App() {
  const [shells, setShells] = useState<ShellProfile[]>([]);
  const [selectedShellId, setSelectedShellId] = useState<string>("");
  const [cwd, setCwd] = useState<string>("");
  const [recentProjects, setRecentProjects] = useState<string[]>(() => loadRecentProjects());
  const [gitBranch, setGitBranch] = useState<string | null>(null);
  const [gitDirty, setGitDirty] = useState<boolean>(false);
  const [projectIntel, setProjectIntel] = useState<ProjectIntelligenceInfo | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const [userSettings, setUserSettings] = useState<UserSettings>(() =>
    SettingsService.loadSettings()
  );

  const [isSettingsOpen, setIsSettingsOpen] = useState<boolean>(false);
  const [isCommandPaletteOpen, setIsCommandPaletteOpen] = useState<boolean>(false);
  const [isAiCliOpen, setIsAiCliOpen] = useState<boolean>(false);
  const [isDiagnosticsOpen, setIsDiagnosticsOpen] = useState<boolean>(false);
  const [isWorkspaceOpen, setIsWorkspaceOpen] = useState<boolean>(false);

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
  // Tabs from the previous launch, offered once via banner (never auto-run).
  const [pendingRestore, setPendingRestore] = useState<PersistedTab[] | null>(() => {
    try {
      const persisted = loadPersistedLayout();
      if (persisted && persisted.length > 0) return persisted;
    } catch {
      // ignore corrupt layout
    }
    return null;
  });

  // Terminal view refs keyed by pane ID
  const terminalRefs = useRef<Record<string, TerminalViewRef | null>>({});

  // Live mirrors so `exit` handling never runs on a stale `tabs` snapshot.
  // TerminalView registers its pty-exit listener once per pane; without
  // these refs the `onExit` closure captures the tabs array from mount time
  // and closing a later tab/pane silently no-ops (the reported "exit does
  // not close the terminal" bug).
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const activeTabIdRef = useRef(activeTabId);
  activeTabIdRef.current = activeTabId;
  const shellsRef = useRef(shells);
  shellsRef.current = shells;
  const selectedShellIdRef = useRef(selectedShellId);
  selectedShellIdRef.current = selectedShellId;
  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;

  const activeTab = tabs.find((t) => t.id === activeTabId) || tabs[0];
  const activePaneId = activeTab?.activePaneId || activeTab?.panes[0]?.id;
  const getActiveTerminal = () => terminalRefs.current[activePaneId];

  // Saving preferences applies a changed default shell to new sessions
  // and syncs the launch-at-startup toggle with the OS (all platforms).
  const handleSaveSettings = useCallback(
    (next: UserSettings) => {
      if (
        next.defaultShellId &&
        next.defaultShellId !== userSettings.defaultShellId &&
        shells.some((s) => s.id === next.defaultShellId)
      ) {
        setSelectedShellId(next.defaultShellId);
      }
      if (Boolean(next.launchAtStartup) !== Boolean(userSettings.launchAtStartup)) {
        void import("./services/autostartService").then(({ setAutostartEnabled }) =>
          setAutostartEnabled(Boolean(next.launchAtStartup)).catch((err) => {
            console.error("Failed to apply launch-at-startup setting:", err);
            setLastError(err instanceof Error ? err.message : String(err));
          })
        );
      }
      setUserSettings(next);
    },
    [shells, userSettings.defaultShellId, userSettings.launchAtStartup]
  );

  // On startup, reconcile the stored launch-at-startup preference with the
  // real OS state (user may have toggled it in OS settings outside the app).
  // The OS is the source of truth; the stored setting follows it.
  useEffect(() => {
    void import("./services/autostartService")
      .then(({ getAutostartEnabled }) => getAutostartEnabled())
      .then((enabled) => {
        setUserSettings((prev) =>
          Boolean(prev.launchAtStartup) === enabled ? prev : { ...prev, launchAtStartup: enabled }
        );
      })
      .catch(() => {
        // Mock/browser mode or backend unavailable: keep stored preference.
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load available shell profiles on startup
  useEffect(() => {
    PtyService.getAvailableShells()
      .then((loadedShells) => {
        setShells(loadedShells);
        const configuredDefault = loadedShells.find((s) => s.id === userSettings.defaultShellId);
        const defaultShell =
          configuredDefault || loadedShells.find((s) => s.is_default) || loadedShells[0];
        if (defaultShell) {
          setSelectedShellId(defaultShell.id);
        }
      })
      .catch((err) => {
        console.error("Failed to load available shells:", err);
        setLastError(err instanceof Error ? err.message : String(err));
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist safe UI layout (titles + color + cwd + pane structure only,
  // never history) on tab change. Skipped while a previous session is still
  // awaiting the user's Restore/Dismiss decision, so the banner offer is
  // never overwritten by the fresh starter tab.
  useEffect(() => {
    if (pendingRestore !== null) return;
    try {
      const safe: PersistedTab[] = tabs.slice(0, 10).map((t) => ({
        title: t.title,
        color: t.color,
        shellPath: t.shellPath,
        cwd: t.cwd,
        splitDirection: t.splitDirection,
        panes:
          t.panes.length > 1
            ? t.panes.map((p) => ({ shellPath: p.shellPath, cwd: p.cwd }))
            : undefined,
      }));
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(safe));
    } catch {
      // ignore quota errors
    }
  }, [tabs, pendingRestore]);

  // Opt-in auto-restore: when enabled in settings, the previous session
  // loads immediately without asking (previous default behavior).
  useEffect(() => {
    if (userSettings.autoRestoreSession && pendingRestore && pendingRestore.length > 0) {
      const restored = pendingRestore.map((t) => createDefaultTab(t.title, t.shellPath, t.cwd, t));
      setTabs(restored);
      setActiveTabId(restored[0].id);
      setPendingRestore(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userSettings.autoRestoreSession]);

  const handleRestoreSession = useCallback(() => {
    if (!pendingRestore || pendingRestore.length === 0) {
      setPendingRestore(null);
      return;
    }
    const restored = pendingRestore.map((t) => createDefaultTab(t.title, t.shellPath, t.cwd, t));
    setTabs(restored);
    setActiveTabId(restored[0].id);
    setPendingRestore(null);
  }, [pendingRestore]);

  const handleDismissRestore = useCallback(() => {
    setPendingRestore(null);
  }, []);

  const handleReorderTabs = useCallback((fromId: string, toId: string) => {
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

  const handleMoveTab = useCallback((id: string, dir: -1 | 1) => {
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.id === id);
      const swapIdx = idx + dir;
      if (idx < 0 || swapIdx < 0 || swapIdx >= prev.length) return prev;
      const next = [...prev];
      [next[idx], next[swapIdx]] = [next[swapIdx], next[idx]];
      return next;
    });
  }, []);

  const handleSetTabColor = useCallback((id: string, color: string | undefined) => {
    setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, color } : t)));
  }, []);

  // Poll git status for the active working directory: debounced on change
  // plus a controlled 30 s refresh. Git + intelligence queries run in
  // parallel and are cached (30 s TTL) so renders never spam the backend
  // and session startup is never blocked by badge refreshes.
  useEffect(() => {
    if (!cwd.trim()) {
      setGitBranch(null);
      setGitDirty(false);
      setProjectIntel(null);
      return;
    }
    let cancelled = false;
    const dir = cwd.trim();
    const fetch = () => {
      if (typeof document !== "undefined" && document.hidden) return;
      void Promise.allSettled([getGitInfoCached(dir), getProjectIntelligence(dir)]).then(
        ([gitRes, intelRes]) => {
          if (cancelled) return;
          if (gitRes.status === "fulfilled") {
            setGitBranch(gitRes.value.branch);
            setGitDirty(gitRes.value.dirty);
          } else {
            setGitBranch(null);
            setGitDirty(false);
          }
          if (intelRes.status === "fulfilled") {
            setProjectIntel(intelRes.value);
          } else {
            setProjectIntel(null);
          }
        }
      );
    };
    const timer = setTimeout(fetch, 600);
    const interval = setInterval(fetch, 30000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      clearInterval(interval);
    };
  }, [cwd]);

  const handleNewTab = useCallback(
    (opts?: { cwd?: string }) => {
      const dir = opts?.cwd ?? (cwd.trim() || undefined);
      if (dir) {
        setRecentProjects(recordRecentProject(dir));
      }
      const selectedShell = shells.find((s) => s.id === selectedShellId);
      const title = `${selectedShell?.name || "Terminal"} ${tabs.length + 1}`;
      const newTab = createDefaultTab(title, selectedShell?.path, dir);
      setTabs((prev) => [...prev, newTab]);
      setActiveTabId(newTab.id);
    },
    [shells, selectedShellId, tabs.length, cwd]
  );

  const handleCloseTab = useCallback(
    (id: string) => {
      // Last tab: closing it quits the app on desktop (fallback: keep it
      // in browser/mock so the window never ends up empty).
      if (tabs.length <= 1) {
        void closeAppWindow();
        return;
      }
      const newTabs = tabs.filter((t) => t.id !== id);
      setTabs(newTabs);
      if (activeTabId === id) {
        setActiveTabId(newTabs[newTabs.length - 1].id);
      }
    },
    [tabs, activeTabId]
  );

  const handleRenameTab = useCallback((id: string, newTitle: string) => {
    setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, title: newTitle } : t)));
  }, []);

  const handleSplitPane = useCallback(
    (direction: SplitDirection) => {
      if (direction !== "horizontal" && direction !== "vertical") return;
      setTabs((prev) =>
        prev.map((tab) => {
          if (tab.id !== activeTabId) return tab;
          const selectedShell = shells.find((s) => s.id === selectedShellId);
          const next = splitTab(tab, tab.id, direction, (id) => ({
            id,
            shellPath: selectedShell?.path,
            cwd: tab.cwd || cwd.trim() || undefined,
            status: "connecting",
          }));
          return { ...tab, ...next };
        })
      );
    },
    [activeTabId, shells, selectedShellId, cwd]
  );

  const handleClosePane = useCallback(() => {
    setTabs((prev) =>
      prev.map((tab) => {
        if (tab.id !== activeTabId || tab.panes.length <= 1) return tab;
        const next = closePane(tab);
        return { ...tab, ...next };
      })
    );
  }, [activeTabId]);

  const handleSessionExit = useCallback((tabId: string, paneId: string, _exitCode: number) => {
    // Any shell exit (`exit`, `logout`, Ctrl+D, kill) closes the pane/tab.
    // Previous behavior only closed on exit code 0, which made `exit`
    // appear broken whenever the shell reported a non-zero status.
    // Multi-pane: only the exited pane closes. Multi-tab: only the exited
    // tab closes. Last pane of last tab quits the whole app on desktop
    // (browser fallback recycles a fresh tab).
    // NOTE: reads live refs (not the `tabs` state closure) so exits from
    // tabs/panes created after this callback was memoized still close the
    // correct pane. Idempotent: repeated `pty-exit` events for an already
    // removed pane are ignored, so the Close-pane fallback button in
    // TerminalView can safely re-fire this.
    const liveTabs = tabsRef.current;
    const targetTab = liveTabs.find((t) => t.id === tabId);
    if (!targetTab) return;
    if (targetTab.panes.some((p) => p.id === paneId) === false) return;

    if (targetTab.panes.length > 1) {
      const remainingPanes = targetTab.panes.filter((p) => p.id !== paneId);
      const nextActivePane =
        targetTab.activePaneId === paneId ? remainingPanes[0].id : targetTab.activePaneId;
      setTabs((prev) =>
        prev.map((t) =>
          t.id === tabId
            ? {
                ...t,
                panes: t.panes.filter((p) => p.id !== paneId),
                activePaneId: nextActivePane,
                splitDirection:
                  t.panes.filter((p) => p.id !== paneId).length > 1 ? t.splitDirection : "none",
              }
            : t
        )
      );
      return;
    }

    if (liveTabs.length > 1) {
      const remainingTabs = liveTabs.filter((t) => t.id !== tabId);
      setTabs(remainingTabs);
      if (activeTabIdRef.current === tabId) {
        const targetIdx = liveTabs.findIndex((t) => t.id === tabId);
        const nextIdx = Math.max(0, targetIdx - 1);
        setActiveTabId(remainingTabs[nextIdx]?.id || remainingTabs[0].id);
      }
      return;
    }

    // Last pane of last tab exited: quit the whole app on desktop
    // (`exit` in the only session closes Kai, like a regular terminal).
    // Browser/mock fallback recycles a fresh tab so the window never ends
    // up empty/disconnected.
    void closeAppWindow().then((closed) => {
      if (closed) return;
      const liveShells = shellsRef.current;
      const liveSelectedId = selectedShellIdRef.current;
      const liveCwd = cwdRef.current;
      const selectedShell = liveShells.find((s) => s.id === liveSelectedId);
      const fresh = createDefaultTab(
        `${selectedShell?.name || "Terminal"} 1`,
        selectedShell?.path,
        liveCwd.trim() || undefined
      );
      setTabs([fresh]);
      setActiveTabId(fresh.id);
    });
  }, []);

  const handleOpenEditor = useCallback(async () => {
    try {
      await openProjectInEditor(cwd.trim() || "/", userSettings.editorPath);
    } catch (err) {
      setLastError(err instanceof Error ? err.message : String(err));
    }
  }, [cwd, userSettings.editorPath]);

  const handleGitActionRun = useCallback(
    async (action: "fetch" | "pull" | "status") => {
      try {
        const res = await runGitAction(cwd.trim() || "/", action);
        invalidateGitCache(cwd.trim());
        if (action === "status" && res) {
          alert(`Git Status (${cwd}):\n${res}`);
        } else {
          // Trigger immediate git badge refresh
          getGitInfoCached(cwd.trim()).then((info) => {
            setGitBranch(info.branch);
            setGitDirty(info.dirty);
          });
        }
      } catch (err) {
        setLastError(err instanceof Error ? err.message : String(err));
      }
    },
    [cwd]
  );

  const handleToggleSearch = useCallback(() => {
    getActiveTerminal()?.toggleSearch();
  }, [getActiveTerminal]);

  const handleRestartActive = useCallback(() => {
    getActiveTerminal()?.restart();
  }, [getActiveTerminal]);

  const handleClearActive = useCallback(() => {
    getActiveTerminal()?.clear();
  }, [getActiveTerminal]);

  const handleRestoreWorkspace = useCallback((ws: Workspace) => {
    if (!ws.tabs || ws.tabs.length === 0) return;
    const restoredTabs = ws.tabs.map((t) =>
      createDefaultTab(t.title, t.shellPath, t.cwd, {
        title: t.title,
        color: t.color,
        shellPath: t.shellPath,
        cwd: t.cwd,
        splitDirection: t.splitDirection,
        panes: t.panes,
      })
    );
    setTabs(restoredTabs);
    setActiveTabId(restoredTabs[0].id);
    if (ws.tabs[0]?.cwd) {
      setCwd(ws.tabs[0].cwd);
    }
  }, []);

  // Centralized application shortcuts: honors user-configured bindings,
  // works on Windows / Linux / macOS (Ctrl and Cmd treated as equivalent),
  // fires for Alt-based combos too, and stays active while focus is in
  // toolbar inputs (all bindings require a modifier, so normal typing is
  // never hijacked). Terminal keys (e.g. plain Ctrl+C) still reach the shell.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey || e.altKey)) return;
      // Never steal plain typing: every registered binding includes
      // Ctrl/Cmd or Alt, so typing in inputs is safe. Only skip when the
      // event target is a text field AND no modifier combo matches — handled
      // implicitly by matchShortcut returning null there.
      if (e.key === "Control" || e.key === "Shift" || e.key === "Alt" || e.key === "Meta") return;
      const action: ShortcutActionId | null = matchShortcut(e, userSettings.keybindings);
      if (!action) return;
      e.preventDefault();
      switch (action) {
        case "newTab":
          handleNewTab();
          break;
        case "closeTab":
          handleCloseTab(activeTabId);
          break;
        case "commandPalette":
          setIsCommandPaletteOpen((prev) => !prev);
          break;
        case "search":
          handleToggleSearch();
          break;
        case "restart":
          handleRestartActive();
          break;
        case "settings":
          setIsSettingsOpen((prev) => !prev);
          break;
        case "splitHorizontal":
          handleSplitPane("horizontal");
          break;
        case "splitVertical":
          handleSplitPane("vertical");
          break;
        case "closePane":
          handleClosePane();
          break;
        case "nextTab": {
          const idx = tabs.findIndex((t) => t.id === activeTabId);
          if (idx >= 0 && tabs.length > 1) {
            setActiveTabId(tabs[(idx + 1) % tabs.length].id);
          }
          break;
        }
        case "prevTab": {
          const idx = tabs.findIndex((t) => t.id === activeTabId);
          if (idx >= 0 && tabs.length > 1) {
            setActiveTabId(tabs[(idx - 1 + tabs.length) % tabs.length].id);
          }
          break;
        }
        case "nextPane": {
          if (activeTab && activeTab.panes.length > 1) {
            const pIdx = activeTab.panes.findIndex((p) => p.id === activePaneId);
            if (pIdx >= 0) {
              const nextId = activeTab.panes[(pIdx + 1) % activeTab.panes.length].id;
              setTabs((prev) =>
                prev.map((t) => (t.id === activeTab.id ? { ...t, activePaneId: nextId } : t))
              );
            }
          }
          break;
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    userSettings.keybindings,
    handleNewTab,
    handleCloseTab,
    activeTabId,
    tabs,
    activeTab,
    activePaneId,
    handleToggleSearch,
    handleRestartActive,
    handleSplitPane,
    handleClosePane,
  ]);

  // Resolve effective shell
  const baseShell = shells.find((s) => s.id === selectedShellId);
  const customPath = userSettings.customShellPath?.trim();
  const selectedShell: ShellProfile | undefined = customPath
    ? {
        id: baseShell?.id ?? "custom",
        name: baseShell ? `${baseShell.name} (custom)` : "Custom Shell",
        path: customPath,
        args: baseShell?.args,
        is_default: baseShell?.is_default ?? true,
        is_wsl: baseShell?.is_wsl ?? false,
      }
    : baseShell;

  const isMac = isMacPlatform();
  const kb = userSettings.keybindings;
  const commandActions: CommandAction[] = [
    {
      id: "new-tab",
      label: "New Terminal Session",
      category: "Terminal",
      shortcut: platformLabel(kb.newTab, isMac),
      icon: <Plus size={16} />,
      perform: () => handleNewTab(),
    },
    {
      id: "next-tab",
      label: "Next Terminal Tab",
      category: "Navigation",
      shortcut: platformLabel(kb.nextTab, isMac),
      icon: <ArrowRight size={16} />,
      perform: () => {
        const idx = tabs.findIndex((t) => t.id === activeTabId);
        if (idx >= 0 && tabs.length > 1) {
          setActiveTabId(tabs[(idx + 1) % tabs.length].id);
        }
      },
    },
    {
      id: "prev-tab",
      label: "Previous Terminal Tab",
      category: "Navigation",
      shortcut: platformLabel(kb.prevTab, isMac),
      icon: <ArrowLeft size={16} />,
      perform: () => {
        const idx = tabs.findIndex((t) => t.id === activeTabId);
        if (idx >= 0 && tabs.length > 1) {
          setActiveTabId(tabs[(idx - 1 + tabs.length) % tabs.length].id);
        }
      },
    },
    {
      id: "next-pane",
      label: "Focus Next Active Pane",
      category: "Navigation",
      shortcut: platformLabel(kb.nextPane, isMac),
      icon: <Columns size={16} />,
      perform: () => {
        if (activeTab && activeTab.panes.length > 1) {
          const pIdx = activeTab.panes.findIndex((p) => p.id === activePaneId);
          if (pIdx >= 0) {
            const nextId = activeTab.panes[(pIdx + 1) % activeTab.panes.length].id;
            setTabs((prev) =>
              prev.map((t) => (t.id === activeTab.id ? { ...t, activePaneId: nextId } : t))
            );
          }
        }
      },
    },
    {
      id: "manage-workspaces",
      label: "Manage Named Workspaces & Sessions",
      category: "Workspaces",
      icon: <FolderOpen size={16} />,
      perform: () => setIsWorkspaceOpen(true),
    },
    {
      id: "split-horizontal",
      label: "Split Pane Horizontally",
      category: "Workspaces",
      shortcut: platformLabel(kb.splitHorizontal, isMac),
      icon: <Rows size={16} />,
      perform: () => handleSplitPane("horizontal"),
    },
    {
      id: "split-vertical",
      label: "Split Pane Vertically",
      category: "Workspaces",
      shortcut: platformLabel(kb.splitVertical, isMac),
      icon: <Columns size={16} />,
      perform: () => handleSplitPane("vertical"),
    },
    {
      id: "close-pane",
      label: "Close Active Pane",
      category: "Workspaces",
      shortcut: platformLabel(kb.closePane, isMac),
      icon: <XCircle size={16} />,
      perform: handleClosePane,
    },
    {
      id: "rename-session",
      label: "Rename Active Session / Tab",
      category: "Terminal",
      icon: <Edit3 size={16} />,
      perform: () => {
        const name = prompt("Rename session title:", activeTab.title);
        if (name && name.trim()) handleRenameTab(activeTabId, name.trim());
      },
    },
    {
      id: "open-editor",
      label: "Open Project in Code Editor",
      category: "Project",
      icon: <Code size={16} />,
      perform: handleOpenEditor,
    },
    {
      id: "git-fetch",
      label: "Git Action: Fetch Updates",
      category: "Git",
      icon: <Activity size={16} />,
      perform: () => handleGitActionRun("fetch"),
    },
    {
      id: "git-pull",
      label: "Git Action: Fast-Forward Pull",
      category: "Git",
      icon: <Activity size={16} />,
      perform: () => handleGitActionRun("pull"),
    },
    {
      id: "close-tab",
      label: "Close Active Terminal Session",
      category: "Terminal",
      shortcut: platformLabel(kb.closeTab, isMac),
      icon: <XCircle size={16} />,
      perform: () => handleCloseTab(activeTabId),
    },
    {
      id: "search-terminal",
      label: "Search Terminal Output",
      category: "View",
      shortcut: platformLabel(kb.search, isMac),
      icon: <Search size={16} />,
      perform: handleToggleSearch,
    },
    {
      id: "restart-session",
      label: "Restart Active Session",
      category: "Terminal",
      shortcut: platformLabel(kb.restart, isMac),
      icon: <RefreshCw size={16} />,
      perform: handleRestartActive,
    },
    {
      id: "clear-terminal",
      label: "Clear Active Terminal Screen",
      category: "Terminal",
      icon: <Trash2 size={16} />,
      perform: handleClearActive,
    },
    {
      id: "ai-cli",
      label: "Open AI CLI Providers",
      category: "AI",
      icon: <Bot size={16} />,
      perform: () => setIsAiCliOpen(true),
    },
    {
      id: "diagnostics",
      label: "Open Diagnostics & Recovery",
      category: "Help",
      icon: <Activity size={16} />,
      perform: () => setIsDiagnosticsOpen(true),
    },
    {
      id: "open-settings",
      label: "Open Terminal Preferences",
      category: "Preferences",
      shortcut: platformLabel(kb.settings, isMac),
      icon: <Settings size={16} />,
      perform: () => setIsSettingsOpen(true),
    },
  ];

  // Drag-to-resize: per-tab first-pane fraction (0.2–0.8). Each pane keeps its
  // own TerminalView + ResizeObserver, so dragging automatically resizes the
  // correct backend PTY with real cols/rows (never zero/oversize: backend clamps).
  const [paneFractions, setPaneFractions] = useState<Record<string, number>>({});
  const dragRef = useRef<{ tabId: string; start: number; base: number } | null>(null);

  const paneFractionFor = (tabId: string) => clampPaneFraction(paneFractions[tabId] ?? 0.5);

  const beginPaneDrag = (tabId: string, clientPos: number) => {
    dragRef.current = { tabId, start: clientPos, base: paneFractionFor(tabId) };
    const move = (ev: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || drag.tabId !== tabId) return;
      const container = document.querySelector(`[data-pane-container="${tabId}"]`);
      const rect = container?.getBoundingClientRect();
      if (!rect) return;
      const vertical = activeTab?.splitDirection === "vertical";
      const size = vertical ? rect.width : rect.height;
      if (size <= 0) return;
      const delta = ((vertical ? ev.clientX : ev.clientY) - drag.start) / size;
      setPaneFractions((prev) => ({
        ...prev,
        [tabId]: clampPaneFraction(drag.base + delta),
      }));
    };
    const up = () => {
      dragRef.current = null;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div className="app-layout">
      <div className="app-header">
        <TabBar
          tabs={tabs}
          activeTabId={activeTabId}
          onSelectTab={setActiveTabId}
          onCloseTab={handleCloseTab}
          onNewTab={() => handleNewTab()}
          onRenameTab={handleRenameTab}
          onMoveTab={handleMoveTab}
          onReorderTabs={handleReorderTabs}
          onSetTabColor={handleSetTabColor}
        />
        <Toolbar
          shells={shells}
          selectedShellId={selectedShellId}
          onSelectShell={setSelectedShellId}
          cwd={cwd}
          onCwdChange={setCwd}
          recentProjects={recentProjects}
          onSelectRecent={(dir) => {
            setCwd(dir);
            setRecentProjects(recordRecentProject(dir));
          }}
          gitBranch={gitBranch}
          gitDirty={gitDirty}
          projectIntelligence={projectIntel}
          onNewTab={() => handleNewTab()}
          onSplitHorizontal={() => handleSplitPane("horizontal")}
          onSplitVertical={() => handleSplitPane("vertical")}
          onOpenEditor={handleOpenEditor}
          editorPath={userSettings.editorPath}
          onGitAction={handleGitActionRun}
          onRestart={handleRestartActive}
          onClear={handleClearActive}
          onCopy={() => getActiveTerminal()?.copySelection()}
          onPaste={async () => {
            try {
              const text = await navigator.clipboard.readText();
              if (text) {
                getActiveTerminal()?.pasteText(text);
              }
            } catch (err) {
              console.error("Failed to read clipboard:", err);
            }
          }}
          onSearch={handleToggleSearch}
          onOpenCommandPalette={() => setIsCommandPaletteOpen(true)}
          onOpenSettings={() => setIsSettingsOpen(true)}
          onOpenWorkspaces={() => setIsWorkspaceOpen(true)}
          onOpenAiCli={() => setIsAiCliOpen(true)}
          onOpenDiagnostics={() => setIsDiagnosticsOpen(true)}
        />
      </div>

      <div className="app-body">
        {pendingRestore !== null && pendingRestore.length > 0 && (
          <div
            className="session-restore-banner"
            role="status"
            aria-label="Restore previous session"
          >
            <span className="session-restore-text">
              Previous session found ({pendingRestore.length} tab
              {pendingRestore.length === 1 ? "" : "s"}). Kai started fresh for a fast launch.
            </span>
            <div className="session-restore-actions">
              <button
                type="button"
                className="btn btn-primary btn-small"
                onClick={handleRestoreSession}
              >
                Load session
              </button>
              <button
                type="button"
                className="btn btn-secondary btn-small"
                onClick={handleDismissRestore}
              >
                Start fresh
              </button>
            </div>
          </div>
        )}
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className="tab-content"
            style={{ display: tab.id === activeTabId ? "block" : "none" }}
          >
            <div className={`pane-container-${tab.splitDirection}`} data-pane-container={tab.id}>
              {tab.panes.map((pane, idx) => (
                <Fragment key={pane.id}>
                  {idx > 0 && (
                    <div
                      className={`pane-divider pane-divider-${tab.splitDirection}`}
                      role="separator"
                      aria-orientation={
                        tab.splitDirection === "vertical" ? "vertical" : "horizontal"
                      }
                      aria-label="Resize panes"
                      onPointerDown={(e) => {
                        e.preventDefault();
                        if (tab.panes.length === 2) {
                          beginPaneDrag(
                            tab.id,
                            tab.splitDirection === "vertical" ? e.clientX : e.clientY
                          );
                        }
                      }}
                    />
                  )}
                  <div
                    className={`pane-item ${pane.id === tab.activePaneId ? "active-pane" : ""}`}
                    style={
                      tab.panes.length === 2
                        ? {
                            flex: `1 1 ${(idx === 0 ? paneFractionFor(tab.id) : 1 - paneFractionFor(tab.id)) * 100}%`,
                          }
                        : undefined
                    }
                    onClick={() => {
                      setTabs((prev) =>
                        prev.map((t) => (t.id === tab.id ? { ...t, activePaneId: pane.id } : t))
                      );
                    }}
                  >
                    <TerminalView
                      ref={(el) => {
                        terminalRefs.current[pane.id] = el;
                      }}
                      sessionId={pane.id}
                      selectedShell={selectedShell}
                      cwd={pane.cwd || tab.cwd || cwd}
                      settings={userSettings}
                      visible={tab.id === activeTabId}
                      onExit={(exitCode) => {
                        handleSessionExit(tab.id, pane.id, exitCode);
                      }}
                      onSessionStatusChange={(status, message) => {
                        if (status === "error" && message) setLastError(message);
                        setTabs((prev) =>
                          prev.map((t) =>
                            t.id === tab.id
                              ? {
                                  ...t,
                                  status,
                                  errorMessage: message,
                                  panes: t.panes.map((p) =>
                                    p.id === pane.id ? { ...p, status, errorMessage: message } : p
                                  ),
                                }
                              : t
                          )
                        );
                      }}
                    />
                  </div>
                </Fragment>
              ))}
            </div>
          </div>
        ))}
      </div>

      <CommandPalette
        isOpen={isCommandPaletteOpen}
        onClose={() => setIsCommandPaletteOpen(false)}
        actions={commandActions}
      />

      <SettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        settings={userSettings}
        onSaveSettings={handleSaveSettings}
        shells={shells}
      />

      <WorkspaceModal
        isOpen={isWorkspaceOpen}
        onClose={() => setIsWorkspaceOpen(false)}
        currentTabs={tabs}
        onLoadWorkspace={handleRestoreWorkspace}
      />

      <AiCliPanel
        isOpen={isAiCliOpen}
        onClose={() => setIsAiCliOpen(false)}
        projectDir={cwd.trim()}
        onLaunchInTerminal={(dir) => {
          handleNewTab({ cwd: dir || undefined });
          setIsAiCliOpen(false);
        }}
      />

      <DiagnosticsModal
        isOpen={isDiagnosticsOpen}
        onClose={() => setIsDiagnosticsOpen(false)}
        lastError={lastError}
      />
    </div>
  );
}

export default App;
