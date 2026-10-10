import { invoke } from "@tauri-apps/api/core";
import { isTauriAvailable } from "./ptyService";

export interface GitInfo {
  branch: string | null;
  dirty: boolean;
  ahead_behind: string | null;
  repo_root: string | null;
  error: string | null;
}

export async function getGitInfo(cwd: string): Promise<GitInfo> {
  if (!isTauriAvailable() || !cwd.trim()) {
    return {
      branch: null,
      dirty: false,
      ahead_behind: null,
      repo_root: null,
      error: null,
    };
  }
  try {
    return await invoke<GitInfo>("get_git_info_cmd", { cwd });
  } catch {
    return {
      branch: null,
      dirty: false,
      ahead_behind: null,
      repo_root: null,
      error: "Git query failed",
    };
  }
}

const RECENT_KEY = "kai_recent_projects";
const LEGACY_RECENT_KEY = "terminal_recent_projects";
const MAX_RECENT = 10;

export function loadRecentProjects(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY) || localStorage.getItem(LEGACY_RECENT_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((x) => typeof x === "string").slice(0, MAX_RECENT)
      : [];
  } catch {
    return [];
  }
}

/** Records a working directory as recently used. Never replays history automatically. */
export function recordRecentProject(cwd: string): string[] {
  const trimmed = cwd.trim();
  if (!trimmed) return loadRecentProjects();
  try {
    const prev = loadRecentProjects().filter((p) => p !== trimmed);
    const next = [trimmed, ...prev].slice(0, MAX_RECENT);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
    return next;
  } catch {
    return loadRecentProjects();
  }
}

export async function openProjectInEditor(cwd: string, editorPath?: string): Promise<string> {
  if (!isTauriAvailable()) {
    throw new Error("Editor launch is only available inside the desktop app.");
  }
  return await invoke<string>("open_project_in_editor", {
    cwd,
    editorPath: editorPath?.trim() || null,
  });
}

/** Bounded per-directory git cache: avoids repeated expensive git spawns on every render. */
const gitCache = new Map<string, { info: GitInfo; at: number }>();
export const GIT_CACHE_TTL_MS = 5000;

export function gitCacheKey(cwd: string): string {
  return cwd.trim();
}

export function getCachedGitInfo(cwd: string, now = Date.now()): GitInfo | null {
  const entry = gitCache.get(gitCacheKey(cwd));
  if (!entry) return null;
  if (now - entry.at > GIT_CACHE_TTL_MS) {
    gitCache.delete(gitCacheKey(cwd));
    return null;
  }
  return entry.info;
}

export function setCachedGitInfo(cwd: string, info: GitInfo, now = Date.now()): void {
  // Bound cache size so long sessions cannot grow memory without limit.
  if (gitCache.size >= 50) {
    const oldest = gitCache.keys().next().value;
    if (oldest !== undefined) gitCache.delete(oldest);
  }
  gitCache.set(gitCacheKey(cwd), { info, at: now });
}

export function invalidateGitCache(cwd?: string): void {
  if (cwd) gitCache.delete(gitCacheKey(cwd));
  else gitCache.clear();
}

export async function getGitInfoCached(cwd: string): Promise<GitInfo> {
  const hit = getCachedGitInfo(cwd);
  if (hit) return hit;
  const info = await getGitInfo(cwd);
  setCachedGitInfo(cwd, info);
  return info;
}

export async function runGitAction(
  cwd: string,
  action: "fetch" | "pull" | "status"
): Promise<string> {
  if (!isTauriAvailable()) {
    throw new Error("Git actions are only available inside the desktop app.");
  }
  return await invoke<string>("run_git_action_cmd", { cwd, action });
}
