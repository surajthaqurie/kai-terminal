import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import {
  GitInfo,
  cleanCwdForStore,
  getGitInfoCached,
  invalidateGitCache,
  normalizeCwdForCompare,
  recordRecentProject,
} from "../services/projectService";
import type { TerminalTab } from "../types/terminal";

interface PaneCwdOptions {
  tabsRef: MutableRefObject<TerminalTab[]>;
  activeTabIdRef: MutableRefObject<string>;
  cwdRef: MutableRefObject<string>;
  setTabs: Dispatch<SetStateAction<TerminalTab[]>>;
  setCwd: (cwd: string) => void;
  applyGitInfo: (dir: string, info: GitInfo, updatesFooter: boolean) => void;
}

/**
 * Handles a pane reporting its working directory (OSC 7 / OSC 9;9 / backend
 * `getPtyCwd`). Returns a stable `(tabId, paneId, cwd)` callback.
 */
export function usePaneCwd({
  tabsRef,
  activeTabIdRef,
  cwdRef,
  setTabs,
  setCwd,
  applyGitInfo,
}: PaneCwdOptions) {
  return useCallback(
    (tabId: string, paneId: string, resolved: string) => {
      if (!resolved) return;
      // Normalize BEFORE comparing: OSC 7 / OSC 9;9 / backend
      // `getPtyCwd` report the same directory in different
      // textual forms (`C:\x` vs `C:/x` vs `\\?\C:\x`). A raw
      // `===` treated every prompt as a directory *change* —
      // rewriting tab state, touching localStorage, and
      // re-spawning `git`, which blanked the footer while
      // typing. Store the cleaned form so it never flaps.
      const cleaned = cleanCwdForStore(resolved);
      if (!cleaned) return;
      const refreshBadge = () =>
        void getGitInfoCached(cleaned).then(
          (info) => applyGitInfo(cleaned, info, true),
          () => {
            // Keep the last good badge on probe failure.
          }
        );

      // No-op probes (cwd unchanged) skip the whole cascade:
      // previously every probe rewrote tab state, touched
      // localStorage, invalidated the git cache, and spawned
      // `git` — per Enter, ×3. Unchanged dirs refresh the
      // badge from cache only (no spawn unless the TTL
      // expired), so `git commit` still updates the badge.
      const live = tabsRef.current.find((t) => t.id === tabId);
      const livePane = live?.panes.find((p) => p.id === paneId);
      const current = livePane?.cwd || live?.cwd || cwdRef.current;
      const drivesFooter =
        activeTabIdRef.current === tabId &&
        (live?.activePaneId === paneId || (live?.panes.length ?? 0) <= 1);

      if (current && normalizeCwdForCompare(current) === normalizeCwdForCompare(cleaned)) {
        if (drivesFooter) refreshBadge();
        return;
      }
      setTabs((prev) =>
        prev.map((t) =>
          t.id === tabId
            ? {
                ...t,
                cwd: t.activePaneId === paneId || t.panes.length === 1 ? cleaned : t.cwd,
                panes: t.panes.map((p) => (p.id === paneId ? { ...p, cwd: cleaned } : p)),
              }
            : t
        )
      );
      if (drivesFooter) {
        setCwd(cleaned);
        recordRecentProject(cleaned);
        invalidateGitCache(cleaned);
        refreshBadge();
      }
    },
    [tabsRef, activeTabIdRef, cwdRef, setTabs, setCwd, applyGitInfo]
  );
}
