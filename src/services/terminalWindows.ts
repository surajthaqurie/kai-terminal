/**
 * Several terminal windows in one app (see `src-tauri/src/terminal_windows.rs`).
 *
 * The first window is `main`; others are opened with `?window=terminal` and are
 * "secondary": they share the one process, so things that must stay single (the
 * saved layout, the music player, update checks) belong to `main` only.
 */
import { isTauriAvailable } from "./ptyService";
import type { PaneAdoption, PaneLayoutNode, SplitDirection } from "../types/terminal";
import type { WindowRestoreSeed } from "./windowLayouts";

/** True in a terminal window that was opened from another one (not the first). */
export function isSecondaryTerminalWindow(): boolean {
  try {
    return new URLSearchParams(window.location.search).get("window") === "terminal";
  } catch {
    return false;
  }
}

/** One pane of a tab being moved to a new window. */
export interface PaneSeed {
  id: string;
  shellPath?: string;
  cwd?: string;
  /** Present when the pane's shell is still running and moves with the tab. */
  adopt?: PaneAdoption;
}

/** A tab handed to a new window, enough to rebuild it exactly (layout included). */
export interface TabSeed {
  title: string;
  color?: string;
  shellPath?: string;
  cwd?: string;
  splitDirection: SplitDirection;
  layout?: PaneLayoutNode;
  activePaneId: string;
  panes: PaneSeed[];
}

/** What a new window starts with: a tab moved from another window, or a saved window's tabs. */
export type WindowSeed = TabSeed | WindowRestoreSeed;

/** What a session printed, and whether it ended, while it was being moved. */
export interface HandoffRelease {
  data: string[];
  exited: boolean;
  exit_code: number | null;
}

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(command, args);
}

/**
 * Opens another terminal window and returns its label. `seed` is the tab it
 * shows, `adopt` the running sessions that move into it, `at` where to put it
 * (screen pixels). Rejects outside the desktop app.
 */
export async function openTerminalWindow(opts?: {
  seed?: WindowSeed;
  adopt?: string[];
  at?: { x: number; y: number };
}): Promise<string> {
  if (!isTauriAvailable()) throw new Error("Extra windows need the desktop app.");
  return call<string>("open_terminal_window", {
    seed: opts?.seed ?? null,
    adopt: opts?.adopt ?? [],
    x: opts?.at?.x ?? null,
    y: opts?.at?.y ?? null,
  });
}

/** What this window was opened to show (once), or null for a plain new window. */
export async function takeWindowSeed(): Promise<WindowSeed | null> {
  if (!isTauriAvailable()) return null;
  try {
    return (await call<WindowSeed | null>("take_window_seed")) ?? null;
  } catch (err) {
    console.warn("Could not read the tab for this window:", err);
    return null;
  }
}

/** Starts holding back these sessions' output while their tab moves windows. */
export async function handoffBegin(ids: string[]): Promise<void> {
  if (!isTauriAvailable() || ids.length === 0) return;
  await call<void>("pty_handoff_begin", { ids });
}

/** Ends the hold and returns what the session printed meanwhile. */
export async function handoffFinish(id: string): Promise<HandoffRelease> {
  if (!isTauriAvailable()) return { data: [], exited: false, exit_code: null };
  return call<HandoffRelease>("pty_handoff_finish", { id });
}

/** The other terminal window under a screen point (logical pixels), or null. */
export async function terminalWindowAt(x: number, y: number): Promise<string | null> {
  if (!isTauriAvailable()) return null;
  try {
    return (await call<string | null>("terminal_window_at", { x, y })) ?? null;
  } catch (err) {
    console.warn("Could not find the window under the pointer:", err);
    return null;
  }
}

/**
 * Hands a tab to another open terminal window (merging it back). `adopt` lists the running
 * sessions that move with it. Rejects when the target is gone.
 */
export async function sendTabToWindow(
  target: string,
  seed: TabSeed,
  adopt: string[]
): Promise<void> {
  if (!isTauriAvailable()) throw new Error("Extra windows need the desktop app.");
  await call<void>("send_tab_to_window", { target, seed, adopt });
}

/** Tabs other windows handed to this one since it last asked, oldest first. */
export async function takeIncomingTabs(): Promise<TabSeed[]> {
  if (!isTauriAvailable()) return [];
  try {
    return (await call<TabSeed[]>("take_incoming_tabs")) ?? [];
  } catch (err) {
    console.warn("Could not read the tabs moved to this window:", err);
    return [];
  }
}

/** Asks every other terminal window to move its tabs into this one. Returns how many were asked. */
export async function mergeTerminalWindows(): Promise<number> {
  if (!isTauriAvailable()) return 0;
  return call<number>("merge_terminal_windows");
}

/** A name for a terminal window in menus: "Main window", "Window 3". */
export function terminalWindowName(label: string): string {
  if (label === "main") return "Main window";
  const n = /^term-(\d+)$/.exec(label)?.[1];
  return n ? `Window ${n}` : label;
}
