import { useCallback, useRef, useState, type MutableRefObject } from "react";
import { closeAppWindow } from "../services/appWindow";
import {
  countBusyPanes,
  describeClose,
  liveSessionIds,
  type CloseConfirmation,
  type CloseKind,
} from "../services/closeGuard";
import type { HandoffTerminal } from "../services/tabHandoff";
import type { TerminalTab } from "../types/terminal";
import type { Workspace } from "../services/workspaces";

export interface PendingClose extends CloseConfirmation {
  confirm: () => void;
  cancel: () => void;
}

interface CloseGuardOptions {
  tabsRef: MutableRefObject<TerminalTab[]>;
  activeTabIdRef: MutableRefObject<string>;
  terminalRefs: MutableRefObject<Record<string, HandoffTerminal | null | undefined>>;
  closeTab: (id: string) => void;
  closeActivePane: () => void;
  restoreWorkspace: (workspace: Workspace) => void;
}

/**
 * Asks before a user-initiated close would end running commands.
 *
 * Only closes the USER asked for go through here (tab button / shortcut /
 * palette, close pane, load workspace). A shell that exits by itself still
 * closes its pane directly. When nothing is running (idle prompts, panes that
 * never started) the close happens immediately and synchronously, exactly as
 * before; the only cost is one backend query when a live session exists.
 */
export function useCloseGuard({
  tabsRef,
  activeTabIdRef,
  terminalRefs,
  closeTab,
  closeActivePane,
  restoreWorkspace,
}: CloseGuardOptions) {
  const [pending, setPending] = useState<PendingClose | null>(null);
  // A check or an open question is in progress: further close requests wait for it.
  const busy = useRef(false);

  const backendIdOf = useCallback(
    (paneId: string) => terminalRefs.current[paneId]?.handoffSessionId() ?? null,
    [terminalRefs]
  );

  const guard = useCallback(
    (paneIds: string[], kind: CloseKind, proceed: () => void) => {
      if (busy.current) return;
      if (liveSessionIds(paneIds, backendIdOf).length === 0) {
        proceed();
        return;
      }
      busy.current = true;
      void countBusyPanes(paneIds, backendIdOf).then((running) => {
        if (running === 0) {
          busy.current = false;
          proceed();
          return;
        }
        const finish = (run: boolean) => {
          setPending(null);
          busy.current = false;
          if (run) proceed();
        };
        setPending({
          ...describeClose(kind, running),
          confirm: () => finish(true),
          cancel: () => finish(false),
        });
      });
    },
    [backendIdOf]
  );

  const requestCloseTab = useCallback(
    (id: string) => {
      const tab = tabsRef.current.find((t) => t.id === id);
      if (!tab) return;
      const kind: CloseKind = tabsRef.current.length <= 1 ? "window" : "tab";
      guard(
        tab.panes.map((p) => p.id),
        kind,
        () => closeTab(id)
      );
    },
    [tabsRef, guard, closeTab]
  );

  const requestCloseActivePane = useCallback(() => {
    const tab = tabsRef.current.find((t) => t.id === activeTabIdRef.current);
    // A single-pane tab has nothing to close here (the tab itself is closed instead).
    if (!tab || tab.panes.length <= 1) {
      closeActivePane();
      return;
    }
    guard(tab.activePaneId ? [tab.activePaneId] : [], "pane", closeActivePane);
  }, [tabsRef, activeTabIdRef, guard, closeActivePane]);

  const requestRestoreWorkspace = useCallback(
    (workspace: Workspace) => {
      const paneIds = tabsRef.current.flatMap((t) => t.panes.map((p) => p.id));
      guard(paneIds, "workspace", () => restoreWorkspace(workspace));
    },
    [tabsRef, guard, restoreWorkspace]
  );

  /** Closing the whole window (its close button, or the system asking): every shell in it ends. */
  const requestCloseWindow = useCallback(() => {
    const paneIds = tabsRef.current.flatMap((t) => t.panes.map((p) => p.id));
    guard(paneIds, "window", () => void closeAppWindow());
  }, [tabsRef, guard]);

  return {
    pending,
    requestCloseTab,
    requestCloseActivePane,
    requestRestoreWorkspace,
    requestCloseWindow,
  };
}
