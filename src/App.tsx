import { useState, useEffect, useRef, useCallback, Fragment } from "react";
import { Toolbar } from "./components/Toolbar";
import { TabBar } from "./components/TabBar";
import { TerminalView, TerminalViewRef } from "./components/TerminalView";
import { CommandPalette, CommandAction } from "./components/CommandPalette";
import { SettingsModal } from "./components/SettingsModal";
import { AiCliPanel } from "./components/AiCliPanel";
import { DiagnosticsModal } from "./components/DiagnosticsModal";
import { WorkspaceModal } from "./components/WorkspaceModal";
import { PtyService } from "./services/ptyService";
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
  isTypingTarget,
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
        shellPath: t.shellPath,
        cwd: t.cwd,
        splitDirection: t.splitDirection,
        panes: t.panes,
      }));
  } catch {
    return null;
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

  // Initial tabs + active id are computed once per mount from safe persisted layout.
  const initialTabsRef = useRef<TerminalTab[] | null>(null);
  if (initialTabsRef.current === null) {
    const persisted = loadPersistedLayout();
    initialTabsRef.current =
      persisted && persisted.length > 0
        ? persisted.map((t) => createDefaultTab(t.title, t.shellPath, t.cwd, t))
        : [createDefaultTab("Terminal 1")];
  }
  const [tabs, setTabs] = useState<TerminalTab[]>(initialTabsRef.current);
  const [activeTabId, setActiveTabId] = useState<string>(
    initialTabsRef.current[0]?.id ?? "session-1"
  );

  // Terminal view refs keyed by pane ID
  const terminalRefs = useRef<Record<string, TerminalViewRef | null>>({});

  const activeTab = tabs.find((t) => t.id === activeTabId) || tabs[0];
  const activePaneId = activeTab?.activePaneId || activeTab?.panes[0]?.id;
  const getActiveTerminal = () => terminalRefs.current[activePaneId];

  // Saving preferences applies a changed default shell to new sessions
  const handleSaveSettings = useCallback(
    (next: UserSettings) => {
      if (
        next.defaultShellId &&
        next.defaultShellId !== userSettings.defaultShellId &&
        shells.some((s) => s.id === next.defaultShellId)
      ) {
        setSelectedShellId(next.defaultShellId);
      }
      setUserSettings(next);
    },
    [shells, userSettings.defaultShellId]
  );

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

  // Persist safe UI layout (titles + cwd + pane structure only, never history) on tab change.
  useEffect(() => {
    try {
      const safe: PersistedTab[] = tabs.slice(0, 10).map((t) => ({
        title: t.title,
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
  }, [tabs]);

  // Poll git status for the active working directory: debounced on change
  // plus a controlled 15 s refresh. Results are cached per directory (5 s
  // TTL) so renders never spam the backend.
  useEffect(() => {
    if (!cwd.trim()) {
      setGitBranch(null);
      setGitDirty(false);
      setProjectIntel(null);
      return;
    }
    let cancelled = false;
    const fetch = () => {
      getGitInfoCached(cwd.trim())
        .then((info) => {
          if (cancelled) return;
          setGitBranch(info.branch);
          setGitDirty(info.dirty);
        })
        .catch(() => {
          if (cancelled) return;
          setGitBranch(null);
          setGitDirty(false);
        });

      getProjectIntelligence(cwd.trim())
        .then((intel) => {
          if (cancelled) return;
          setProjectIntel(intel);
        })
        .catch(() => {
          if (cancelled) return;
          setProjectIntel(null);
        });
    };
    const timer = setTimeout(fetch, 400);
    const interval = setInterval(fetch, 15000);
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
      if (tabs.length <= 1) return;
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
  // never fires while typing in text inputs, and leaves all other terminal
  // keys untouched so shell input (e.g. Ctrl+C) keeps working.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (isTypingTarget(e.target)) return;
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
