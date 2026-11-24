import { useCallback, useRef, type Dispatch, type RefObject, type SetStateAction } from "react";
import { GIT_BADGE_MIN_INTERVAL_MS } from "../services/cwdCommand";
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
  tabsRef: RefObject<TerminalTab[]>;
  activeTabIdRef: RefObject<string>;
  setTabs: Dispatch<SetStateAction<TerminalTab[]>>;
  applyGitInfo: (dir: string, info: GitInfo, updatesFooter: boolean) => void;
}

/**
 * Handles a pane reporting its working directory (OSC 7 / OSC 9;9 / backend
 * `getPtyCwd`). Returns a stable `(tabId, paneId, cwd)` callback.
 */
export function usePaneCwd({ tabsRef, activeTabIdRef, setTabs, applyGitInfo }: PaneCwdOptions) {
  // When each directory's badge was last force-refreshed (see the unchanged branch below).
  const lastForcedRef = useRef<Map<string, number>>(new Map());
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
      // Only the pane's OWN recorded directory counts. Falling back to the
      // tab's directory made a pane whose first report equalled it look
      // "unchanged", so it was never recorded.
      const current = livePane?.cwd;
      const drivesFooter =
        activeTabIdRef.current === tabId &&
        (live?.activePaneId === paneId || (live?.panes.length ?? 0) <= 1);

      if (current && normalizeCwdForCompare(current) === normalizeCwdForCompare(cleaned)) {
        if (drivesFooter) {
          // The folder is the same, but the shell just reported in (a prompt, or a `git ...`
          // line), so the branch / dirty state may have changed: `git checkout -b x` must show
          // up. A cache-only refresh never would (it serves the 30 s old answer), so drop the
          // cached answer, at most once per GIT_BADGE_MIN_INTERVAL_MS per directory (FUNC-04).
          const key = normalizeCwdForCompare(cleaned);
          const now = Date.now();
          const last = lastForcedRef.current.get(key) ?? 0;
          if (now - last >= GIT_BADGE_MIN_INTERVAL_MS) {
            lastForcedRef.current.set(key, now);
            invalidateGitCache(cleaned);
          }
          refreshBadge();
        }
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
        recordRecentProject(cleaned);
        invalidateGitCache(cleaned);
        refreshBadge();
      }
    },
    [tabsRef, activeTabIdRef, setTabs, applyGitInfo]
  );
}
