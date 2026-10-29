import { useCallback, useEffect, useState, type MutableRefObject } from "react";
import {
  GitInfo,
  getCachedGitInfo,
  getGitInfoCached,
  invalidateGitCache,
  resolveEffectiveProjectDir,
} from "../services/projectService";
import type { TerminalPane, TerminalTab } from "../types/terminal";
import { useLatest } from "./useLatest";

/**
 * Pause before the first `git` probe in a directory the user just entered.
 * The path pill is already settled by the time this starts (CWD_SETTLE_MS),
 * so this only needs to skip pass-through directories.
 */
const GIT_DWELL_MS = 300;
/** Debounce for per-pane probes after tabs / directories change. */
const GIT_FETCH_DEBOUNCE_MS = 600;

interface GitFooter {
  branch: string | null;
  dirty: boolean;
  repoRoot: string | null;
}

const EMPTY_FOOTER: GitFooter = { branch: null, dirty: false, repoRoot: null };

const footerFromInfo = (info: GitInfo | null | undefined): GitFooter => ({
  branch: info?.branch ?? null,
  dirty: info?.dirty ?? false,
  repoRoot: info?.repo_root ?? null,
});

const sameFooter = (a: GitFooter, b: GitFooter) =>
  a.branch === b.branch && a.dirty === b.dirty && a.repoRoot === b.repoRoot;

interface GitStatusOptions {
  tabs: TerminalTab[];
  tabsRef: MutableRefObject<TerminalTab[]>;
  activeTabId: string;
  activeTabIdRef: MutableRefObject<string>;
  activeTab: TerminalTab | undefined;
  activePane: TerminalPane | undefined;
  activePaneId: string | undefined;
  /** Global toolbar working directory. */
  cwd: string;
  /** Active pane's project dir (pane -> tab -> toolbar). */
  effectiveProjectDir: string;
}

/**
 * Git badge state. Each split tracks its own repo/branch/dirty entry keyed
 * by resolved directory (`gitInfoByDir`); the status bar shows the active
 * pane's entry. Probe failures always keep the last good badge — a failed
 * `git` spawn must never blank the footer while typing.
 */
export function useGitStatus({
  tabs,
  tabsRef,
  activeTabId,
  activeTabIdRef,
  activeTab,
  activePane,
  activePaneId,
  cwd,
  effectiveProjectDir,
}: GitStatusOptions) {
  const cwdRef = useLatest(cwd);
  const [gitInfoByDir, setGitInfoByDir] = useState<Record<string, GitInfo | null>>({});
  const [footer, setFooter] = useState<GitFooter>(EMPTY_FOOTER);
  const [isRefreshingGit, setIsRefreshingGit] = useState(false);

  const updateFooter = useCallback((next: GitFooter) => {
    setFooter((prev) => (sameFooter(prev, next) ? prev : next));
  }, []);

  /**
   * Records a probe result for `dir`; also drives the footer when `dir` is
   * the active pane's directory. Skips the state write when nothing the UI
   * reads (branch / dirty / repo root) changed, so idle probes never re-render.
   */
  const applyGitInfo = useCallback(
    (dir: string, info: GitInfo, updatesFooter: boolean) => {
      setGitInfoByDir((prev) =>
        prev[dir]?.branch === info.branch &&
        prev[dir]?.dirty === info.dirty &&
        prev[dir]?.repo_root === info.repo_root
          ? prev
          : { ...prev, [dir]: info }
      );
      if (updatesFooter) updateFooter(footerFromInfo(info));
    },
    [updateFooter]
  );

  /** Resolve each pane's own project dir (pane -> tab -> global). */
  const paneDirsKey = tabs
    .map((t) => t.panes.map((p) => resolveEffectiveProjectDir(p.cwd, t.cwd, cwd)).join("|"))
    .join("||");

  // Refresh git status per distinct pane directory (each split owns its
  // repo badge): debounced on change plus on window focus and after every
  // submitted command (TerminalView re-probes post-Enter). No 30 s background
  // timer: each tick spawns `git` per pane, which on Windows (MSYS build +
  // Defender) is the heaviest recurring cost while Kai sits idle behind
  // other apps. The status bar reads the active pane's entry from the map.
  useEffect(() => {
    const dirs = Array.from(
      new Set(
        tabs.flatMap((t) =>
          t.panes.map((p) => resolveEffectiveProjectDir(p.cwd, t.cwd, cwdRef.current))
        )
      )
    ).filter(Boolean);
    if (dirs.length === 0) {
      updateFooter(EMPTY_FOOTER);
      return;
    }
    let cancelled = false;
    const fetchAll = () => {
      if (typeof document !== "undefined" && document.hidden) return;
      for (const dir of dirs) {
        void getGitInfoCached(dir).then(
          (info) => {
            if (cancelled) return;
            // Keep the active-pane footer in sync.
            const activeDir = resolveEffectiveProjectDir(
              activePane?.cwd,
              activeTab?.cwd,
              cwdRef.current
            );
            applyGitInfo(dir, info, dir === activeDir);
          },
          () => {
            // Probe failure: keep the last good badge.
          }
        );
      }
    };
    const timer = setTimeout(fetchAll, GIT_FETCH_DEBOUNCE_MS);
    window.addEventListener("focus", fetchAll);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      window.removeEventListener("focus", fetchAll);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paneDirsKey, activeTabId]);

  // Footer git badge with dwell: the path pill updates instantly, but the
  // git probe only fires after the user has stayed in one directory for
  // ~800 ms. Fast `cd` hopping keeps the last good badge instead of
  // flickering through "No git repo" / partial states. Cache hits still
  // apply synchronously (zero IPC). Same behavior on all OSes.
  useEffect(() => {
    if (!effectiveProjectDir) {
      updateFooter(EMPTY_FOOTER);
      return;
    }
    const cached = gitInfoByDir[effectiveProjectDir];
    if (cached !== undefined) updateFooter(footerFromInfo(cached));
    // Cache-first: the module cache is keyed normalized, so a repeat visit
    // (or a `\\?\`-prefixed twin of the same dir) applies synchronously
    // with zero IPC — no "No git repo" flash frame while typing.
    const syncHit = getCachedGitInfo(effectiveProjectDir);
    if (syncHit && cached === undefined) {
      applyGitInfo(effectiveProjectDir, syncHit, true);
      return;
    }
    // Known directory: revalidate in the background without blanking.
    // Unknown directory: dwell before the first spawn so quick pass-through
    // `cd`s never spawn `git` at all. The previous badge stays visible meanwhile.
    let cancelled = false;
    const timer = setTimeout(() => {
      void getGitInfoCached(effectiveProjectDir).then(
        (info) => {
          if (cancelled) return;
          applyGitInfo(effectiveProjectDir, info, true);
        },
        () => {
          // Probe failure: keep the last good badge — never blank the footer.
        }
      );
    }, GIT_DWELL_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveProjectDir, activePaneId, activeTabId]);

  /** Footer refresh button: re-probe git for the active pane. */
  const refreshGit = useCallback(() => {
    // Read live refs (not state closures) so the refresh always targets the
    // currently active pane, even right after tab/split switches.
    const liveTabs = tabsRef.current;
    const tab = liveTabs.find((t) => t.id === activeTabIdRef.current) || liveTabs[0];
    const pane = tab?.panes.find((p) => p.id === tab.activePaneId) || tab?.panes[0];
    const dir = resolveEffectiveProjectDir(pane?.cwd, tab?.cwd, cwdRef.current);
    if (!dir || isRefreshingGit) return;
    setIsRefreshingGit(true);
    invalidateGitCache(dir);
    void getGitInfoCached(dir)
      .then(
        (info) => applyGitInfo(dir, info, true),
        () => {
          // Refresh failed: keep the last good badge (spinner stops below).
        }
      )
      .finally(() => setIsRefreshingGit(false));
  }, [isRefreshingGit, applyGitInfo, tabsRef, activeTabIdRef, cwdRef]);

  // The status bar prefers the active directory's own entry; the shared
  // footer state only covers directories not probed yet.
  const activeEntry = effectiveProjectDir ? gitInfoByDir[effectiveProjectDir] : undefined;
  const statusGit = activeEntry !== undefined ? footerFromInfo(activeEntry) : footer;

  return { statusGit, isRefreshingGit, refreshGit, applyGitInfo };
}
