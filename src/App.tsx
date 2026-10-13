import { useState, useEffect, useRef, useCallback } from "react";
import { Toolbar } from "./components/Toolbar";
import { TabBar } from "./components/TabBar";
import { StatusBar } from "./components/StatusBar";
import { UpdateBanner } from "./components/UpdateBanner";
import { TerminalView, TerminalViewRef } from "./components/TerminalView";
import { CommandPalette, CommandAction } from "./components/CommandPalette";
import { SettingsModal } from "./components/SettingsModal";
import { AiCliPanel } from "./components/AiCliPanel";
import { DiagnosticsModal } from "./components/DiagnosticsModal";
import { WorkspaceModal } from "./components/WorkspaceModal";
import { GitStatusModal } from "./components/GitStatusModal";
import { GitChangesModal } from "./components/GitChangesModal";
import { PtyService, isTauriAvailable } from "./services/ptyService";
import { SettingsService, DEFAULT_SETTINGS } from "./services/settingsService";
import {
  getActiveProject,
  getActiveProjectState,
  getGitInfoCached,
  invalidateGitCache,
  isCodeModeActiveForDir,
  loadRecentProjects,
  recordRecentProject,
  openProjectInEditor,
  runGitAction,
  getInstalledEditors,
  resolveEffectiveProjectDir,
  GitInfo,
  InstalledEditor,
} from "./services/projectService";
import {
  matchShortcut,
  isMacPlatform,
  isTypingTarget,
  platformLabel,
  ShortcutActionId,
} from "./services/shortcuts";
import {
  splitTab,
  closePane,
  setLayoutSplitRatio,
  createPaneLayout,
  removePaneFromLayout,
  clampPaneFraction,
} from "./services/paneLayout";
import {
  APP_VERSION_FALLBACK,
  UPDATE_PERIODIC_MS,
  UpdateCheckResult,
  checkForUpdates,
  dismissVersion,
  getAppVersion,
  isDismissed,
  openReleasePage,
  recordCheckTime,
  shouldAutoCheck,
} from "./services/updateService";
import {
  PersistedTabV2,
  sanitizeTab,
  Workspace,
  nodeToPersistedLayout,
  persistedLayoutToNode,
} from "./services/workspaces";
import {
  ShellProfile,
  TerminalTab,
  UserSettings,
  TerminalPane,
  SplitDirection,
  PaneLayoutNode,
  PaneSplitDirection,
} from "./types/terminal";
import {
  Plus,
  Search,
  Settings,
  Trash2,
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
  GitCompare,
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
  layout?: PersistedTabV2["layout"];
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
        layout: t.layout,
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
  const paneIds = panes.map((p) => p.id);
  // Restore the nested split tree when refs are valid; otherwise fall back
  // to the legacy flat chain so old sessions still render.
  const restoredLayout = persisted?.layout
    ? persistedLayoutToNode(persisted.layout, paneIds)
    : undefined;
  let fullLayout: PaneLayoutNode | undefined = restoredLayout;
  if (!fullLayout) {
    if (paneIds.length <= 1) {
      fullLayout = { kind: "pane", paneId: paneIds[0] };
    } else {
      const axis = (
        splitDirection === "horizontal" ? "horizontal" : "vertical"
      ) as PaneSplitDirection;
      let node: PaneLayoutNode = { kind: "pane", paneId: paneIds[0] };
      for (const id of paneIds.slice(1)) {
        node = {
          kind: "split",
          id: `restored-${tabId}-${id}`,
          direction: axis,
          ratio: 0.5,
          first: node,
          second: { kind: "pane", paneId: id },
        };
      }
      fullLayout = node;
    }
  }
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
    layout: fullLayout,
  };
}

export function App() {
  const [shells, setShells] = useState<ShellProfile[]>([]);
  const [selectedShellId, setSelectedShellId] = useState<string>("");
  const [cwd, setCwd] = useState<string>("");
  // Recent-project history is still recorded (initial cwd + persistence),
  // but it is surfaced only via the status-bar footer — not the toolbar.
  const [, setRecentProjects] = useState<string[]>(() => loadRecentProjects());
  const [gitBranch, setGitBranch] = useState<string | null>(null);
  const [gitDirty, setGitDirty] = useState<boolean>(false);
  const [gitRepoRoot, setGitRepoRoot] = useState<string | null>(null);
  const [appVersion, setAppVersion] = useState<string>(APP_VERSION_FALLBACK);
  const [updateInfo, setUpdateInfo] = useState<UpdateCheckResult | null>(null);
  const [isCheckingUpdates, setIsCheckingUpdates] = useState<boolean>(false);
  const [updateBannerVisible, setUpdateBannerVisible] = useState<boolean>(false);
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

  // Crash-loop / instant-death guards (all OSes, release included): a
  // shell binary that is missing, not runnable, or exits instantly must
  // never freeze the window in spawn churn, nor silently quit the app a
  // fraction of a second after launch. Rapid exits park the tab in `error`
  // with an actionable banner (Retry / Settings) instead of closing,
  // recycling, or quitting. Timestamps age out, so a healthy shell that
  // stays up never trips the detector.
  const exitTimesRef = useRef<number[]>([]);
  const tabBornRef = useRef<Record<string, number>>({});
  const [loopFault, setLoopFault] = useState<{
    tabId: string;
    paneId: string;
    message: string;
  } | null>(null);

  // Birth record for every tab (initial, restored, workspace, new) so the
  // last-session exit path can tell "user typed exit" apart from "the
  // shell died 500 ms after launch with a broken binary".
  useEffect(() => {
    const born = tabBornRef.current;
    const now = Date.now();
    for (const t of tabs) {
      if (!(t.id in born)) born[t.id] = now;
    }
  }, [tabs]);

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
  const activePane = activeTab?.panes.find((p) => p.id === activePaneId);
  const getActiveTerminal = () => terminalRefs.current[activePaneId];
  /** Re-fit the active pane after the OS window is restored/refocused. */
  const refitActiveTerminal = useCallback(() => {
    const liveTabs = tabsRef.current;
    const tabId = activeTabIdRef.current;
    const tab = liveTabs.find((t) => t.id === tabId) || liveTabs[0];
    const paneId = tab?.activePaneId || tab?.panes[0]?.id;
    const view = paneId ? terminalRefs.current[paneId] : undefined;
    try {
      view?.refit();
    } catch {
      // Ignore refit errors during layout transitions.
    }
    // Second pass after window animations settle (intermediate sizes).
    setTimeout(() => {
      try {
        view?.refit();
      } catch {
        // Ignore refit errors during layout transitions.
      }
    }, 150);
  }, []);
  /** Effective project dir: active pane -> tab -> global toolbar input. */
  const effectiveProjectDir = resolveEffectiveProjectDir(activePane?.cwd, activeTab?.cwd, cwd);

  const [installedEditors, setInstalledEditors] = useState<InstalledEditor[]>([]);
  const [isLoadingEditors, setIsLoadingEditors] = useState(false);
  const [renameModalTab, setRenameModalTab] = useState<TerminalTab | null>(null);
  const [renameInputValue, setRenameInputValue] = useState("");
  // Centered in-app git status and VS Code-style changes/diff review modal.
  const [gitStatusModal, setGitStatusModal] = useState<{ dir: string; output: string } | null>(
    null
  );
  const [gitChangesModal, setGitChangesModal] = useState<{ dir: string } | null>(null);
  // AI providers panel is scoped to a specific pane's directory, so each
  // split gets its own agent setup context instead of sharing one global.
  const [aiCliDir, setAiCliDir] = useState<string>("");
  // Code Mode badge state: driven ONLY by the persisted active project
  // (`kai code <path>` sets it, `kai stop code` clears it). The backend
  // reads `~/.kai/active_project.json` + launch env, so dev and release
  // builds agree. Recent folders / new tabs never activate Code Mode.
  // Polled so an externally-run CLI updates the footer without a restart.
  // Per-split semantics: a pane is in Code Mode when its own directory is
  // the indexed project or lives inside it (see isCodeModeActiveForDir).
  // Splits in different repos therefore show different badges.
  const [codeModeProject, setCodeModeProject] = useState<string | null>(() => {
    try {
      return getActiveProject();
    } catch {
      return null;
    }
  });
  // Per-pane git info: each split tracks its own repo/branch/dirty state
  // keyed by resolved directory. The status bar shows the active pane's
  // entry; each PaneHeader shows its own entry.
  const [gitInfoByDir, setGitInfoByDir] = useState<Record<string, GitInfo | null>>({});
  useEffect(() => {
    let cancelled = false;
    const syncCodeMode = () => {
      // Authoritative async state (backend file + launch env, then explicit
      // localStorage). Never resolves recent history to code.
      void getActiveProjectState().then((s) => {
        if (!cancelled) setCodeModeProject(s.mode === "code" ? s.path : null);
      });
    };
    syncCodeMode();
    window.addEventListener("focus", syncCodeMode);
    const id = setInterval(syncCodeMode, 2000);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", syncCodeMode);
      clearInterval(id);
    };
  }, []);
  const refreshInstalledEditors = useCallback(() => {
    setIsLoadingEditors(true);
    void getInstalledEditors()
      .then((list) => setInstalledEditors(list))
      .catch(() => setInstalledEditors([]))
      .finally(() => setIsLoadingEditors(false));
  }, []);
  // Detect installed IDEs after initial paint so startup remains instant
  useEffect(() => {
    const timer = setTimeout(() => {
      refreshInstalledEditors();
    }, 150);
    return () => clearTimeout(timer);
  }, [refreshInstalledEditors]);

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

  // On startup, detect host terminal preferences (Kali Linux terminal / system font) and sync defaults
  useEffect(() => {
    if (!isTauriAvailable()) return;
    void SettingsService.loadSystemDefaults().then((sysDefaults) => {
      if (sysDefaults && Object.keys(sysDefaults).length > 0) {
        setUserSettings((prev) => {
          const isDefaultFont =
            prev.fontFamily === DEFAULT_SETTINGS.fontFamily ||
            prev.fontFamily === 'Menlo, Monaco, "Courier New", monospace';
          const isDefaultSize = prev.fontSize === 14 || prev.fontSize === 12;
          const next = {
            ...prev,
            ...(isDefaultFont && sysDefaults.fontFamily
              ? { fontFamily: sysDefaults.fontFamily }
              : {}),
            ...(isDefaultSize ? { fontSize: 12 } : {}),
            ...(prev.theme === "kali" && sysDefaults.theme ? { theme: sysDefaults.theme } : {}),
          };
          return next;
        });
      }
    });
  }, []);

  // Synchronize active theme to documentElement, color-scheme, and theme-color meta
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", userSettings.theme);
    document.documentElement.style.colorScheme =
      userSettings.theme === "solarized-light" ? "light" : "dark";
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) {
      meta.setAttribute("content", SettingsService.getThemeCanvasColor(userSettings.theme));
    }
  }, [userSettings.theme]);

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
      const safe: PersistedTab[] = tabs.slice(0, 10).map((t) => {
        const paneIds = t.panes.map((p) => p.id);
        return {
          title: t.title,
          color: t.color,
          shellPath: t.shellPath,
          cwd: t.cwd,
          splitDirection: t.splitDirection,
          panes:
            t.panes.length > 1
              ? t.panes.map((p) => ({ shellPath: p.shellPath, cwd: p.cwd }))
              : undefined,
          layout:
            t.layout && t.panes.length > 1 ? nodeToPersistedLayout(t.layout, paneIds) : undefined,
        };
      });
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

  /** Per-pane Code Mode: pane dir is the indexed project or inside it. */
  const isCodeModeForDir = useCallback(
    (dir: string): boolean => isCodeModeActiveForDir(dir, codeModeProject),
    [codeModeProject]
  );

  /** Resolve each pane's own project dir (pane -> tab -> global). */
  const paneDirsKey = tabs
    .map((t) => t.panes.map((p) => resolveEffectiveProjectDir(p.cwd, t.cwd, cwd)).join("|"))
    .join("||");

  // Poll git status per distinct pane directory (each split owns its repo
  // badge): debounced on change plus a controlled 30 s refresh. The status
  // bar reads the active pane's entry out of the same map.
  useEffect(() => {
    const dirs = Array.from(
      new Set(
        tabs.flatMap((t) =>
          t.panes.map((p) => resolveEffectiveProjectDir(p.cwd, t.cwd, cwdRef.current))
        )
      )
    ).filter(Boolean);
    if (dirs.length === 0) {
      setGitBranch(null);
      setGitDirty(false);
      setGitRepoRoot(null);
      return;
    }
    let cancelled = false;
    const fetchAll = () => {
      if (typeof document !== "undefined" && document.hidden) return;
      for (const dir of dirs) {
        void getGitInfoCached(dir).then(
          (info) => {
            if (cancelled) return;
            setGitInfoByDir((prev) =>
              prev[dir]?.branch === info.branch &&
              prev[dir]?.dirty === info.dirty &&
              prev[dir]?.repo_root === info.repo_root
                ? prev
                : { ...prev, [dir]: info }
            );
            // Keep the active-pane footer in sync.
            if (
              dir === resolveEffectiveProjectDir(activePane?.cwd, activeTab?.cwd, cwdRef.current)
            ) {
              setGitBranch(info.branch);
              setGitDirty(info.dirty);
              setGitRepoRoot(info.repo_root ?? null);
            }
          },
          () => {
            if (cancelled) return;
            setGitInfoByDir((prev) => ({ ...prev, [dir]: null }));
          }
        );
      }
    };
    const timer = setTimeout(fetchAll, 600);
    const interval = setInterval(fetchAll, 30000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paneDirsKey, activeTabId]);

  // Immediately synchronize active pane's git status and code mode when active
  // pane changes or user clicks a split.
  useEffect(() => {
    if (!effectiveProjectDir) {
      setGitBranch(null);
      setGitDirty(false);
      setGitRepoRoot(null);
      return;
    }
    const cached = gitInfoByDir[effectiveProjectDir];
    if (cached !== undefined) {
      setGitBranch(cached?.branch ?? null);
      setGitDirty(cached?.dirty ?? false);
      setGitRepoRoot(cached?.repo_root ?? null);
    }
    let cancelled = false;
    void getGitInfoCached(effectiveProjectDir).then(
      (info) => {
        if (cancelled) return;
        setGitInfoByDir((prev) => ({ ...prev, [effectiveProjectDir]: info }));
        setGitBranch(info.branch);
        setGitDirty(info.dirty);
        setGitRepoRoot(info.repo_root ?? null);
      },
      () => {
        if (cancelled) return;
        setGitInfoByDir((prev) => ({ ...prev, [effectiveProjectDir]: null }));
        setGitBranch(null);
        setGitDirty(false);
        setGitRepoRoot(null);
      }
    );
    return () => {
      cancelled = true;
    };
  }, [effectiveProjectDir, activePaneId, activeTabId]);

  const handleNewTab = useCallback(
    (opts?: { cwd?: string }) => {
      const dir = opts?.cwd ?? (cwd.trim() || undefined);
      if (dir) {
        setRecentProjects(recordRecentProject(dir));
      }
      // Effective shell: custom path override wins (same resolution as the
      // `selectedShell` below), so a configured custom binary is actually
      // used for new tabs instead of silently falling back to the stored
      // profile path (the "binary not runnable" mismatch).
      const base = shells.find((s) => s.id === selectedShellId);
      const custom = userSettings.customShellPath?.trim();
      const effName = custom ? `${base?.name ?? "Custom Shell"} (custom)` : base?.name;
      const effPath = custom || base?.path;
      // Number from live tabs (not a stale closure) so spam-clicking the
      // top "+" like PowerShell never yields duplicate "Terminal N" titles.
      const n = tabsRef.current.length + 1;
      const title = `${effName || "Terminal"} ${n}`;
      const newTab = createDefaultTab(title, effPath, dir);
      setTabs((prev) => [...prev, newTab]);
      setActiveTabId(newTab.id);
    },
    [shells, selectedShellId, userSettings.customShellPath, cwd]
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
      const base = shells.find((s) => s.id === selectedShellId);
      const custom = userSettings.customShellPath?.trim();
      const effPath = custom || base?.path;
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
            shellPath: effPath,
            cwd: inheritCwd,
            status: "connecting",
            parentId: fromPane?.id,
          }));
          return { ...tab, ...next };
        })
      );
    },
    [activeTabId, shells, selectedShellId, userSettings.customShellPath, cwd]
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

    // Release-freeze guard (Windows / Linux / macOS): a broken shell
    // binary (missing, not runnable, instantly crashing) fires `pty-exit`
    // immediately after every spawn. Without this, the app churns through
    // close/recycle/quit in a tight loop and the window looks frozen
    // ("trying to reopen"). 3+ deaths inside 10 s parks the tab in `error`
    // with an actionable banner instead — on every OS.
    const now = Date.now();
    const recent = exitTimesRef.current.filter((t) => now - t < 10_000);
    recent.push(now);
    exitTimesRef.current = recent;

    const parkAsFault = (message: string) => {
      exitTimesRef.current = [];
      setLastError(message);
      setLoopFault({ tabId, paneId, message });
      setTabs((prev) =>
        prev.map((t) =>
          t.id === tabId
            ? {
                ...t,
                status: "error" as const,
                errorMessage: message,
                panes: t.panes.map((p) =>
                  p.id === paneId ? { ...p, status: "error" as const, errorMessage: message } : p
                ),
              }
            : t
        )
      );
    };

    if (recent.length >= 3) {
      parkAsFault(
        "Shell keeps exiting immediately (3 times in 10 s). The configured shell binary is " +
          "likely missing or not runnable. Pick another shell in Settings, then press Retry."
      );
      return;
    }

    if (targetTab.panes.length > 1) {
      const at = targetTab.panes.findIndex((p) => p.id === paneId);
      const remainingPanes = targetTab.panes.filter((p) => p.id !== paneId);
      const nextIdx = Math.min(Math.max(0, at), remainingPanes.length - 1);
      setTabs((prev) =>
        prev.map((t) => {
          if (t.id !== tabId) return t;
          const nextRemaining = t.panes.filter((p) => p.id !== paneId);
          const baseLayout: PaneLayoutNode = t.layout ?? {
            kind: "pane",
            paneId: t.panes[0]?.id ?? paneId,
          };
          const collapsed =
            nextRemaining.length === 1
              ? createPaneLayout(nextRemaining[0].id)
              : (removePaneFromLayout(baseLayout, paneId) ?? createPaneLayout(nextRemaining[0].id));
          return {
            ...t,
            panes: nextRemaining,
            activePaneId: t.activePaneId === paneId ? nextRemaining[nextIdx].id : t.activePaneId,
            splitDirection:
              nextRemaining.length > 1 ? t.splitDirection : ("none" as SplitDirection),
            layout: collapsed,
          };
        })
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
    // Instant-death exception (all OSes): when the session died within 4 s
    // of the tab's creation the shell never actually ran (broken binary or
    // bad cwd) — quitting here would make a release launch vanish with no
    // explanation. Keep the window open with the fault banner instead.
    const bornAt = tabBornRef.current[tabId] ?? 0;
    if (bornAt > 0 && now - bornAt < 4000) {
      parkAsFault(
        "Shell exited right after opening — it likely failed to start (bad shell binary or " +
          "working directory). The window was kept open so you can fix it: pick another shell " +
          "in Settings, then press Retry."
      );
      return;
    }
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

  // Retry after a crash-loop / instant-death fault: re-spawn the same pane
  // in place (resetKey bump keeps the pane id, so split layouts survive).
  // Birth + exit clocks restart so a second instant death parks again
  // instead of quitting or churning.
  const handleRetryLoopPane = () => {
    if (!loopFault) return;
    const { tabId, paneId } = loopFault;
    tabBornRef.current[tabId] = Date.now();
    exitTimesRef.current = [];
    setLastError(null);
    setLoopFault(null);
    setTabs((prev) =>
      prev.map((t) =>
        t.id === tabId
          ? {
              ...t,
              status: "connecting" as const,
              errorMessage: undefined,
              activePaneId: paneId,
              panes: t.panes.map((p) =>
                p.id === paneId
                  ? {
                      ...p,
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
  };

  const handleOpenEditor = useCallback(
    async (editorBinary?: string, dirOverride?: string) => {
      try {
        const dir = dirOverride || effectiveProjectDir || cwd.trim() || ".";
        // Explicit picker choice wins; otherwise fall back to Settings default.
        const configured = userSettings.editorPath?.trim() || undefined;
        await openProjectInEditor(dir, editorBinary || configured);
        setLastError(null);
      } catch (err) {
        setLastError(err instanceof Error ? err.message : String(err));
      }
    },
    [effectiveProjectDir, cwd, userSettings.editorPath]
  );

  const handleOpenFileInEditor = useCallback(
    async (projectDir: string, fileRelPath?: string) => {
      try {
        const targetPath = fileRelPath ? `${projectDir}/${fileRelPath}` : projectDir;
        const configured = userSettings.editorPath?.trim() || undefined;
        await openProjectInEditor(targetPath, configured);
      } catch (err) {
        setLastError(err instanceof Error ? err.message : String(err));
      }
    },
    [userSettings.editorPath]
  );

  const handleGitActionRun = useCallback(
    async (action: "fetch" | "pull" | "status", dirOverride?: string) => {
      try {
        const dir = dirOverride || effectiveProjectDir;
        if (!dir) {
          setLastError("No project directory set. Enter a working directory first.");
          return;
        }
        invalidateGitCache(dir);
        if (action === "status") {
          // Centered in-app VS Code style changes review & diff modal
          setGitChangesModal({ dir });
        } else {
          await runGitAction(dir, action);
          // Trigger immediate git badge refresh (active + per-pane map)
          void getGitInfoCached(dir).then((info) => {
            setGitInfoByDir((prev) => ({ ...prev, [dir]: info }));
            if (dir === effectiveProjectDir) {
              setGitBranch(info.branch);
              setGitDirty(info.dirty);
              setGitRepoRoot(info.repo_root ?? null);
            }
          });
        }
      } catch (err) {
        setLastError(err instanceof Error ? err.message : String(err));
      }
    },
    [effectiveProjectDir]
  );

  const handleCheckUpdates = useCallback(
    async (manual = false) => {
      if (isCheckingUpdates) return;
      setIsCheckingUpdates(true);
      try {
        const current = await getAppVersion();
        setAppVersion(current);
        const result = await checkForUpdates(current);
        setUpdateInfo(result);
        recordCheckTime();
        if (result.updateAvailable && result.latestVersion) {
          // Respect a previous dismiss unless this is a manual re-check.
          if (manual || !isDismissed(result.latestVersion)) {
            setUpdateBannerVisible(true);
          }
        } else if (manual && !result.updateAvailable && !result.error) {
          setLastError(null);
        } else if (manual && result.error) {
          setLastError(`Update check: ${result.error}`);
        }
      } catch (err) {
        if (manual) {
          setLastError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        setIsCheckingUpdates(false);
      }
    },
    [isCheckingUpdates]
  );

  // App version for the status bar + automatic update check on startup and
  // every few hours while the window stays open. Failures are silent unless
  // the user triggered the check manually.
  useEffect(() => {
    void getAppVersion().then((v) => setAppVersion(v));
    // Defer network auto-check well past terminal startup so a slow DNS /
    // offline hang never contends with the first PTY spawn on Windows
    // (a classic "Not Responding on launch" trigger).
    const initialCheckTimer = setTimeout(() => {
      if (shouldAutoCheck()) {
        void handleCheckUpdates(false);
      }
    }, 8000);
    const interval = setInterval(() => {
      void handleCheckUpdates(false);
    }, UPDATE_PERIODIC_MS);
    return () => {
      clearTimeout(initialCheckTimer);
      clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleViewUpdate = useCallback(() => {
    const url = updateInfo?.releaseUrl ?? undefined;
    void openReleasePage(url ?? "https://github.com/surajthaqurie/kai-terminal/releases/latest");
  }, [updateInfo]);

  const handleDismissUpdate = useCallback(() => {
    if (updateInfo?.latestVersion) {
      dismissVersion(updateInfo.latestVersion);
    }
    setUpdateBannerVisible(false);
  }, [updateInfo]);

  const handleLaterUpdate = useCallback(() => {
    setUpdateBannerVisible(false);
  }, []);

  // Blank-on-reopen fix (all OSes): minimizing then restoring the OS window
  // (or hiding/showing the WebView) can leave the xterm viewport laid out
  // at 0x0 so the terminal paints blank until the next tab switch. Re-fit
  // the active pane on every visibility / focus / restore signal so the
  // window always repaints with real cols/rows.
  useEffect(() => {
    const onVisibility = () => {
      if (!document.hidden) refitActiveTerminal();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", refitActiveTerminal);
    let cancelled = false;
    const unlistens: Array<() => void> = [];
    void import("@tauri-apps/api/window")
      .then(({ getCurrentWindow }) => {
        if (cancelled) return;
        try {
          const win = getCurrentWindow();
          void win
            .onResized(() => {
              refitActiveTerminal();
            })
            .then((u) => unlistens.push(u))
            .catch(() => {});
          void win
            .onFocusChanged((e) => {
              if (e.payload) refitActiveTerminal();
            })
            .then((u) => unlistens.push(u))
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
      window.removeEventListener("focus", refitActiveTerminal);
      for (const u of unlistens) {
        try {
          u();
        } catch {
          // Already removed; safe to ignore.
        }
      }
    };
  }, [refitActiveTerminal]);

  const handleToggleSearch = useCallback(() => {
    getActiveTerminal()?.toggleSearch();
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
        layout: t.layout,
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
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.code === "KeyG") {
        e.preventDefault();
        const dir = effectiveProjectDir || cwd.trim();
        if (dir) setGitChangesModal({ dir });
        return;
      }
      // Universal New-Tab accelerator on every OS: Ctrl+T (Windows/Linux)
      // and Cmd+T (macOS), with or without Shift. A bare Ctrl/Cmd+T never
      // produces shell text, so it is safe to hijack — except while typing
      // in an input (rename box, shortcut recorder, search field), where
      // it must not fire and steal the keystroke.
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.code === "KeyT") {
        if (!isTypingTarget(e.target)) {
          e.preventDefault();
          handleNewTab();
          return;
        }
      }
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
        setRenameInputValue(activeTab.title);
        setRenameModalTab(activeTab);
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
      id: "check-updates",
      label: "Check for Application Updates",
      category: "Help",
      icon: <Activity size={16} />,
      perform: () => handleCheckUpdates(true),
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
      perform: () => {
        setAiCliDir(effectiveProjectDir);
        setIsAiCliOpen(true);
      },
    },
    {
      id: "diagnostics",
      label: "Open Diagnostics & Recovery",
      category: "Help",
      icon: <Activity size={16} />,
      perform: () => setIsDiagnosticsOpen(true),
    },
    {
      id: "review-changes",
      label: "Review Changes & Diff (Source Control)",
      category: "Git",
      shortcut: "Ctrl+Shift+G",
      icon: <GitCompare size={16} />,
      perform: () => {
        const dir = effectiveProjectDir || cwd.trim();
        if (dir) {
          setGitChangesModal({ dir });
        } else {
          setLastError("No project directory set. Enter or open a directory first.");
        }
      },
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

  // Drag-to-resize: per-split ratio (0.2–0.8) stored inside each tab's
  // nested layout tree, so every divider drags along its own axis.
  // Each pane keeps its own TerminalView + ResizeObserver, so dragging
  // resizes the correct backend PTY with real cols/rows (backend clamps).
  const dragRef = useRef<{ tabId: string; splitId: string; start: number; base: number } | null>(
    null
  );

  const handleSplitResize = useCallback((tabId: string, splitId: string, ratio: number) => {
    setTabs((prev) =>
      prev.map((t) =>
        t.id === tabId && t.layout
          ? { ...t, layout: setLayoutSplitRatio(t.layout, splitId, ratio) }
          : t
      )
    );
  }, []);

  const beginSplitDrag = (
    tabId: string,
    splitId: string,
    direction: PaneSplitDirection,
    clientPos: number,
    containerEl: HTMLElement | null,
    baseRatio: number
  ) => {
    dragRef.current = { tabId, splitId, start: clientPos, base: baseRatio };
    const move = (ev: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || drag.tabId !== tabId || drag.splitId !== splitId) return;
      const rect = containerEl?.getBoundingClientRect();
      if (!rect) return;
      // Vertical split = side-by-side (row axis -> width/clientX).
      // Horizontal split = stacked (column axis -> height/clientY).
      const vertical = direction === "vertical";
      const size = vertical ? rect.width : rect.height;
      if (size <= 0) return;
      const delta = ((vertical ? ev.clientX : ev.clientY) - drag.start) / size;
      handleSplitResize(tabId, splitId, clampPaneFraction(drag.base + delta));
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
          onNewTab={() => handleNewTab()}
          onSplitHorizontal={() => handleSplitPane("horizontal")}
          onSplitVertical={() => handleSplitPane("vertical")}
          canClosePane={(activeTab?.panes.length ?? 0) > 1}
          onClosePane={handleClosePane}
          onOpenEditor={handleOpenEditor}
          editorPath={userSettings.editorPath}
          installedEditors={installedEditors}
          isLoadingEditors={isLoadingEditors}
          onRefreshEditors={refreshInstalledEditors}
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
          onOpenAiCli={() => {
            setAiCliDir(effectiveProjectDir);
            setIsAiCliOpen(true);
          }}
          onOpenDiagnostics={() => setIsDiagnosticsOpen(true)}
        />
      </div>

      {updateBannerVisible && updateInfo?.updateAvailable && updateInfo.latestVersion && (
        <UpdateBanner
          currentVersion={updateInfo.currentVersion}
          latestVersion={updateInfo.latestVersion}
          releaseUrl={
            updateInfo.releaseUrl ?? "https://github.com/surajthaqurie/kai-terminal/releases/latest"
          }
          releaseName={updateInfo.releaseName}
          onViewRelease={handleViewUpdate}
          onDismiss={handleDismissUpdate}
          onLater={handleLaterUpdate}
        />
      )}

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
        {loopFault && (
          <div
            className="session-restore-banner"
            role="alert"
            aria-label="Shell keeps exiting"
            style={{ borderColor: "#f38ba8" }}
          >
            <span className="session-restore-text">{loopFault.message}</span>
            <div className="session-restore-actions">
              <button
                type="button"
                className="btn btn-primary btn-small"
                onClick={handleRetryLoopPane}
              >
                Retry
              </button>
              <button
                type="button"
                className="btn btn-secondary btn-small"
                onClick={() => setIsSettingsOpen(true)}
              >
                Open Settings
              </button>
              <button
                type="button"
                className="btn btn-secondary btn-small"
                onClick={() => setLoopFault(null)}
              >
                Dismiss
              </button>
            </div>
          </div>
        )}
        {tabs.map((tab) => {
          const paneById = new Map(tab.panes.map((p) => [p.id, p]));
          const layout: PaneLayoutNode = tab.layout ?? {
            kind: "pane",
            paneId: tab.panes[0]?.id ?? tab.activePaneId,
          };
          const renderNode = (node: PaneLayoutNode): React.ReactNode => {
            if (node.kind === "pane") {
              const pane = paneById.get(node.paneId);
              if (!pane) return null;
              const isPaneActive = pane.id === tab.activePaneId;
              const focusPane = () => {
                setTabs((prev) =>
                  prev.map((t) => (t.id === tab.id ? { ...t, activePaneId: pane.id } : t))
                );
              };
              return (
                <div
                  key={pane.id}
                  className={`pane-item ${isPaneActive ? "active-pane" : ""}`}
                  style={{ flex: "1 1 0%" }}
                  onClick={focusPane}
                  onPointerDown={focusPane}
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
                    resetKey={pane.resetKey ?? 0}
                    onFocus={focusPane}
                    onCwdResolved={(resolved) => {
                      if (resolved) {
                        setTabs((prev) =>
                          prev.map((t) =>
                            t.id === tab.id
                              ? {
                                  ...t,
                                  cwd:
                                    t.activePaneId === pane.id || t.panes.length === 1
                                      ? resolved
                                      : t.cwd,
                                  panes: t.panes.map((p) =>
                                    p.id === pane.id ? { ...p, cwd: resolved } : p
                                  ),
                                }
                              : t
                          )
                        );
                        if (
                          tab.id === activeTabId &&
                          (tab.activePaneId === pane.id || tab.panes.length === 1)
                        ) {
                          setCwd(resolved);
                          setRecentProjects(recordRecentProject(resolved));
                          invalidateGitCache(resolved);
                          void getGitInfoCached(resolved).then(
                            (info) => {
                              setGitInfoByDir((prev) => ({ ...prev, [resolved]: info }));
                              setGitBranch(info.branch);
                              setGitDirty(info.dirty);
                              setGitRepoRoot(info.repo_root ?? null);
                            },
                            () => {
                              setGitInfoByDir((prev) => ({ ...prev, [resolved]: null }));
                              setGitBranch(null);
                              setGitDirty(false);
                              setGitRepoRoot(null);
                            }
                          );
                        }
                      }
                    }}
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
              );
            }
            // Each split owns its axis: vertical = side-by-side (width),
            // horizontal = stacked (height). Mixed directions nest.
            // NOTE: flex-basis 0 with proportional grow (NOT percentage basis)
            // so gap (2px) + divider (6px) never push the row past 100% and
            // create an outer scrollbar next to the divider. Only the xterm
            // viewport scrolls.
            const ratio = clampPaneFraction(node.ratio);
            return (
              <div
                key={node.id}
                className={`pane-split pane-split-${node.direction}`}
                data-split-id={node.id}
              >
                <div
                  className="pane-leaf"
                  style={{ flexGrow: ratio, flexShrink: 1, flexBasis: "0%" }}
                >
                  {renderNode(node.first)}
                </div>
                <div
                  className={`pane-divider pane-divider-${node.direction}`}
                  role="separator"
                  aria-orientation={node.direction === "vertical" ? "vertical" : "horizontal"}
                  aria-label={`Resize ${node.direction} split`}
                  onPointerDown={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    const container = (e.currentTarget.parentElement as HTMLElement) ?? null;
                    beginSplitDrag(
                      tab.id,
                      node.id,
                      node.direction,
                      node.direction === "vertical" ? e.clientX : e.clientY,
                      container,
                      ratio
                    );
                  }}
                />
                <div
                  className="pane-leaf"
                  style={{ flexGrow: 1 - ratio, flexShrink: 1, flexBasis: "0%" }}
                >
                  {renderNode(node.second)}
                </div>
              </div>
            );
          };
          return (
            <div
              key={tab.id}
              className="tab-content"
              style={{ display: tab.id === activeTabId ? "block" : "none" }}
            >
              <div className="pane-container-none" data-pane-container={tab.id}>
                {renderNode(layout)}
              </div>
            </div>
          );
        })}
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
        appVersion={appVersion}
        updateInfo={updateInfo}
        isCheckingUpdates={isCheckingUpdates}
        onCheckUpdates={() => void handleCheckUpdates(true)}
        onViewUpdate={handleViewUpdate}
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
        projectDir={aiCliDir || effectiveProjectDir}
        onLaunchInTerminal={(dir) => {
          handleNewTab({ cwd: dir || undefined });
          setIsAiCliOpen(false);
        }}
      />

      {gitChangesModal && (
        <GitChangesModal
          dir={gitChangesModal.dir}
          onClose={() => setGitChangesModal(null)}
          onOpenEditor={(d, file) => void handleOpenFileInEditor(d, file)}
        />
      )}

      {gitStatusModal && (
        <GitStatusModal
          dir={gitStatusModal.dir}
          output={gitStatusModal.output}
          onClose={() => setGitStatusModal(null)}
        />
      )}

      <DiagnosticsModal
        isOpen={isDiagnosticsOpen}
        onClose={() => setIsDiagnosticsOpen(false)}
        lastError={lastError}
      />

      {renameModalTab && (
        <div className="modal-backdrop" onClick={() => setRenameModalTab(null)}>
          <div
            className="command-palette-modal"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-label="Rename session"
            style={{ padding: 16 }}
          >
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (renameInputValue.trim()) {
                  handleRenameTab(renameModalTab.id, renameInputValue.trim());
                }
                setRenameModalTab(null);
              }}
            >
              <label htmlFor="rename-session-input" className="shortcut-label">
                Rename session
              </label>
              <input
                id="rename-session-input"
                type="text"
                className="text-input modal-input"
                autoFocus
                value={renameInputValue}
                onChange={(e) => setRenameInputValue(e.target.value)}
                placeholder="Session name"
                style={{ marginTop: 8 }}
              />
              <div className="footer-actions" style={{ marginTop: 12, justifyContent: "flex-end" }}>
                <button
                  type="button"
                  className="btn btn-secondary btn-small"
                  onClick={() => setRenameModalTab(null)}
                >
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary btn-small">
                  Save
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      <StatusBar
        gitBranch={
          effectiveProjectDir && gitInfoByDir[effectiveProjectDir] !== undefined
            ? (gitInfoByDir[effectiveProjectDir]?.branch ?? null)
            : gitBranch
        }
        gitDirty={
          effectiveProjectDir && gitInfoByDir[effectiveProjectDir] !== undefined
            ? (gitInfoByDir[effectiveProjectDir]?.dirty ?? false)
            : gitDirty
        }
        gitRepoRoot={
          effectiveProjectDir && gitInfoByDir[effectiveProjectDir] !== undefined
            ? (gitInfoByDir[effectiveProjectDir]?.repo_root ?? null)
            : gitRepoRoot
        }
        projectDir={effectiveProjectDir}
        appVersion={appVersion}
        updateAvailable={updateInfo?.updateAvailable ?? false}
        latestVersion={updateInfo?.latestVersion ?? null}
        isCheckingUpdates={isCheckingUpdates}
        onCheckUpdates={() => handleCheckUpdates(true)}
        onViewUpdate={handleViewUpdate}
        onGitAction={(action) => void handleGitActionRun(action)}
        onNewTab={() => handleNewTab()}
        mode={isCodeModeForDir(effectiveProjectDir) ? "code" : "terminal"}
      />
    </div>
  );
}

export default App;
