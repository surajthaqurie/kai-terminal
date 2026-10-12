import { invoke } from "@tauri-apps/api/core";
import { isTauriAvailable } from "./ptyService";

export interface GitInfo {
  branch: string | null;
  dirty: boolean;
  ahead_behind: string | null;
  repo_root: string | null;
  error: string | null;
}

export interface ProjectIntelligenceInfo {
  status: "ready" | "indexing" | "unindexed" | "stale";
  file_count: number;
  symbol_count: number;
  total_tokens_estimated: number;
  last_indexed_at: string | null;
}

export async function getProjectIntelligence(cwd: string): Promise<ProjectIntelligenceInfo> {
  if (!isTauriAvailable() || !cwd.trim()) {
    return {
      status: "unindexed",
      file_count: 0,
      symbol_count: 0,
      total_tokens_estimated: 0,
      last_indexed_at: null,
    };
  }
  try {
    return await invoke<ProjectIntelligenceInfo>("get_project_intelligence_cmd", { cwd });
  } catch {
    return {
      status: "unindexed",
      file_count: 0,
      symbol_count: 0,
      total_tokens_estimated: 0,
      last_indexed_at: null,
    };
  }
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
export const ACTIVE_PROJECT_KEY = "kai_active_project";
export const ACTIVE_MODE_KEY = "kai_active_mode";
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

/** Get the currently selected active project, falling back to most recent project. */
export function getActiveProject(): string | null {
  try {
    const active = localStorage.getItem(ACTIVE_PROJECT_KEY);
    if (active && active.trim()) {
      return active.trim();
    }
    const recent = loadRecentProjects();
    if (recent.length > 0 && recent[0].trim()) {
      return recent[0].trim();
    }
  } catch {
    // ignore
  }
  return null;
}

/** Set the active project directory and mode. */
export function setActiveProject(dir: string, mode: string = "code"): void {
  const trimmed = dir.trim();
  if (!trimmed) return;
  try {
    localStorage.setItem(ACTIVE_PROJECT_KEY, trimmed);
    localStorage.setItem(ACTIVE_MODE_KEY, mode);
    recordRecentProject(trimmed);
  } catch {
    // ignore
  }
}

/** Get active mode ("code" by default, or "terminal"). */
export function getActiveMode(): string {
  try {
    return localStorage.getItem(ACTIVE_MODE_KEY) || "code";
  } catch {
    return "code";
  }
}

/** Set active mode. */
export function setActiveMode(mode: string): void {
  try {
    localStorage.setItem(ACTIVE_MODE_KEY, mode);
  } catch {
    // ignore
  }
}

/**
 * Clear Code Mode: drops the active project and returns to plain terminal
 * mode. Recent-project history is kept — only the active selection is
 * cleared (mirrors `kai stop code` in the CLI).
 */
export function clearActiveProject(): void {
  try {
    localStorage.removeItem(ACTIVE_PROJECT_KEY);
    localStorage.setItem(ACTIVE_MODE_KEY, "terminal");
  } catch {
    // ignore
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

export interface InstalledEditor {
  id: string;
  name: string;
  binary: string;
  path: string;
}

/** Well-known editors used as a fallback when the backend is unavailable (browser/mock). */
export const KNOWN_EDITORS_FALLBACK: InstalledEditor[] = [
  { id: "vscode", name: "Visual Studio Code", binary: "code", path: "code" },
  { id: "cursor", name: "Cursor", binary: "cursor", path: "cursor" },
  { id: "windsurf", name: "Windsurf", binary: "windsurf", path: "windsurf" },
  { id: "vscodium", name: "VSCodium", binary: "codium", path: "codium" },
  { id: "sublime", name: "Sublime Text", binary: "subl", path: "subl" },
  { id: "zed", name: "Zed", binary: "zed", path: "zed" },
];

export async function getInstalledEditors(): Promise<InstalledEditor[]> {
  if (!isTauriAvailable()) return [];
  try {
    const list = await invoke<InstalledEditor[]>("detect_installed_editors_cmd");
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/**
 * Resolves the effective project directory for actions like "Open in
 * editor", git badges, and new tabs/splits.
 * Priority: active pane cwd -> tab cwd -> global toolbar cwd.
 * Trims whitespace/quotes; returns "" when nothing usable was provided
 * (callers must NOT fall back to "/" — the backend defaults to HOME).
 */
export function resolveEffectiveProjectDir(
  ...candidates: Array<string | undefined | null>
): string {
  for (const c of candidates) {
    if (typeof c !== "string") continue;
    const t = c.trim().replace(/^["']+|["']+$/g, "");
    if (t) return t;
  }
  return "";
}

export async function openProjectInEditor(cwd?: string, editorPath?: string): Promise<string> {
  if (!isTauriAvailable()) {
    throw new Error("Editor launch is only available inside the desktop app.");
  }
  const dir = resolveEffectiveProjectDir(cwd) || ".";
  return await invoke<string>("open_project_in_editor", {
    cwd: dir,
    editorPath: editorPath?.trim() || null,
  });
}

/** Bounded per-directory git cache: avoids repeated expensive git spawns on every render. */
const gitCache = new Map<string, { info: GitInfo; at: number }>();
export const GIT_CACHE_TTL_MS = 30000;
// In-flight dedup: concurrent callers for the same dir share one IPC round-trip.
const gitInflight = new Map<string, Promise<GitInfo>>();

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
  const key = gitCacheKey(cwd);
  const inflight = gitInflight.get(key);
  if (inflight) return inflight;
  const p = getGitInfo(cwd)
    .then((info) => {
      setCachedGitInfo(cwd, info);
      return info;
    })
    .finally(() => {
      gitInflight.delete(key);
    });
  gitInflight.set(key, p);
  return p;
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
