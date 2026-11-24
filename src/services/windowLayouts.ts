/**
 * Saved layouts of the terminal windows other than `main` (FUNC-07).
 *
 * The main window keeps its layout under LAYOUT_KEY (tabFactory.ts). Every other terminal window
 * (`term-N`: opened with New window, or a tab dragged out) saves its tabs here under its label,
 * with the same safety rules: titles, colour, folder, shell and pane structure, never history.
 *
 * What the next launch offers: the windows that were open when the app last quit. A window the
 * user closed while others stayed open forgets its entry (see `closeAppWindow`), and at startup
 * a saved window counts as "previous" when no live window has its label: at a real launch only
 * `main` is open, while after a reload of the main page the other windows are still live and
 * keep their entries.
 */
import { isTauriAvailable } from "./ptyService";
import { sanitizePersistedTabs, toPersistedTabs, type PersistedTab } from "./tabFactory";
import type { TerminalTab } from "../types/terminal";

export const EXTRA_WINDOWS_KEY = "terminal_extra_windows_v1";
/** Most other windows remembered, and reopened, at once. */
export const MAX_SAVED_WINDOWS = 8;

export interface SavedWindowLayout {
  label: string;
  tabs: PersistedTab[];
  /** Position of the tab that was in front, or null when unknown. */
  activeIndex: number | null;
  /** When the window last saved (ms since epoch). */
  savedAt: number;
}

/** The seed a window is opened with to show a saved window's tabs. */
export interface WindowRestoreSeed {
  restore: { tabs: PersistedTab[]; activeIndex: number | null };
}

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function defaultStore(): Store | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** `main` or `term-N`, as in src-tauri/src/terminal_windows.rs `is_terminal_label`. */
export function isTerminalWindowLabel(label: string): boolean {
  return label === "main" || /^term-\d+$/.test(label);
}

const isExtraLabel = (label: string) => label !== "main" && isTerminalWindowLabel(label);

function validIndex(value: unknown, length: number): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value < length
    ? value
    : null;
}

function readAll(store: Store): Record<string, SavedWindowLayout> {
  const out: Record<string, SavedWindowLayout> = {};
  try {
    const raw = store.getItem(EXTRA_WINDOWS_KEY);
    if (!raw) return out;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return out;
    for (const [label, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!isExtraLabel(label) || typeof value !== "object" || value === null) continue;
      const v = value as Record<string, unknown>;
      const tabs = sanitizePersistedTabs(v.tabs);
      if (tabs.length === 0) continue;
      const savedAt = typeof v.savedAt === "number" && Number.isFinite(v.savedAt) ? v.savedAt : 0;
      out[label] = { label, tabs, activeIndex: validIndex(v.activeIndex, tabs.length), savedAt };
    }
  } catch {
    // Corrupt or unreadable: treated as nothing saved.
  }
  return out;
}

function writeAll(store: Store, all: Record<string, SavedWindowLayout>): void {
  try {
    if (Object.keys(all).length === 0) store.removeItem(EXTRA_WINDOWS_KEY);
    else store.setItem(EXTRA_WINDOWS_KEY, JSON.stringify(all));
  } catch {
    // Quota or storage unavailable: the layout is simply not remembered.
  }
}

/** Saves the tabs of the window `label` (not `main`, which has its own key). */
export function saveWindowLayout(
  label: string,
  tabs: TerminalTab[],
  activeTabId: string | undefined,
  store: Store | null = defaultStore(),
  now: number = Date.now()
): void {
  if (!store || !isExtraLabel(label)) return;
  const all = readAll(store);
  const persisted = toPersistedTabs(tabs);
  if (persisted.length === 0) {
    delete all[label];
  } else {
    const index = tabs.findIndex((t) => t.id === activeTabId);
    all[label] = {
      label,
      tabs: persisted,
      activeIndex: validIndex(index, persisted.length),
      savedAt: now,
    };
  }
  writeAll(store, all);
}

/** The window `label` was closed on purpose: it is not part of the next session. */
export function forgetWindowLayout(label: string, store: Store | null = defaultStore()): void {
  if (!store) return;
  const all = readAll(store);
  if (!(label in all)) return;
  delete all[label];
  writeAll(store, all);
}

/** Saved windows not open now (newest first): what was open when the app last quit. */
export function previousWindows(
  liveLabels: readonly string[],
  store: Store | null = defaultStore()
): SavedWindowLayout[] {
  if (!store) return [];
  const live = new Set(liveLabels);
  return Object.values(readAll(store))
    .filter((w) => !live.has(w.label))
    .sort((a, b) => b.savedAt - a.savedAt)
    .slice(0, MAX_SAVED_WINDOWS);
}

/**
 * Drops the previous session's windows once they were offered (loaded, dismissed, or superseded
 * by new work). Only entries saved before `before` go: a window of this run that reused one of
 * those labels has saved since and keeps its entry.
 */
export function clearPreviousWindows(
  labels: readonly string[],
  before: number,
  store: Store | null = defaultStore()
): void {
  if (!store || labels.length === 0) return;
  const all = readAll(store);
  let changed = false;
  for (const label of labels) {
    if (all[label] && all[label].savedAt < before) {
      delete all[label];
      changed = true;
    }
  }
  if (changed) writeAll(store, all);
}

export function restoreSeedOf(w: SavedWindowLayout): WindowRestoreSeed {
  return { restore: { tabs: w.tabs, activeIndex: w.activeIndex } };
}

export function isRestoreSeed(seed: unknown): seed is WindowRestoreSeed {
  if (typeof seed !== "object" || seed === null) return false;
  const restore = (seed as { restore?: unknown }).restore;
  return (
    typeof restore === "object" &&
    restore !== null &&
    Array.isArray((restore as { tabs?: unknown }).tabs)
  );
}

/** Labels of the terminal windows open now, or null when that cannot be known. */
export async function liveTerminalWindowLabels(): Promise<string[] | null> {
  if (!isTauriAvailable()) return null;
  try {
    const { getAllWindows } = await import("@tauri-apps/api/window");
    return (await getAllWindows()).map((w) => w.label).filter(isTerminalWindowLabel);
  } catch {
    return null;
  }
}

/** This window's label, or null outside the desktop app. */
export async function currentWindowLabel(): Promise<string | null> {
  if (!isTauriAvailable()) return null;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    return getCurrentWindow().label;
  } catch {
    return null;
  }
}
