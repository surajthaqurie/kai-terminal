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
  muted: boolean;
  /** 0-100, applied to the embed when it loads. */
  volume: number;
  currentTime: number;
  duration: number;
}

export const EMPTY_PIP_STATE: PipState = {
  src: null,
  title: null,
  playing: false,
  muted: false,
  volume: 75,
  currentTime: 0,
  duration: 0,
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
    await invoke("open_music_pip");
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
