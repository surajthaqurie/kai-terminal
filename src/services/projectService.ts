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

/** Get the currently selected active project.
 *
 * Code Mode is ONLY entered via `kai code <path>` (which writes the explicit
 * `kai_active_project` key / `active_project.json` state file) and cleared
 * via `kai stop code`. Opening recent folders or new tabs must NEVER
 * activate Code Mode — so there is intentionally NO fallback to recent
 * history here. Returns null in plain terminal mode.
 */
export function getActiveProject(): string | null {
  try {
    const active = localStorage.getItem(ACTIVE_PROJECT_KEY);
    if (active && active.trim()) {
      return active.trim();
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

/** Get active mode ("terminal" by default — Code Mode requires `kai code`). */
export function getActiveMode(): string {
  try {
    const m = localStorage.getItem(ACTIVE_MODE_KEY);
    return m === "code" ? "code" : "terminal";
  } catch {
    return "terminal";
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

export interface ActiveProjectState {
  path: string | null;
  mode: string;
}

/**
 * Authoritative Code Mode state. Prefers the backend (`active_project.json`
 * state file + `KAI_ACTIVE_PROJECT`/`KAI_MODE` launch env, written by
 * `kai code`), which works in dev AND release builds. Falls back to the
 * explicit localStorage keys (no recent-history fallback). Never defaults
 * to code: anything unrecognized resolves to plain terminal mode.
 */
export async function getActiveProjectState(): Promise<ActiveProjectState> {
  if (isTauriAvailable()) {
    try {
      const s = await invoke<{ path: string | null; mode: string }>("get_active_project_cmd");
      const rawPath = typeof s?.path === "string" ? s.path.trim() : "";
      const mode = s?.mode === "code" && rawPath ? "code" : "terminal";
      const path = mode === "code" ? rawPath : null;
      // Mirror into localStorage so focus-polling and tests see the same
      // explicit state even if the backend becomes briefly unavailable.
      try {
        if (path) {
          localStorage.setItem(ACTIVE_PROJECT_KEY, path);
          localStorage.setItem(ACTIVE_MODE_KEY, "code");
        } else {
          localStorage.removeItem(ACTIVE_PROJECT_KEY);
          localStorage.setItem(ACTIVE_MODE_KEY, "terminal");
        }
      } catch {
        // ignore quota / private mode
      }
      return { path, mode };
    } catch {
      // fall through to localStorage snapshot below
    }
  }
  try {
    const p = localStorage.getItem(ACTIVE_PROJECT_KEY);
    const m = localStorage.getItem(ACTIVE_MODE_KEY);
    const rawPath = p && p.trim() ? p.trim() : null;
    if (m === "code" && rawPath) return { path: rawPath, mode: "code" };
  } catch {
    // ignore
  }
  return { path: null, mode: "terminal" };
}

function normalizeCodeModePath(p: string): string {
  // Unify separators, strip trailing slashes, drop Win32 verbatim prefix.
  let s = p.trim().replace(/\\/g, "/");
  s = s.replace(/^\/\/\?\/UNC\//i, "//");
  s = s.replace(/^\/\/\?\//, "");
  s = s.replace(/\/+$/, "");
  // Windows paths (C:/...) compare case-insensitively; POSIX stays exact.
  if (/^[a-zA-Z]:\//.test(s)) s = s.toLowerCase();
  return s;
}

/**
 * Normalized form of a shell-reported cwd for *comparison* only.
 *
 * The same directory arrives in different textual forms depending on the
 * reporter (OSC 7 `file://`, OSC 9;9, backend `getPtyCwd`, `\\?\`-prefixed
 * verbatim paths on Windows). Comparing raw strings treats those as a
 * directory *change*, which rewrote tab state, touched localStorage,
 * invalidated the git cache, and re-spawned `git` on nearly every prompt —
 * the footer flicker/blanking seen while typing. Compare with this instead.
 */
export function normalizeCwdForCompare(p: string): string {
  return normalizeCodeModePath(p);
}

/**
 * Cleaned cwd for *storing* in tab/pane state: drops the Win32 verbatim
 * `\\?\` prefix and trailing slashes but keeps native separators so the
 * footer displays a familiar path.
 */
export function cleanCwdForStore(p: string): string {
  let s = p.trim();
  s = s.replace(/^\\\\\?\\UNC\\/i, "\\\\");
  s = s.replace(/^\\\\\?\\/, "");
  // Never strip a filesystem root (`C:\`, `/`).
  const isRoot = /^[a-zA-Z]:[/\\]?$/.test(s) || /^[/\\]+$/.test(s);
  if (!isRoot) {
    const stripped = s.replace(/[/\\]+$/, "");
    s = stripped || s;
  }
  return s;
}

/** Shorten a home-prefixed path (`C:\Users\ann\...` → `~\...`). */
function withHomeTilde(p: string): string {
  try {
    const home =
      typeof process !== "undefined" && process.env && (process.env.HOME || process.env.USERPROFILE)
        ? String(process.env.HOME || process.env.USERPROFILE)
        : "";
    if (home) {
      const normP = p.replace(/\\/g, "/").replace(/\/+$/, "");
      const normH = home.replace(/\\/g, "/").replace(/\/+$/, "");
      const win = /^[a-zA-Z]:\//.test(normH);
      const eq = win
        ? normP.toLowerCase() === normH.toLowerCase() ||
          normP.toLowerCase().startsWith(normH.toLowerCase() + "/")
        : normP === normH || normP.startsWith(normH + "/");
      if (eq) {
        const rest = p.slice(home.length).replace(/^[/\\]+/, "");
        return rest ? `~${p.includes("\\") && !p.includes("/") ? "\\" : "/"}${rest}` : "~";
      }
    }
  } catch {
    // fall through without tilde
  }
  // Browser (no process.env): try a leading /home/<user> or /Users/<user>.
  const m = p.match(/^(\/home\/[^/\\]+|\/Users\/[^/\\]+)([/\\]|$)/);
  if (m) return `~${p.slice(m[1].length) || ""}` || "~";
  return p;
}

/**
 * Compact footer display for a full directory path: `~` for home plus a
 * middle ellipsis (`C:\…\repo\src`) when longer than `maxLen`. The full
 * path stays available via the footer's tooltip / click-to-copy — the text
 * itself must never push the git + version pills out of view.
 */
export function formatFooterPath(fullPath: string, maxLen = 48): string {
  if (!fullPath) return "";
  const s = fullPath.trim();
  // Fits as-is: show everything, never shorten a readable path.
  if (s.length <= maxLen) return s;
  // Try home-tilde first (lossless for the user: `~` is unambiguous).
  const t = withHomeTilde(s);
  if (t.length <= maxLen) return t;
  const sep = t.includes("\\") && !t.includes("/") ? "\\" : "/";
  const parts = t.split(/[/\\]/).filter(Boolean);
  if (parts.length <= 2) return "…" + t.slice(-(maxLen - 1));
  const first = parts[0] ?? "";
  const drive = /^[a-zA-Z]:$/.test(first) || first === "~" ? first : "";
  // Grow the tail (last segments) while `drive/…/tail` still fits.
  let tail = parts[parts.length - 1] ?? "";
  for (let i = parts.length - 2; i >= 1; i--) {
    const candidate = `${parts[i]}${sep}${tail}`;
    const compact = drive ? `${drive}${sep}…${sep}${candidate}` : `…${sep}${candidate}`;
    if (compact.length > maxLen) break;
    tail = candidate;
  }
  const compact = drive ? `${drive}${sep}…${sep}${tail}` : `…${sep}${tail}`;
  if (compact.length > maxLen) {
    // Last resort: hard cut with a leading ellipsis (the end stays
    // readable — the repo/project name is what matters).
    return "…" + t.slice(-(maxLen - 1));
  }
  return compact;
}

/**
 * Strips the macOS `/private` alias (`/tmp` -> `/private/tmp`): the CLI
 * canonicalizes with `realpath` (yielding `/private/...`) while shells
 * usually report the logical `$PWD` (`/...`). Applied to BOTH sides before
 * comparing, and only meaningful on macOS — a real `/private/...` dir on
 * Linux would mismatch only against an active project that is its
 * `/private`-less shadow, which cannot both exist as intended targets.
 */
function stripMacPrivateAlias(s: string): string {
  return s.replace(/^\/private\//, "/");
}

/**
 * True when `dir` is the active Code Mode project or lives inside it.
 * Returns false when there is no active project (plain terminal mode).
 * A bare prefix match is NOT enough: `/repo-demo` is not inside `/repo`.
 */
export function isCodeModeActiveForDir(dir: string, activePath: string | null): boolean {
  if (!dir || !activePath) return false;
  const d = normalizeCodeModePath(dir);
  const c = normalizeCodeModePath(activePath);
  if (!d || !c) return false;
  if (d === c || d.startsWith(`${c}/`)) return true;
  // macOS `/private` alias fallback (see stripMacPrivateAlias).
  const ds = stripMacPrivateAlias(d);
  const cs = stripMacPrivateAlias(c);
  if (ds === d && cs === c) return false;
  return ds === cs || ds.startsWith(`${cs}/`);
}

export type ModeDisplay = "code" | "terminal";

/**
 * Footer Code Mode pill state — STICKY.
 *
 * The pill follows ONLY the persisted active project: "Code Mode" while
 * `kai code <path>` has set one, "terminal" the moment it is cleared
 * (`kai stop code` / `kai stop` — must reflect at once). Reports from the
 * active pane (OSC 7 / OSC 9;9 / backend probes) never flip the badge on
 * their own: transient or still-resolving directories used to make the pill
 * flap between "Code Mode" and "Terminal" while the user was working in the
 * same tab without touching the mode. The pane directory still drives git
 * and the AI CLI panel (see `resolveEffectiveProjectDir`), just not this
 * badge.
 */
export function resolveModeDisplay(codeModeProject: string | null): ModeDisplay {
  return codeModeProject ? "code" : "terminal";
}

/** Short display name for a Code Mode project path (`…/repo` → `repo`). */
export function codeProjectName(projectPath: string | null): string {
  if (!projectPath) return "";
  const parts = projectPath.split(/[/\\]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : projectPath;
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
  // Normalized: verbatim prefixes / separators / case must not fork the
  // cache (or the footer refetches the same repo under two keys).
  const n = normalizeCwdForCompare(cwd);
  return n || cwd.trim();
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

export interface GitFileChange {
  path: string;
  status: string; // "M" | "A" | "D" | "R" | "U" | "?"
  staged: boolean;
  old_path: string | null;
}

export interface GitChangesSummary {
  repo_root: string;
  branch: string | null;
  clean: boolean;
  working_tree: GitFileChange[];
  staged: GitFileChange[];
  untracked: GitFileChange[];
  total_changes: number;
}

export async function runGitAction(
  cwd: string,
  action: "fetch" | "pull" | "status" | "diff" | "stage_all" | "unstage_all"
): Promise<string> {
  // Invalidate up front: callers invoke this precisely because the worktree
  // changed, so any cached badge is suspect even if the IPC below fails.
  invalidateGitCache(cwd);
  if (!isTauriAvailable()) {
    throw new Error("Git actions are only available inside the desktop app.");
  }
  try {
    return await invoke<string>("run_git_action_cmd", { cwd, action });
  } finally {
    // Mutating actions (fetch/pull/stage_all/unstage_all) change what the
    // next status probe reports. Status/diff are read-only but cheap to
    // refresh; invalidating unconditionally keeps the 30 s cache from ever
    // serving a stale badge after an explicit user action.
    invalidateGitCache(cwd);
  }
}

export async function getGitChanges(cwd: string): Promise<GitChangesSummary> {
  if (!isTauriAvailable()) {
    throw new Error("Git actions are only available inside the desktop app.");
  }
  return await invoke<GitChangesSummary>("get_git_changes_cmd", { cwd });
}

export async function getGitDiff(
  cwd: string,
  path?: string,
  staged: boolean = false
): Promise<string> {
  if (!isTauriAvailable()) {
    throw new Error("Git actions are only available inside the desktop app.");
  }
  return await invoke<string>("get_git_diff_cmd", { cwd, path: path ?? null, staged });
}

export async function stageGitFile(cwd: string, path: string): Promise<string> {
  invalidateGitCache(cwd);
  if (!isTauriAvailable()) {
    throw new Error("Git actions are only available inside the desktop app.");
  }
  try {
    return await invoke<string>("stage_git_file_cmd", { cwd, path });
  } finally {
    invalidateGitCache(cwd);
  }
}

export async function unstageGitFile(cwd: string, path: string): Promise<string> {
  invalidateGitCache(cwd);
  if (!isTauriAvailable()) {
    throw new Error("Git actions are only available inside the desktop app.");
  }
  try {
    return await invoke<string>("unstage_git_file_cmd", { cwd, path });
  } finally {
    invalidateGitCache(cwd);
  }
}

export async function discardGitFile(cwd: string, path: string): Promise<string> {
  invalidateGitCache(cwd);
  if (!isTauriAvailable()) {
    throw new Error("Git actions are only available inside the desktop app.");
  }
  try {
    return await invoke<string>("discard_git_file_cmd", { cwd, path });
  } finally {
    invalidateGitCache(cwd);
  }
}
