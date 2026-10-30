import { Suspense, useCallback, useMemo, useRef, useState } from "react";
import { HeaderActions } from "./components/HeaderActions";
import { TabBar } from "./components/TabBar";
import { StatusBar } from "./components/StatusBar";
import { UpdateBanner } from "./components/UpdateBanner";
import { UpdateResultNotice } from "./components/UpdateResultNotice";
import type { TerminalViewRef } from "./components/TerminalView";
import { TabPanes } from "./components/TabPanes";
import { SessionBanners } from "./components/SessionBanners";
import { RenameTabDialog } from "./components/RenameTabDialog";
import { MusicHost } from "./components/MusicHost";
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
import { useAppUpdates } from "./hooks/useAppUpdates";
import { useCodeMode } from "./hooks/useCodeMode";
import { useGitStatus } from "./hooks/useGitStatus";
import { useLatest } from "./hooks/useLatest";
import { readClipboardText } from "./services/clipboardService";
import { useMusicPlayer } from "./hooks/useMusicPlayer";
import { usePaneCwd } from "./hooks/usePaneCwd";
import { usePrefetchPanels } from "./hooks/usePrefetchPanels";
import { useProjectActions } from "./hooks/useProjectActions";
import { useSessionExit } from "./hooks/useSessionExit";
import { useSessionPersistence } from "./hooks/useSessionPersistence";
import { useTabs } from "./hooks/useTabs";
import { useTerminalConfig } from "./hooks/useTerminalConfig";
import { useWindowRefit } from "./hooks/useWindowRefit";
import { resolvePaneShell } from "./services/paneShell";
import { resolveEffectiveProjectDir } from "./services/projectService";
import { isMacPlatform, platformLabel } from "./services/shortcuts";
import { RELEASES_PAGE_URL } from "./services/updateService";
import type { ShellProfile, TerminalTab } from "./types/terminal";
import "./App.css";

/**
 * Application shell: wires the feature hooks (tabs, session lifecycle, git /
 * Code Mode footer, updates, music, shortcuts) to the toolbar, tab strip,
 * pane grid, lazy modals and status bar. State lives in `src/hooks`; this
 * component only composes it.
 */
function App() {
  const [lastError, setLastError] = useState<string | null>(null);
  // Global toolbar working directory (follows the active pane).
  const [cwd, setCwd] = useState<string>("");
  const cwdRef = useLatest(cwd);

  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isCommandPaletteOpen, setIsCommandPaletteOpen] = useState(false);
  const [isAiCliOpen, setIsAiCliOpen] = useState(false);
  const [isDiagnosticsOpen, setIsDiagnosticsOpen] = useState(false);
  const [isWorkspaceOpen, setIsWorkspaceOpen] = useState(false);
  // AI providers panel is scoped to a specific pane's directory, so each
  // split gets its own agent setup context instead of sharing one global.
  const [aiCliDir, setAiCliDir] = useState<string>("");
  const [renameTarget, setRenameTarget] = useState<TerminalTab | null>(null);

  const config = useTerminalConfig({
    setLastError,
    isSettingsOpen,
    onSettingsSaved: (next) => music.setMuted(Boolean(next.musicStartMuted)),
  });
  const { userSettings } = config;
  const music = useMusicPlayer({ showMusicPlayer: userSettings.showMusicPlayer });

  const tabsState = useTabs({
    cwd,
    effectiveShellPath: config.effectiveShellPath,
    setLastError,
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
  const focusActiveTerminalSoon = useCallback(() => {
    const attempt = (tries: number) => {
      const term = getActiveTerminal();
      if (term) {
        term.focus();
      } else if (tries > 0) {
        window.setTimeout(() => attempt(tries - 1), 50);
      }
    };
    requestAnimationFrame(() => attempt(3));
  }, [getActiveTerminal]);

  const newTabAndFocus = useCallback(
    (opts?: { cwd?: string }) => {
      tabsState.newTab(opts);
      focusActiveTerminalSoon();
    },
    [tabsState.newTab, focusActiveTerminalSoon]
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

  /** Effective project dir: active pane -> tab -> global toolbar input. */
  const effectiveProjectDir = resolveEffectiveProjectDir(activePane?.cwd, activeTab?.cwd, cwd);

  const { setPaneCodeMode, modeDisplay, exitCodeMode } = useCodeMode({
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
    cwd,
    effectiveProjectDir,
  });
  const project = useProjectActions({
    effectiveProjectDir,
    cwd,
    editorPath: userSettings.editorPath,
    setLastError,
    applyGitInfo: git.applyGitInfo,
  });
  const handleCwdResolved = usePaneCwd({
    tabsRef,
    activeTabIdRef,
    cwdRef,
    setTabs,
    setCwd,
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
    cwdRef,
    setLastError,
  });
  const persistence = useSessionPersistence({
    tabs,
    setTabs,
    setActiveTabId,
    autoRestoreSession: userSettings.autoRestoreSession,
    onWorkspaceCwd: setCwd,
  });
  const updates = useAppUpdates({
    autoCheckUpdates: userSettings.autoCheckUpdates,
    setLastError,
  });
  useWindowRefit({ tabsRef, activeTabIdRef, terminalRefs });
  usePrefetchPanels();

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

  const toggleSearch = useCallback(() => getActiveTerminal()?.toggleSearch(), [getActiveTerminal]);
  const openAiCli = useCallback(() => {
    setAiCliDir(effectiveProjectDir);
    setIsAiCliOpen(true);
  }, [effectiveProjectDir]);
  const openSettings = useCallback(() => setIsSettingsOpen(true), []);
  // Opening the player for the first time also enables it in Settings so the
  // footer mini-player and shortcuts stay available after the panel closes.
  const toggleMusicPanel = () => {
    const opening = !music.isOpen;
    music.togglePanel();
    if (opening && !userSettings.showMusicPlayer) {
      config.saveSettings({ ...userSettings, showMusicPlayer: true });
    }
  };

  useAppShortcuts({
    keybindings: userSettings.keybindings,
    fixedKeybindings: userSettings.fixedKeybindings,
    newTab: newTabAndFocus,
    closeActiveTab: () => tabsState.closeTab(activeTabId),
    toggleCommandPalette: () => setIsCommandPaletteOpen((prev) => !prev),
    toggleSearch,
    toggleSettings: () => setIsSettingsOpen((prev) => !prev),
    splitPane: tabsState.splitPane,
    closeActivePane: tabsState.closeActivePane,
    cycleTab: tabsState.cycleTab,
    focusNextPane: tabsState.focusNextPane,
    gotoTab: tabsState.gotoTab,
    zoomFont: config.zoomFont,
    toggleMusic: toggleMusicPanel,
    musicEvent: music.dispatchEvent,
    reviewChanges: () => project.reviewChanges(),
  });

  const pasteFromClipboard = useCallback(async () => {
    try {
      const text = await readClipboardText();
      if (text) getActiveTerminal()?.pasteText(text);
    } catch (err) {
      console.error("Failed to read clipboard:", err);
    }
  }, [getActiveTerminal]);

  const commandActions = buildCommandActions({
    keybindings: userSettings.keybindings,
    isMac: isMacPlatform(),
    newTab: newTabAndFocus,
    cycleTab: tabsState.cycleTab,
    focusNextPane: tabsState.focusNextPane,
    openWorkspaces: () => setIsWorkspaceOpen(true),
    splitPane: tabsState.splitPane,
    closeActivePane: tabsState.closeActivePane,
    toggleMusic: toggleMusicPanel,
    renameActiveTab: () => setRenameTarget(activeTab),
    openEditor: () => void project.openEditor(),
    showGitStatus: () => void project.showGit("status"),
    reviewChanges: () => project.reviewChanges(true),
    checkUpdates: () => void updates.checkUpdates(true),
    closeActiveTab: () => tabsState.closeTab(activeTabId),
    toggleSearch,
    copySelection: () => getActiveTerminal()?.copySelection(),
    pasteClipboard: () => void pasteFromClipboard(),
    clearTerminal: () => getActiveTerminal()?.clear(),
    openAiCli,
    openDiagnostics: () => setIsDiagnosticsOpen(true),
    openSettings,
  });

  return (
    <div className="app-layout" data-theme={userSettings.theme}>
      <div className="app-header">
        <TabBar
          tabs={tabs}
          activeTabId={activeTabId}
          onSelectTab={setActiveTabId}
          onCloseTab={tabsState.closeTab}
          onNewTab={() => newTabAndFocus()}
          onRenameTab={tabsState.renameTab}
          onMoveTab={tabsState.moveTab}
          onReorderTabs={tabsState.reorderTabs}
          onMoveTabToIndex={tabsState.moveTabToIndex}
          onSetTabColor={tabsState.setTabColor}
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
            onOpenEditor={project.openEditor}
            editorPath={userSettings.editorPath}
            installedEditors={project.installedEditors}
            isLoadingEditors={project.isLoadingEditors}
            onRefreshEditors={project.refreshInstalledEditors}
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
            skipShellProfile={userSettings.skipShellProfile === true}
            settings={userSettings}
            fallbackCwd={cwd}
            terminalRefs={terminalRefs}
            onFocusPane={tabsState.focusPane}
            onCodeModeChange={setPaneCodeMode}
            onCwdResolved={handleCwdResolved}
            onExit={handleSessionExit}
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
          onClose={() => setIsSettingsOpen(false)}
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
          onLoadWorkspace={persistence.restoreWorkspace}
        />

        <AiCliPanel
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

        <MusicHost
          mounted={Boolean(userSettings.showMusicPlayer) || music.isOpen}
          startMuted={music.muted}
          open={music.isOpen}
          onClose={music.closePanel}
          onTrackChange={music.handleTrackChange}
          onMutedChange={music.setMuted}
          onProgressChange={music.setProgress}
        />
      </Suspense>

      {renameTarget && (
        <RenameTabDialog
          key={renameTarget.id}
          tab={renameTarget}
          onRename={tabsState.renameTab}
          onClose={() => setRenameTarget(null)}
        />
      )}

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
        onToggleMode={exitCodeMode}
        music={music.footerState}
        onToggleMusicPanel={toggleMusicPanel}
        musicOpen={music.isOpen}
        onMusicPlayPause={() => music.dispatchEvent("kai-music-toggle-play")}
        onMusicPrevious={() => music.dispatchEvent("kai-music-previous")}
        onMusicNext={() => music.dispatchEvent("kai-music-next")}
        onMusicMute={() => music.dispatchEvent("kai-music-mute")}
      />
    </div>
  );
}

export default App;
