/**
 * Versioned local workspace persistence with safe migration.
 *
 * - v1 legacy: `terminal_tab_layout_v1` = [{title, shellPath?, cwd?}] (titles + cwd only).
 * - v2: `terminal_workspaces_v1` = {version: 2, workspaces: Workspace[]} where each
 *   workspace holds named sessions (tabs) with per-tab cwd/shellPath/panes.
 *
 * Security: never persists scrollback, command history, env values, or
 * credentials. Only titles, shell paths, working directories, and pane
 * structure. Restoring never executes old commands.
 */

export interface PersistedPaneV2 {
  shellPath?: string;
  cwd?: string;
}

export interface PersistedTabV2 {
  title: string;
  shellPath?: string;
  cwd?: string;
  splitDirection?: "none" | "horizontal" | "vertical";
  panes?: PersistedPaneV2[];
}

export interface Workspace {
  id: string;
  name: string;
  tabs: PersistedTabV2[];
  createdAt: number;
  updatedAt: number;
}

interface WorkspacesDoc {
  version: 2;
  workspaces: Workspace[];
}

export const WORKSPACES_KEY = "kai_workspaces_v1";
export const LEGACY_WORKSPACES_KEY = "terminal_workspaces_v1";
export const LEGACY_LAYOUT_KEY = "terminal_tab_layout_v1";
const MAX_WORKSPACES = 20;
const MAX_TABS_PER_WORKSPACE = 10;
const MAX_PANES = 4;

function safeTitle(t: unknown): string {
  return typeof t === "string" && t.trim() ? t.slice(0, 80) : "Terminal";
}

function safeOptPath(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  if (!t || t.includes("\0") || t.length > 4096) return undefined;
  return t;
}

export function sanitizeTab(raw: unknown): PersistedTabV2 | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const panesRaw = Array.isArray(r.panes) ? r.panes.slice(0, MAX_PANES) : [];
  const panes: PersistedPaneV2[] | undefined =
    panesRaw.length > 0
      ? panesRaw
          .map((p) => {
            if (typeof p !== "object" || p === null) return null;
            const pr = p as Record<string, unknown>;
            const pane: PersistedPaneV2 = {};
            const sp = safeOptPath(pr.shellPath);
            const cw = safeOptPath(pr.cwd);
            if (sp) pane.shellPath = sp;
            if (cw) pane.cwd = cw;
            return pane;
          })
          .filter((p): p is PersistedPaneV2 => p !== null)
      : undefined;
  const sd = r.splitDirection;
  const splitDirection =
    sd === "horizontal" || sd === "vertical" ? sd : panes && panes.length > 1 ? "vertical" : "none";
  return {
    title: safeTitle(r.title),
    shellPath: safeOptPath(r.shellPath),
    cwd: safeOptPath(r.cwd),
    splitDirection,
    ...(panes ? { panes } : {}),
  };
}

/** Validate a working directory string shape; existence is checked at launch by the backend. */
export function validateWorkspaceDir(dir: string): string | null {
  const t = dir.trim();
  if (!t) return "Directory must not be empty.";
  if (t.includes("\0")) return "Directory contains an invalid character.";
  if (t.length > 4096) return "Directory path is too long.";
  return null;
}

export function sanitizeWorkspace(raw: unknown): Workspace | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const name = typeof r.name === "string" && r.name.trim() ? r.name.slice(0, 80) : null;
  if (!name) return null;
  const tabs = Array.isArray(r.tabs)
    ? r.tabs
        .map(sanitizeTab)
        .filter((t): t is PersistedTabV2 => t !== null)
        .slice(0, MAX_TABS_PER_WORKSPACE)
    : [];
  const now = Date.now();
  return {
    id: typeof r.id === "string" && r.id ? r.id.slice(0, 64) : `ws-${now}`,
    name,
    tabs,
    createdAt: typeof r.createdAt === "number" ? r.createdAt : now,
    updatedAt: typeof r.updatedAt === "number" ? r.updatedAt : now,
  };
}

function readLS(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLS(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // ignore quota errors
  }
}

export function loadWorkspaces(): Workspace[] {
  try {
    const raw = readLS(WORKSPACES_KEY) || readLS(LEGACY_WORKSPACES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as WorkspacesDoc | Workspace[];
    const list = Array.isArray(parsed) ? parsed : parsed.workspaces;
    if (!Array.isArray(list)) return [];
    return list
      .map(sanitizeWorkspace)
      .filter((w): w is Workspace => w !== null)
      .slice(0, MAX_WORKSPACES);
  } catch {
    return [];
  }
}

export function saveWorkspaces(workspaces: Workspace[]): void {
  const safe = workspaces
    .map(sanitizeWorkspace)
    .filter((w): w is Workspace => w !== null)
    .slice(0, MAX_WORKSPACES);
  writeLS(WORKSPACES_KEY, JSON.stringify({ version: 2, workspaces: safe }));
}

/** Migrate legacy v1 tab layout into a single "Restored session" workspace. Returns null when nothing to migrate. */
export function migrateLegacyLayout(rawLegacy: unknown): Workspace | null {
  if (!Array.isArray(rawLegacy) || rawLegacy.length === 0) return null;
  const tabs = rawLegacy
    .map(sanitizeTab)
    .filter((t): t is PersistedTabV2 => t !== null)
    .slice(0, MAX_TABS_PER_WORKSPACE);
  if (tabs.length === 0) return null;
  const now = Date.now();
  return {
    id: `ws-migrated-${now}`,
    name: "Restored session",
    tabs,
    createdAt: now,
    updatedAt: now,
  };
}

/** Load workspaces, migrating legacy layout once when no v2 doc exists. */
export function loadOrMigrateWorkspaces(): Workspace[] {
  const existing = loadWorkspaces();
  if (existing.length > 0) return existing;
  try {
    const legacyRaw = readLS(LEGACY_LAYOUT_KEY);
    if (!legacyRaw) return [];
    const parsed = JSON.parse(legacyRaw);
    const migrated = migrateLegacyLayout(parsed);
    if (!migrated) return [];
    saveWorkspaces([migrated]);
    return [migrated];
  } catch {
    return [];
  }
}

export function createWorkspace(name: string, tabs: PersistedTabV2[] = []): Workspace {
  const now = Date.now();
  return {
    id: `ws-${now}-${Math.floor(Math.random() * 0xffffffff).toString(16)}`,
    name: name.trim().slice(0, 80) || "Workspace",
    tabs: tabs
      .map(sanitizeTab)
      .filter((t): t is PersistedTabV2 => t !== null)
      .slice(0, MAX_TABS_PER_WORKSPACE),
    createdAt: now,
    updatedAt: now,
  };
}

export function renameWorkspace(workspaces: Workspace[], id: string, name: string): Workspace[] {
  const clean = name.trim().slice(0, 80);
  if (!clean) return workspaces;
  return workspaces.map((w) => (w.id === id ? { ...w, name: clean, updatedAt: Date.now() } : w));
}

export function deleteWorkspace(workspaces: Workspace[], id: string): Workspace[] {
  return workspaces.filter((w) => w.id !== id);
}
