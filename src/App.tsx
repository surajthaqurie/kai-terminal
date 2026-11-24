import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { HeaderActions } from "./components/HeaderActions";
import { TabBar } from "./components/TabBar";
import { StatusBar } from "./components/StatusBar";
import { UpdateBanner } from "./components/UpdateBanner";
import { UpdateResultNotice } from "./components/UpdateResultNotice";
import type { TerminalViewRef } from "./components/TerminalView";
import { TabPanes } from "./components/TabPanes";
import { SessionBanners } from "./components/SessionBanners";
import { CloseConfirmDialog } from "./components/CloseConfirmDialog";
import { RenameTabDialog } from "./components/RenameTabDialog";
import { MusicHost } from "./components/MusicHost";
import { ToastHost } from "./components/ToastHost";
import { buildCommandActions } from "./components/commandActions";
import {
  AiCliPanel,
  CommandPalette,
  DiagnosticsModal,
  GitChangesModal,
  GitStatusModal,
  SettingsModal,
  WorkspaceModal,
} from "./components/lazyPanels";
import { useAppShortcuts } from "./hooks/useAppShortcuts";
import { ShortcutHintsProvider, buildShortcutHints } from "./hooks/useShortcutHints";
import type { SettingsTab } from "./components/SettingsModal";
import type { AiCliTab } from "./components/AiCliPanel";
import { useAppUpdates } from "./hooks/useAppUpdates";
import { useCodeMode } from "./hooks/useCodeMode";
import { useGitStatus } from "./hooks/useGitStatus";
import { useLatest } from "./hooks/useLatest";
import { watchWindowCloseRequests } from "./services/appWindow";
import { readPasteContent } from "./services/clipboardService";
import { useMusicPlayer } from "./hooks/useMusicPlayer";
import { useNotices } from "./hooks/useNotices";
import { usePaneCwd } from "./hooks/usePaneCwd";
import { usePrefetchPanels } from "./hooks/usePrefetchPanels";
import { useProjectActions } from "./hooks/useProjectActions";
import { useSessionExit } from "./hooks/useSessionExit";
import { useCloseGuard } from "./hooks/useCloseGuard";
import { useSessionPersistence } from "./hooks/useSessionPersistence";
import { useTabDetach } from "./hooks/useTabDetach";
import { useTabs } from "./hooks/useTabs";
import { useTerminalConfig } from "./hooks/useTerminalConfig";
import { shouldRestoreTerminalFocus, useWindowRefit } from "./hooks/useWindowRefit";
import { resolvePaneShell } from "./services/paneShell";
import { SettingsService } from "./services/settingsService";
import { resolveEffectiveProjectDir } from "./services/projectService";
import { isMacPlatform, musicShortcutHints, platformLabel } from "./services/shortcuts";
import { RELEASES_PAGE_URL } from "./services/updateService";
import {
  isSecondaryTerminalWindow,
  openTerminalWindow,
  type TabSeed,
} from "./services/terminalWindows";
import type { ShellProfile, SplitDirection, TerminalTab } from "./types/terminal";

/**
 * Application shell: wires the feature hooks (tabs, session lifecycle, git /
 * Code Mode footer, updates, music, shortcuts) to the toolbar, tab strip,
 * pane grid, lazy modals and status bar. State lives in `src/hooks`; this
 * component only composes it.
 */
function App({ initialSeed = null }: { initialSeed?: TabSeed | null }) {
  // An extra window (opened with Ctrl+Shift+N, or by dragging a tab out) shares
  // this process with the first one. What must stay single belongs to the first
  // window only: the saved layout, the music player and the update checks.
  const secondary = useMemo(() => isSecondaryTerminalWindow(), []);
  const [lastError, setLastError] = useState<string | null>(null);
  const { notices, notify, dismiss: dismissNotice } = useNotices();
  /**
   * Records an error for Diagnostics AND shows it as a toast. Use it for actions
   * that give no visible feedback of their own (editor launch, git, updates,
   * autostart). Failures that already have in-pane UI (shell spawn, crash-loop
   * banner) keep using `setLastError` so they are not announced twice.
   */
  const reportError = useCallback(
    (message: string | null) => {
      setLastError(message);
      if (message) notify("error", message);
    },
    [notify]
  );
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  // Tab Settings opens on when something asks for a specific one (the palette's
  // Keyboard Shortcuts); undefined keeps the usual behaviour.
  const [settingsTab, setSettingsTab] = useState<SettingsTab | undefined>(undefined);
  const [isCommandPaletteOpen, setIsCommandPaletteOpen] = useState(false);
  const [isAiCliOpen, setIsAiCliOpen] = useState(false);
  const [aiCliTab, setAiCliTab] = useState<AiCliTab>("providers");
  const [isDiagnosticsOpen, setIsDiagnosticsOpen] = useState(false);
  const [isWorkspaceOpen, setIsWorkspaceOpen] = useState(false);
  // AI providers panel is scoped to a specific pane's directory, so each
  // split gets its own agent setup context instead of sharing one global.
  const [aiCliDir, setAiCliDir] = useState<string>("");
  const [renameTarget, setRenameTarget] = useState<TerminalTab | null>(null);

  const config = useTerminalConfig({
    setLastError: reportError,
    isSettingsOpen,
  });
  const { userSettings } = config;
  const music = useMusicPlayer({ showMusicPlayer: !secondary && userSettings.showMusicPlayer });

  const tabsState = useTabs({
    effectiveShellPath: config.effectiveShellPath,
    setLastError,
    initialSeed,
  });
  const {
    tabs,
    setTabs,
    activeTabId,
    setActiveTabId,
    tabsRef,
    activeTabIdRef,
    activeTab,
    activePaneId,
    activePane,
  } = tabsState;

  // Terminal handles keyed by pane id (toolbar actions, window refit).
  const terminalRefs = useRef<Record<string, TerminalViewRef | null>>({});
  const activePaneIdRef = useLatest(activePaneId);
  const getActiveTerminal = useCallback(
    () => terminalRefs.current[activePaneIdRef.current ?? ""],
    [activePaneIdRef]
  );

  /**
   * Focus the active terminal as soon as it exists (bounded retry: a newly
   * created pane mounts on the next commit, so its ref is not registered
   * yet). Nothing in the app moves keyboard focus into a terminal by
   * itself — without this, the TabBar's + button kept focus after opening
   * a tab and every Space/Enter the user typed while "typing a command"
   * re-activated it, opening yet another tab. Same for session exits
   * (Ctrl+C / `exit`): focus used to be dropped to the document, so typed
   * keys went nowhere (or re-triggered whatever toolbar control had focus).
   */
  const focusRafRef = useRef<number | null>(null);
  const focusTimerRef = useRef<number | null>(null);
  const cancelPendingFocus = useCallback(() => {
    if (focusRafRef.current !== null) cancelAnimationFrame(focusRafRef.current);
    if (focusTimerRef.current !== null) window.clearTimeout(focusTimerRef.current);
    focusRafRef.current = null;
    focusTimerRef.current = null;
  }, []);
  // Drop any pending retry on unmount so it can't fire after teardown
  // (e.g. a test environment that has already removed `window`).
  useEffect(() => cancelPendingFocus, [cancelPendingFocus]);

  const focusActiveTerminalSoon = useCallback(() => {
    cancelPendingFocus();
    const attempt = (tries: number) => {
      focusRafRef.current = null;
      focusTimerRef.current = null;
      const term = getActiveTerminal();
      if (term) {
        term.focus();
      } else if (tries > 0) {
        focusTimerRef.current = window.setTimeout(() => attempt(tries - 1), 50);
      }
    };
    focusRafRef.current = requestAnimationFrame(() => attempt(3));
  }, [getActiveTerminal, cancelPendingFocus]);

  // Whatever switched the tab (Ctrl+Tab, Ctrl+1-9, palette, closing a tab,
  // a restored session) the terminal that comes to the front takes the
  // keyboard, so the user can type straight away. Skipped when focus sits on
  // a real control (tab-bar arrow keys, an open dialog's field): only an
  // empty focus or the previous terminal's own input is handed over.
  const lastActiveTabIdRef = useRef(activeTabId);
  useEffect(() => {
    if (lastActiveTabIdRef.current === activeTabId) return;
    lastActiveTabIdRef.current = activeTabId;
    if (shouldRestoreTerminalFocus(document.activeElement)) focusActiveTerminalSoon();
  }, [activeTabId, focusActiveTerminalSoon]);

  const newTabAndFocus = useCallback(
    (opts?: { cwd?: string }) => {
      tabsState.newTab(opts);
      focusActiveTerminalSoon();
    },
    [tabsState.newTab, focusActiveTerminalSoon]
  );

  /** A split makes the new pane active, so type-ahead must land in it, not the pane it came from. */
  const splitPaneAndFocus = useCallback(
    (direction: SplitDirection) => {
      tabsState.splitPane(direction);
      focusActiveTerminalSoon();
    },
    [tabsState.splitPane, focusActiveTerminalSoon]
  );

  /** "+ ▾" menu: the chosen shell becomes the default for new tabs and opens one now. */
  const newTabWithShell = useCallback(
    (shell: ShellProfile) => {
      config.setSelectedShellId(shell.id);
      tabsState.newTab({ shellPath: shell.path });
      focusActiveTerminalSoon();
    },
    [config.setSelectedShellId, tabsState.newTab, focusActiveTerminalSoon]
  );

  /** Active project dir: the focused pane's folder, else its tab's. Empty until a new shell reports one. */
  const effectiveProjectDir = resolveEffectiveProjectDir(activePane?.cwd, activeTab?.cwd);

  const { setPaneCodeMode, modeDisplay } = useCodeMode({
    activePaneId,
    onOpenProject: tabsState.openOrFocusDir,
  });
  const git = useGitStatus({
    tabs,
    tabsRef,
    activeTabId,
    activeTabIdRef,
    activeTab,
    activePane,
    activePaneId,
    effectiveProjectDir,
  });
  const project = useProjectActions({
    effectiveProjectDir,
    editorPath: userSettings.editorPath,
    setLastError: reportError,
    applyGitInfo: git.applyGitInfo,
  });
  const handleCwdResolved = usePaneCwd({
    tabsRef,
    activeTabIdRef,
    setTabs,
    applyGitInfo: git.applyGitInfo,
  });
  const sessionExit = useSessionExit({
    tabs,
    setTabs,
    setActiveTabId,
    tabsRef,
    activeTabIdRef,
    shellsRef: config.shellsRef,
    selectedShellIdRef: config.selectedShellIdRef,
    setLastError,
  });
  const persistence = useSessionPersistence({
    tabs,
    setTabs,
    setActiveTabId,
    activeTabId,
    autoRestoreSession: userSettings.autoRestoreSession,
    enabled: !secondary,
  });
  const updates = useAppUpdates({
    autoCheckUpdates: secondary ? false : userSettings.autoCheckUpdates,
    setLastError: reportError,
    notify,
  });
  useWindowRefit({ tabsRef, activeTabIdRef, terminalRefs, getActiveTerminal });

  // User-initiated closes (tab button, shortcut, palette, close pane, load workspace)
  // ask first when they would end a running command. A shell exiting by itself
  // still closes its pane directly (`removeTab` below), never through this guard.
  // Closing a pane keeps the same tab, so the tab-change focus hand-off never runs: the closed
  // pane's input is gone and typing went nowhere until a click (FUNC-10). Hand focus over here.
  const closeActivePaneAndFocus = useCallback(() => {
    tabsState.closeActivePane();
    focusActiveTerminalSoon();
  }, [tabsState.closeActivePane, focusActiveTerminalSoon]);
  const closeGuard = useCloseGuard({
    tabsRef,
    activeTabIdRef,
    terminalRefs,
    closeTab: tabsState.closeTab,
    closeActivePane: closeActivePaneAndFocus,
    restoreWorkspace: persistence.restoreWorkspace,
  });
  usePrefetchPanels();

  // The system asking this window to close (Alt+F4, taskbar): ask first, like the close button.
  const requestCloseWindowRef = useLatest(closeGuard.requestCloseWindow);
  useEffect(() => {
    let unwatch: (() => void) | undefined;
    let cancelled = false;
    void watchWindowCloseRequests(() => requestCloseWindowRef.current()).then((off) => {
      if (cancelled) off();
      else unwatch = off;
    });
    return () => {
      cancelled = true;
      unwatch?.();
    };
  }, [requestCloseWindowRef]);

  /** Another terminal window, like opening a second editor window. */
  const openNewWindow = useCallback(() => {
    openTerminalWindow().catch((err: unknown) =>
      reportError(err instanceof Error ? err.message : "Could not open a new window.")
    );
  }, [reportError]);
  /** Moves a tab, running shells included, into a new window. */
  const detachTab = useTabDetach({
    tabsRef,
    terminalRefs,
    removeTab: tabsState.closeTab,
    notify,
  });

  /** Session exited (Ctrl+C / `exit` / kill): close the pane, then hand
   * keyboard focus to whatever terminal is active now so typing continues
   * without a click. */
  /** Shell of the focused terminal (footer picker); each pane keeps its own. */
  const activePaneShell = useMemo(
    () =>
      resolvePaneShell(
        activePane?.shellPath,
        config.shells,
        config.selectedShell,
        userSettings.skipShellProfile === true
      ),
    [activePane?.shellPath, config.shells, config.selectedShell, userSettings.skipShellProfile]
  );

  /** Footer picker: restart the focused terminal in the chosen shell. */
  const changeActiveShell = useCallback(
    (shell: ShellProfile) => {
      if (!activeTabId || !activePaneId) return;
      sessionExit.markRestarted(activeTabId);
      tabsState.setPaneShell(activeTabId, activePaneId, shell.path);
      focusActiveTerminalSoon();
    },
    [
      activeTabId,
      activePaneId,
      sessionExit.markRestarted,
      tabsState.setPaneShell,
      focusActiveTerminalSoon,
    ]
  );

  const handleSessionExit = useCallback(
    (tabId: string, paneId: string, exitCode?: number) => {
      sessionExit.handleSessionExit(tabId, paneId, exitCode);
      focusActiveTerminalSoon();
    },
    [sessionExit.handleSessionExit, focusActiveTerminalSoon]
  );
  // Restart / Close on a pane whose shell failed (FUNC-09); the keyboard follows either way.
  const restartExitedPane = useCallback(
    (tabId: string, paneId: string) => {
      sessionExit.restartExitedPane(tabId, paneId);
      focusActiveTerminalSoon();
    },
    [sessionExit.restartExitedPane, focusActiveTerminalSoon]
  );
  const closeExitedPane = useCallback(
    (tabId: string, paneId: string) => {
      sessionExit.closeExitedPane(tabId, paneId);
      focusActiveTerminalSoon();
    },
    [sessionExit.closeExitedPane, focusActiveTerminalSoon]
  );

  const toggleSearch = useCallback(() => getActiveTerminal()?.toggleSearch(), [getActiveTerminal]);
  const openAiCli = useCallback(() => {
    setAiCliDir(effectiveProjectDir);
    setAiCliTab("providers");
    setIsAiCliOpen(true);
  }, [effectiveProjectDir]);
  const openSettings = useCallback(() => setIsSettingsOpen(true), []);
  const openShortcutSettings = useCallback(() => {
    setSettingsTab("shortcuts");
    setIsSettingsOpen(true);
  }, []);
  // Opening the player for the first time also enables it in Settings so the
  // footer mini-player and shortcuts stay available after the panel closes.
  const enableMusicPlayer = () => {
    if (userSettings.showMusicPlayer) return;
    // Persist too: `config.saveSettings` only applies settings to this session,
    // so without this the footer player vanishes again after a restart.
    const next = { ...userSettings, showMusicPlayer: true };
    SettingsService.saveSettings(next);
    config.saveSettings(next);
  };
  const toggleMusicPanel = () => {
    if (secondary) return; // the player lives in the first window
    const opening = !music.isOpen;
    music.togglePanel();
    if (opening) enableMusicPlayer();
  };
  // What the music buttons' tooltips show: the CURRENT keys, so a remap in Settings
  // is reflected right away.
  const musicHints = musicShortcutHints(userSettings.keybindings, isMacPlatform());
  // The current key of every action, for the tooltips of the buttons that have one.
  const shortcutHints = buildShortcutHints(userSettings.keybindings, isMacPlatform());
  // Play / pause / next / previous / mute chosen in the command palette. That is
  // a deliberate pick, so with the player switched off it does what the user is
  // after: turn the player on and open it to choose a song, rather than doing
  // nothing.
  const musicCommand = (name: string) => {
    if (secondary) return;
    if (!userSettings.showMusicPlayer) {
      enableMusicPlayer();
      music.openPanel();
      return;
    }
    music.transport(name);
  };

  useAppShortcuts({
    keybindings: userSettings.keybindings,
    fixedKeybindings: userSettings.fixedKeybindings,
    newTab: newTabAndFocus,
    closeActiveTab: () => closeGuard.requestCloseTab(activeTabId),
    toggleCommandPalette: () => setIsCommandPaletteOpen((prev) => !prev),
    toggleSearch,
    toggleSettings: () => setIsSettingsOpen((prev) => !prev),
    splitPane: splitPaneAndFocus,
    closeActivePane: closeGuard.requestCloseActivePane,
    cycleTab: tabsState.cycleTab,
    focusNextPane: tabsState.focusNextPane,
    focusPrevPane: tabsState.focusPrevPane,
    gotoTab: tabsState.gotoTab,
    zoomFont: config.zoomFont,
    toggleMusic: toggleMusicPanel,
    // Keys stay a no-op while the player is switched off in Settings, so a stray
    // press never pops it up; Show / hide (above) is the key that turns it on.
    musicEvent: music.transport,
    reviewChanges: () => project.reviewChanges(),
    newWindow: openNewWindow,
  });

  const pasteFromClipboard = useCallback(async () => {
    try {
      const text = await readPasteContent();
      if (text) getActiveTerminal()?.pasteText(text);
    } catch (err) {
      console.error("Failed to read clipboard:", err);
    }
  }, [getActiveTerminal]);

  const commandActions = buildCommandActions({
    keybindings: userSettings.keybindings,
    fixedKeybindings: userSettings.fixedKeybindings,
    isMac: isMacPlatform(),
    newTab: newTabAndFocus,
    cycleTab: tabsState.cycleTab,
    focusNextPane: tabsState.focusNextPane,
    focusPrevPane: tabsState.focusPrevPane,
    openWorkspaces: () => setIsWorkspaceOpen(true),
    splitPane: splitPaneAndFocus,
    closeActivePane: closeGuard.requestCloseActivePane,
    toggleMusic: toggleMusicPanel,
    musicCommand,
    renameActiveTab: () => setRenameTarget(activeTab),
    newWindow: openNewWindow,
    moveTabToNewWindow: () => void detachTab(activeTabId),
    openEditor: () => void project.openEditor(),
    showGitStatus: () => void project.showGit("status"),
    reviewChanges: () => project.reviewChanges(true),
    checkUpdates: () => void updates.checkUpdates(true),
    closeActiveTab: () => closeGuard.requestCloseTab(activeTabId),
    toggleSearch,
    copySelection: () => getActiveTerminal()?.copySelection(),
    pasteClipboard: () => void pasteFromClipboard(),
    clearTerminal: () => getActiveTerminal()?.clear(),
    openAiCli,
    openDiagnostics: () => setIsDiagnosticsOpen(true),
    openSettings,
    openShortcutSettings,
  });

  return (
    <ShortcutHintsProvider hints={shortcutHints}>
      <div className="app-layout" data-theme={userSettings.theme}>
        <div className="app-header">
          <TabBar
            tabs={tabs}
            activeTabId={activeTabId}
            onSelectTab={setActiveTabId}
            onTabClicked={focusActiveTerminalSoon}
            onCloseTab={closeGuard.requestCloseTab}
            onCloseWindow={closeGuard.requestCloseWindow}
            onNewTab={() => newTabAndFocus()}
            onRenameTab={tabsState.renameTab}
            onMoveTab={tabsState.moveTab}
            onReorderTabs={tabsState.reorderTabs}
            onMoveTabToIndex={tabsState.moveTabToIndex}
            onSetTabColor={tabsState.setTabColor}
            onDetachTab={(id, x, y) => void detachTab(id, x, y)}
            shells={config.shells}
            selectedShellId={config.selectedShellId}
            onNewTabWithShell={newTabWithShell}
          >
            <HeaderActions
              actions={commandActions}
              paletteShortcut={platformLabel(
                userSettings.keybindings.commandPalette,
                isMacPlatform()
              )}
              onOpenCommandPalette={() => setIsCommandPaletteOpen(true)}
              onOpenAiCli={openAiCli}
              onOpenSettings={openSettings}
              updateAvailable={updates.updateInfo?.updateAvailable ?? false}
              latestVersion={updates.updateInfo?.latestVersion ?? null}
              onViewUpdate={updates.viewUpdate}
            />
          </TabBar>
        </div>

        {updates.updateOutcome && (
          <UpdateResultNotice
            outcome={updates.updateOutcome}
            onDismiss={updates.dismissUpdateOutcome}
            onRetry={() => {
              updates.dismissUpdateOutcome();
              void updates.checkUpdates(true);
            }}
          />
        )}

        {updates.updateBannerVisible &&
          updates.updateInfo?.updateAvailable &&
          updates.updateInfo.latestVersion && (
            <UpdateBanner
              currentVersion={updates.updateInfo.currentVersion}
              latestVersion={updates.updateInfo.latestVersion}
              releaseUrl={updates.updateInfo.releaseUrl ?? RELEASES_PAGE_URL}
              releaseName={updates.updateInfo.releaseName}
              releaseAuthor={updates.updateInfo.releaseAuthor}
              assetLabel={updates.updateInfo.selectedAssetLabel}
              downloadState={updates.updateDownload}
              onDownloadAndInstall={() => void updates.downloadAndInstall()}
              onViewRelease={updates.viewUpdate}
              onDismiss={updates.dismissUpdate}
              onLater={updates.remindLater}
            />
          )}

        <div className="app-body">
          <SessionBanners
            pendingRestoreCount={persistence.pendingRestore?.length ?? 0}
            onRestoreSession={persistence.restoreSession}
            onDismissRestore={persistence.dismissRestore}
            paneNotice={tabsState.paneNotice}
            onDismissNotice={tabsState.dismissPaneNotice}
            faultMessage={sessionExit.loopFault?.message ?? null}
            onRetryFault={sessionExit.retryFaultedPane}
            onOpenSettings={openSettings}
            onDismissFault={sessionExit.dismissFault}
          />
          {tabs.map((tab) => (
            <TabPanes
              key={tab.id}
              tab={tab}
              isActive={tab.id === activeTabId}
              selectedShell={config.selectedShell}
              shells={config.shells}
              shellsReady={config.shellsReady}
              skipShellProfile={userSettings.skipShellProfile === true}
              settings={userSettings}
              terminalRefs={terminalRefs}
              onFocusPane={tabsState.focusPane}
              onCodeModeChange={setPaneCodeMode}
              onCwdResolved={handleCwdResolved}
              onExit={handleSessionExit}
              onRestartPane={restartExitedPane}
              onClosePane={closeExitedPane}
              onStatusChange={tabsState.setPaneStatus}
              onResizeSplit={tabsState.resizeSplit}
            />
          ))}
        </div>

        <Suspense
          fallback={
            isSettingsOpen ||
            isCommandPaletteOpen ||
            isAiCliOpen ||
            isDiagnosticsOpen ||
            isWorkspaceOpen ? (
              <div className="modal-backdrop" aria-label="Loading panel" role="status">
                <div className="command-palette-modal" style={{ padding: 16 }}>
                  <span className="muted-text">Loading…</span>
                </div>
              </div>
            ) : null
          }
        >
          <CommandPalette
            isOpen={isCommandPaletteOpen}
            onClose={() => setIsCommandPaletteOpen(false)}
            actions={commandActions}
          />

          <SettingsModal
            isOpen={isSettingsOpen}
            onClose={() => {
              setIsSettingsOpen(false);
              setSettingsTab(undefined);
            }}
            initialTab={settingsTab}
            settings={userSettings}
            onSaveSettings={config.saveSettings}
            shells={config.shells}
            appVersion={updates.appVersion}
            updateInfo={updates.updateInfo}
            isCheckingUpdates={updates.isCheckingUpdates}
            updateDownload={updates.updateDownload}
            onCheckUpdates={() => void updates.checkUpdates(true)}
            onViewUpdate={updates.viewUpdate}
            onDownloadAndInstall={() => void updates.downloadAndInstall()}
          />

          <WorkspaceModal
            isOpen={isWorkspaceOpen}
            onClose={() => setIsWorkspaceOpen(false)}
            currentTabs={tabs}
            onLoadWorkspace={closeGuard.requestRestoreWorkspace}
          />

          <AiCliPanel
            key={aiCliTab}
            initialTab={aiCliTab}
            isOpen={isAiCliOpen}
            onClose={() => setIsAiCliOpen(false)}
            projectDir={aiCliDir || effectiveProjectDir}
            onLaunchInTerminal={(dir) => {
              newTabAndFocus({ cwd: dir || undefined });
              setIsAiCliOpen(false);
            }}
          />

          {project.gitChangesModal && (
            <GitChangesModal
              dir={project.gitChangesModal.dir}
              onClose={project.closeGitChanges}
              onOpenEditor={(dir, file) => void project.openFileInEditor(dir, file)}
            />
          )}

          {project.gitStatusModal && (
            <GitStatusModal
              dir={project.gitStatusModal.dir}
              output={project.gitStatusModal.output}
              onClose={project.closeGitStatus}
            />
          )}

          <DiagnosticsModal
            isOpen={isDiagnosticsOpen}
            onClose={() => setIsDiagnosticsOpen(false)}
            lastError={lastError}
          />

          {!secondary && (
            <MusicHost
              mounted={Boolean(userSettings.showMusicPlayer) || music.isOpen}
              startMuted={music.muted}
              open={music.isOpen}
              onClose={music.closePanel}
              onRequestOpen={music.openPanel}
              onTrackChange={music.handleTrackChange}
              onMutedChange={music.setMuted}
              onProgressChange={music.setProgress}
              shortcutHints={musicHints}
            />
          )}
        </Suspense>

        {closeGuard.pending && <CloseConfirmDialog pending={closeGuard.pending} />}

        {renameTarget && (
          <RenameTabDialog
            key={renameTarget.id}
            tab={renameTarget}
            onRename={tabsState.renameTab}
            onClose={() => setRenameTarget(null)}
          />
        )}

        <ToastHost
          notices={notices}
          onDismiss={dismissNotice}
          onDetails={() => setIsDiagnosticsOpen(true)}
        />

        <StatusBar
          gitBranch={git.statusGit.branch}
          gitDirty={git.statusGit.dirty}
          gitRepoRoot={git.statusGit.repoRoot}
          projectDir={effectiveProjectDir}
          appVersion={updates.appVersion}
          updateAvailable={updates.updateInfo?.updateAvailable ?? false}
          latestVersion={updates.updateInfo?.latestVersion ?? null}
          isCheckingUpdates={updates.isCheckingUpdates}
          onCheckUpdates={() => void updates.checkUpdates(true)}
          onViewUpdate={updates.viewUpdate}
          onRefreshGit={git.refreshGit}
          isRefreshingGit={git.isRefreshingGit}
          onOpenGitChanges={() => void project.showGit("changes")}
          shells={config.shells}
          currentShell={activePaneShell}
          onChangeShell={changeActiveShell}
          mode={modeDisplay}
          onOpenEditor={project.openEditor}
          editorPath={userSettings.editorPath}
          installedEditors={project.installedEditors}
          isLoadingEditors={project.isLoadingEditors}
          onRefreshEditors={project.refreshInstalledEditors}
          music={music.footerState}
          onToggleMusicPanel={toggleMusicPanel}
          musicOpen={music.isOpen}
          onMusicPlayPause={music.playPause}
          onMusicPrevious={() => music.transport("kai-music-previous")}
          onMusicNext={() => music.transport("kai-music-next")}
          onMusicMute={() => music.dispatchEvent("kai-music-mute")}
          musicShortcuts={musicHints}
        />
      </div>
    </ShortcutHintsProvider>
  );
}

export default App;
