import { isTauriAvailable } from "./ptyService";

/**
 * Detached "picture-in-picture" music window.
 *
 * The main window keeps ALL player logic (queue, history, favorites, keyboard
 * shortcuts). While the picture-in-picture window is open it only hosts the
 * YouTube iframe plus a small control strip, and the two talk over Tauri
 * events:
 *
 *   main -> pip   `state`    what to show (embed src, title, playing, time...)
 *   main -> pip   `command`  a ready-made YouTube postMessage command string
 *   pip  -> main  `ready`    the pip window finished loading; send `state`
 *   pip  -> main  `message`  a raw telemetry message from the YouTube iframe
 *   pip  -> main  `action`   a button press (play, next, seek...)
 *   rust -> all   `closed`   the pip window is gone, however it was closed
 */
export const PIP_EVENTS = {
  state: "kai-pip:state",
  command: "kai-pip:command",
  ready: "kai-pip:ready",
  message: "kai-pip:message",
  action: "kai-pip:action",
  closed: "kai-pip:closed",
} as const;

/** What the picture-in-picture window renders. Sent whole on every change. */
export interface PipState {
  /** Embed URL to load, or null when nothing is playing. */
  src: string | null;
  title: string | null;
  playing: boolean;
  /** YouTube is waiting for data: hold the progress bar at the last report. */
  buffering?: boolean;
  muted: boolean;
  /** 0-100, applied to the embed when it loads. */
  volume: number;
  currentTime: number;
  duration: number;
  /** 0.15-1: the player's Dim Opacity (1 when dimming is off). */
  opacity: number;
}

export const EMPTY_PIP_STATE: PipState = {
  src: null,
  title: null,
  playing: false,
  buffering: false,
  muted: false,
  volume: 75,
  currentTime: 0,
  duration: 0,
  opacity: 1,
};

/** A button press in the picture-in-picture window, executed by the main window. */
export type PipAction =
  | { name: "toggle-play" | "next" | "previous" | "mute" | "restore" }
  | { name: "seek"; value: number };

/** Broadcasts a Tauri event. Silent no-op outside the desktop app. */
export async function emitPip(event: string, payload?: unknown): Promise<void> {
  if (!isTauriAvailable()) return;
  try {
    const { emit } = await import("@tauri-apps/api/event");
    await emit(event, payload);
  } catch {
    // The other window may already be gone; nothing to tell.
  }
}

/** Subscribes to a Tauri event; resolves to its unsubscribe function. */
export async function listenPip<T>(
  event: string,
  handler: (payload: T) => void
): Promise<() => void> {
  if (!isTauriAvailable()) return () => {};
  try {
    const { listen } = await import("@tauri-apps/api/event");
    return await listen<T>(event, (e) => handler(e.payload));
  } catch {
    return () => {};
  }
}

/** Opens (or raises) the picture-in-picture window. False when it could not open. */
export async function openMusicPip(): Promise<boolean> {
  if (!isTauriAvailable()) return false;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const saved = loadPipPosition();
    const size = loadPipSize();
    await invoke("open_music_pip", {
      x: saved?.x ?? null,
      y: saved?.y ?? null,
      width: size?.width ?? null,
      height: size?.height ?? null,
    });
    return true;
  } catch (err) {
    console.warn("Failed to open the music picture-in-picture window:", err);
    return false;
  }
}

/** Closes the picture-in-picture window; `focusMain` also raises the main window. */
export async function closeMusicPip(focusMain = false): Promise<void> {
  if (!isTauriAvailable()) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("close_music_pip", { focusMain });
  } catch (err) {
    console.warn("Failed to close the music picture-in-picture window:", err);
  }
}

/** True when this page was opened as the picture-in-picture window. */
export function isMusicPipWindow(): boolean {
  try {
    return new URLSearchParams(window.location.search).get("pip") === "music";
  } catch {
    return false;
  }
}

const PIP_POSITION_KEY = "kai_music_pip_position";

/** Where the user last dropped the mini window (logical pixels), if anywhere. */
export function loadPipPosition(): { x: number; y: number } | null {
  try {
    const raw = localStorage.getItem(PIP_POSITION_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as { x?: unknown; y?: unknown };
    if (typeof p.x === "number" && typeof p.y === "number" && Number.isFinite(p.x + p.y)) {
      return { x: p.x, y: p.y };
    }
  } catch {
    // Unreadable: fall back to the default corner.
  }
  return null;
}

/** Remembers the mini window's position so it reopens where it was dropped. */
export function savePipPosition(x: number, y: number): void {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  try {
    localStorage.setItem(PIP_POSITION_KEY, JSON.stringify({ x: Math.round(x), y: Math.round(y) }));
  } catch {
    // Storage unavailable: it just opens in the default corner next time.
  }
}

/** Opacity the mini window shows for the player's Dim setting (1 = off). */
export function pipOpacity(dimmed: boolean, dimPercent: number): number {
  if (!dimmed || !Number.isFinite(dimPercent)) return 1;
  return Math.max(0.15, Math.min(1, dimPercent / 100));
}

const PIP_SIZE_KEY = "kai_music_pip_size";

/** Smallest mini window the native side allows (logical pixels). */
export const PIP_MIN_SIZE = { width: 240, height: 150 } as const;

/** The mini window's last size (logical pixels), if it was ever resized. */
export function loadPipSize(): { width: number; height: number } | null {
  try {
    const raw = localStorage.getItem(PIP_SIZE_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as { width?: unknown; height?: unknown };
    if (
      typeof p.width === "number" &&
      typeof p.height === "number" &&
      Number.isFinite(p.width + p.height) &&
      p.width >= PIP_MIN_SIZE.width &&
      p.height >= PIP_MIN_SIZE.height
    ) {
      return { width: p.width, height: p.height };
    }
  } catch {
    // Unreadable: open at the default size.
  }
  return null;
}

/** Remembers the mini window's size (logical pixels) so it reopens at it. */
export function savePipSize(width: number, height: number): void {
  if (!Number.isFinite(width) || !Number.isFinite(height)) return;
  if (width < PIP_MIN_SIZE.width || height < PIP_MIN_SIZE.height) return;
  try {
    localStorage.setItem(
      PIP_SIZE_KEY,
      JSON.stringify({ width: Math.round(width), height: Math.round(height) })
    );
  } catch {
    // Storage unavailable: it just opens at the default size next time.
  }
}
