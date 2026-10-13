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

import type { PaneLayoutNode } from "../types/terminal";

export interface PersistedPaneV2 {
  shellPath?: string;
  cwd?: string;
}

export interface PersistedSplitV2 {
  id?: string;
  direction: "horizontal" | "vertical";
  ratio?: number;
  first: PersistedLayoutV2;
  second: PersistedLayoutV2;
}

export type PersistedLayoutV2 =
  { kind: "pane"; paneId?: string; paneIndex?: number } | ({ kind: "split" } & PersistedSplitV2);

export interface PersistedTabV2 {
  title: string;
  /** Optional tab accent color (hex). Never executable content. */
  color?: string;
  shellPath?: string;
  cwd?: string;
  splitDirection?: "none" | "horizontal" | "vertical";
  panes?: PersistedPaneV2[];
  /** Nested split tree (ids + ratios). Pane refs stored as indexes. */
  layout?: PersistedLayoutV2;
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

function safeColor(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim().toLowerCase();
  if (/^#[0-9a-f]{3}$/.test(t) || /^#[0-9a-f]{6}$/.test(t)) return t;
  return undefined;
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
  const layout = sanitizeLayout(r.layout, panes?.length ?? 1);
  return {
    title: safeTitle(r.title),
    color: safeColor(r.color),
    shellPath: safeOptPath(r.shellPath),
    cwd: safeOptPath(r.cwd),
    splitDirection,
    ...(panes ? { panes } : {}),
    ...(layout ? { layout } : {}),
  };
}

function clampRatio(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.min(0.8, Math.max(0.2, v)) : 0.5;
}

function safeSplitId(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim().slice(0, 64);
  return t ? t : undefined;
}

/** Validate a persisted nested layout tree (pane refs as indexes). */
export function sanitizeLayout(raw: unknown, paneCount: number): PersistedLayoutV2 | undefined {
  const depthGuard = (node: unknown, depth: number): PersistedLayoutV2 | null => {
    if (depth > 8 || typeof node !== "object" || node === null) return null;
    const n = node as Record<string, unknown>;
    if (n.kind === "pane") {
      const idx = typeof n.paneIndex === "number" ? Math.floor(n.paneIndex) : 0;
      if (!Number.isFinite(idx) || idx < 0 || idx >= Math.max(1, paneCount)) return null;
      return { kind: "pane", paneIndex: idx };
    }
    if (n.kind === "split") {
      if (n.direction !== "horizontal" && n.direction !== "vertical") return null;
      const first = depthGuard(n.first, depth + 1);
      const second = depthGuard(n.second, depth + 1);
      if (!first || !second) return null;
      const out: PersistedLayoutV2 = {
        kind: "split",
        direction: n.direction,
        ratio: clampRatio(n.ratio),
        first,
        second,
      };
      const id = safeSplitId(n.id);
      if (id) (out as PersistedSplitV2).id = id;
      return out;
    }
    return null;
  };
  if (raw === undefined) return undefined;
  const clean = depthGuard(raw, 0);
  return clean ?? undefined;
}

/**
 * Convert a sanitized persisted layout (index refs) into a live tree with
 * real pane ids. Returns undefined when refs are stale so callers fall back
 * to the legacy flat layout.
 */
export function persistedLayoutToNode(
  layout: PersistedLayoutV2 | undefined,
  paneIds: string[]
): PaneLayoutNode | undefined {
  if (!layout) return undefined;
  const build = (node: PersistedLayoutV2): PaneLayoutNode | null => {
    if (node.kind === "pane") {
      const idx = node.paneIndex ?? 0;
      const id = paneIds[idx];
      return id ? { kind: "pane", paneId: id } : null;
    }
    const first = build(node.first);
    const second = build(node.second);
    if (!first || !second) return null;
    return {
      kind: "split",
      id: node.id || `restored-${Math.floor(Math.random() * 0xffffffff).toString(16)}`,
      direction: node.direction,
      ratio: clampRatio(node.ratio ?? 0.5),
      first,
      second,
    };
  };
  return build(layout) ?? undefined;
}

/** Convert a live tree into a persistable tree (pane ids -> indexes). */
export function nodeToPersistedLayout(node: PaneLayoutNode, paneIds: string[]): PersistedLayoutV2 {
  if (node.kind === "pane") {
    const idx = Math.max(0, paneIds.indexOf(node.paneId));
    return { kind: "pane", paneIndex: idx };
  }
  return {
    kind: "split",
    id: node.id,
    direction: node.direction,
    ratio: clampRatio(node.ratio),
    first: nodeToPersistedLayout(node.first, paneIds),
    second: nodeToPersistedLayout(node.second, paneIds),
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

/**
 * Sanitize one workspace for restoration: drops tabs that fail validation
 * and clears un-restorable cwd values (backend falls back to HOME) instead
 * of spawning into a bad path. Never throws; returns the workspace with
 * only restorable tabs.
 */
export function sanitizeWorkspaceForRestore(ws: Workspace): Workspace {
  const tabs = ws.tabs
    .map(sanitizeTab)
    .filter((t): t is PersistedTabV2 => t !== null)
    .map((t) => {
      if (t.cwd && validateWorkspaceDir(t.cwd)) {
        const { cwd: _dropped, ...rest } = t;
        return rest;
      }
      if (t.panes) {
        const panes = t.panes.map((p) => {
          if (p.cwd && validateWorkspaceDir(p.cwd)) {
            const { cwd: _dropped, ...prest } = p;
            return prest;
          }
          return p;
        });
        return { ...t, panes };
      }
      return t;
    });
  return { ...ws, tabs, updatedAt: Date.now() };
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
