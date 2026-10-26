import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from "react";
import {
  PersistedTab,
  createDefaultTab,
  loadPersistedLayout,
  savePersistedLayout,
} from "../services/tabFactory";
import { sanitizeWorkspaceForRestore, type Workspace } from "../services/workspaces";
import type { TerminalTab } from "../types/terminal";

interface SessionPersistenceOptions {
  tabs: TerminalTab[];
  setTabs: Dispatch<SetStateAction<TerminalTab[]>>;
  setActiveTabId: (id: string) => void;
  /** Opt-in: load the previous session immediately instead of offering it. */
  autoRestoreSession: boolean | undefined;
  /** Receives the first restored tab's cwd after a workspace load. */
  onWorkspaceCwd: (cwd: string) => void;
}

const toTabs = (persisted: PersistedTab[]) =>
  persisted.map((t) => createDefaultTab(t.title, t.shellPath, t.cwd, t));

/**
 * Persists the safe UI layout (titles, color, cwd, pane structure — never
 * history) and handles bringing a previous session or a saved workspace back.
 */
export function useSessionPersistence({
  tabs,
  setTabs,
  setActiveTabId,
  autoRestoreSession,
  onWorkspaceCwd,
}: SessionPersistenceOptions) {
  // Tabs from the previous launch, offered once via banner (never auto-run).
  const [pendingRestore, setPendingRestore] = useState<PersistedTab[] | null>(() => {
    const persisted = loadPersistedLayout();
    return persisted && persisted.length > 0 ? persisted : null;
  });

  const applyRestoredTabs = useCallback(
    (restored: TerminalTab[]) => {
      setTabs(restored);
      setActiveTabId(restored[0].id);
    },
    [setTabs, setActiveTabId]
  );

  // Persist on tab change. Skipped while a previous session is still
  // awaiting the user's Restore/Dismiss decision, so the banner offer is
  // never overwritten by the fresh starter tab.
  useEffect(() => {
    if (pendingRestore !== null) return;
    savePersistedLayout(tabs);
  }, [tabs, pendingRestore]);

  // Opt-in auto-restore: when enabled in settings, the previous session
  // loads immediately without asking (previous default behavior).
  useEffect(() => {
    if (autoRestoreSession && pendingRestore && pendingRestore.length > 0) {
      applyRestoredTabs(toTabs(pendingRestore));
      setPendingRestore(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRestoreSession]);

  const restoreSession = useCallback(() => {
    if (pendingRestore && pendingRestore.length > 0) {
      applyRestoredTabs(toTabs(pendingRestore));
    }
    setPendingRestore(null);
  }, [pendingRestore, applyRestoredTabs]);

  const dismissRestore = useCallback(() => setPendingRestore(null), []);

  const restoreWorkspace = useCallback(
    (ws: Workspace) => {
      if (!ws.tabs || ws.tabs.length === 0) return;
      // Re-validate persisted data at restore time: drops malformed tabs and
      // clears un-restorable cwd values (backend falls back to HOME at spawn).
      // Fresh pane ids are minted below so no backend PTY session is reused.
      const safe = sanitizeWorkspaceForRestore(ws);
      if (safe.tabs.length === 0) return;
      applyRestoredTabs(toTabs(safe.tabs));
      if (safe.tabs[0]?.cwd) onWorkspaceCwd(safe.tabs[0].cwd);
    },
    [applyRestoredTabs, onWorkspaceCwd]
  );

  return { pendingRestore, restoreSession, dismissRestore, restoreWorkspace };
}
