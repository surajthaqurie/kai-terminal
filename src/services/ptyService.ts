import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  ShellProfile,
  PtyCreateOptions,
  PtySessionInfo,
  PtyOutputPayload,
  PtyExitPayload,
  UnlistenFn,
} from "../types/terminal";
import { createPtyWriteQueue } from "./ptyWriteQueue";

/**
 * One Tauri listener per PTY event, shared by every pane. Each `listen` is a
 * separate registration the backend dispatches to on every event, so with N
 * panes each output chunk of ANY terminal was delivered N times across the
 * IPC bridge. Now it crosses once and fans out in JS. The Tauri listener is
 * registered on the first subscriber and removed with the last.
 */
function sharedTauriEvent<T>(name: string) {
  const subscribers = new Set<(payload: T) => void>();
  let registration: Promise<UnlistenFn> | null = null;
  return async (callback: (payload: T) => void): Promise<UnlistenFn> => {
    subscribers.add(callback);
    if (!registration) {
      registration = listen<T>(name, (event) => {
        for (const fn of subscribers) {
          try {
            fn(event.payload);
          } catch (err) {
            console.error(`[pty] ${name} handler failed:`, err);
          }
        }
      });
      registration.catch(() => {
        registration = null;
      });
    }
    try {
      await registration;
    } catch (err) {
      subscribers.delete(callback);
      throw err;
    }
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      subscribers.delete(callback);
      if (subscribers.size === 0 && registration) {
        const pending = registration;
        registration = null;
        void pending.then((unlisten) => unlisten()).catch(() => {});
      }
    };
  };
}

const subscribePtyOutput = sharedTauriEvent<PtyOutputPayload>("pty-output");
const subscribePtyExit = sharedTauriEvent<PtyExitPayload>("pty-exit");
const subscribePtyCwd = sharedTauriEvent<{ id: string; cwd: string }>("pty-cwd");

const queuedPtyWrite = createPtyWriteQueue((id, data) =>
  invoke<void>("write_to_pty", { id, data })
);

/**
 * Interface definition for PTY service operations.
 * Allows decoupling Tauri native IPC implementation from mock/testing adapters.
 */
export interface IPtyService {
  getAvailableShells(): Promise<ShellProfile[]>;
  createPty(options: PtyCreateOptions): Promise<PtySessionInfo>;
  writeToPty(id: string, data: string): Promise<void>;
  resizePty(id: string, cols: number, rows: number): Promise<void>;
  closePty(id: string): Promise<void>;
  getPtyCwd(id: string): Promise<string | null>;
  onPtyOutput(callback: (payload: PtyOutputPayload) => void): Promise<UnlistenFn>;
  onPtyExit(callback: (payload: PtyExitPayload) => void): Promise<UnlistenFn>;
  onPtyCwd(callback: (payload: { id: string; cwd: string }) => void): Promise<UnlistenFn>;
}

/**
 * Helper to check if running inside a Tauri application window.
 */
export const isTauriAvailable = (): boolean => {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
};

/**
 * Production PTY service implementation with web mock fallback.
 */
class PtyServiceImpl implements IPtyService {
  async getAvailableShells(): Promise<ShellProfile[]> {
    return PtyServiceImpl.getAvailableShells();
  }

  async createPty(options: PtyCreateOptions): Promise<PtySessionInfo> {
    return PtyServiceImpl.createPty(options);
  }

  async writeToPty(id: string, data: string): Promise<void> {
    return PtyServiceImpl.writeToPty(id, data);
  }

  async resizePty(id: string, cols: number, rows: number): Promise<void> {
    return PtyServiceImpl.resizePty(id, cols, rows);
  }

  async closePty(id: string): Promise<void> {
    return PtyServiceImpl.closePty(id);
  }

  async getPtyCwd(id: string): Promise<string | null> {
    return PtyServiceImpl.getPtyCwd(id);
  }

  async onPtyOutput(callback: (payload: PtyOutputPayload) => void): Promise<UnlistenFn> {
    return PtyServiceImpl.onPtyOutput(callback);
  }

  async onPtyExit(callback: (payload: PtyExitPayload) => void): Promise<UnlistenFn> {
    return PtyServiceImpl.onPtyExit(callback);
  }

  async onPtyCwd(callback: (payload: { id: string; cwd: string }) => void): Promise<UnlistenFn> {
    return PtyServiceImpl.onPtyCwd(callback);
  }

  // --- Static interface implementation ---

  static async getAvailableShells(): Promise<ShellProfile[]> {
    if (!isTauriAvailable()) {
      return [
        {
          id: "bash",
          name: "Bash (Mock)",
          path: "/bin/bash",
          is_default: true,
        },
        { id: "zsh", name: "Zsh (Mock)", path: "/bin/zsh", is_default: false },
      ];
    }
    return await invoke<ShellProfile[]>("get_available_shells");
  }

  static async createPty(options: PtyCreateOptions): Promise<PtySessionInfo> {
    if (!isTauriAvailable()) {
      return {
        id: "mock-session-1",
        shell_path: options.shell_path || "/bin/bash",
        cwd: options.cwd || "/",
        cols: options.cols,
        rows: options.rows,
      };
    }
    // 20 s launch timeout so a wedged backend never leaves the UI stuck on
    // "Initializing…" forever; callers surface the error instead.
    // If the backend spawn still succeeds after our timeout, its session id
    // would otherwise leak (hidden shell + reader/waiter threads forever),
    // so reap the late arrival when it lands.
    const pending = invoke<PtySessionInfo>("create_pty", { options });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("PTY launch timed out after 20s")), 20000);
    });
    try {
      return await Promise.race([pending, timeout]);
    } catch (err) {
      void pending.then(
        (info) => {
          if (info && info.id) {
            PtyService.closePty(info.id).catch(() => {});
          }
        },
        () => {}
      );
      throw err;
    } finally {
      // Don't leave a 20 s timer (and its closure) alive per spawned pane.
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /**
   * Writes go through a per-terminal queue that splits payloads into
   * sub-1 MB chunks (the backend's per-call bound) and sends them in order,
   * awaiting each invoke, so large pastes are delivered instead of rejected.
   */
  static async writeToPty(id: string, data: string): Promise<void> {
    if (!isTauriAvailable()) return;
    await queuedPtyWrite(id, data);
  }

  static async resizePty(id: string, cols: number, rows: number): Promise<void> {
    if (!isTauriAvailable()) return;
    await invoke<void>("resize_pty", { id, cols, rows });
  }

  static async closePty(id: string): Promise<void> {
    if (!isTauriAvailable()) return;
    await invoke<void>("close_pty", { id });
  }

  /**
   * Tells the backend that `bytes` of session `id`'s output have been handed to the
   * terminal emulator, so it may let the shell write more (output flow control).
   * Fire and forget: the backend recovers a lost acknowledgement.
   */
  static async ackOutput(id: string, bytes: number): Promise<void> {
    if (!isTauriAvailable() || !(bytes > 0)) return;
    try {
      await invoke<void>("pty_ack", { id, bytes: Math.floor(bytes) });
    } catch {
      // Session already closed (late acknowledgement) or backend gone: nothing to do.
    }
  }

  /**
   * Which of `ids` have a command running (more than an idle shell prompt).
   * Failure is reported as "none busy": an unavailable backend must never be
   * able to block closing a tab.
   */
  static async busySessions(ids: string[]): Promise<string[]> {
    if (!isTauriAvailable() || ids.length === 0) return [];
    try {
      return await invoke<string[]>("pty_busy_sessions", { ids });
    } catch {
      return [];
    }
  }

  static async onPtyOutput(callback: (payload: PtyOutputPayload) => void): Promise<UnlistenFn> {
    if (!isTauriAvailable()) {
      return () => {};
    }
    return subscribePtyOutput(callback);
  }

  static async onPtyExit(callback: (payload: PtyExitPayload) => void): Promise<UnlistenFn> {
    if (!isTauriAvailable()) {
      return () => {};
    }
    return subscribePtyExit(callback);
  }

  static async getPtyCwd(id: string): Promise<string | null> {
    if (!isTauriAvailable()) {
      return null;
    }
    try {
      return await invoke<string | null>("get_pty_cwd", { id });
    } catch {
      return null;
    }
  }

  static async onPtyCwd(
    callback: (payload: { id: string; cwd: string }) => void
  ): Promise<UnlistenFn> {
    if (!isTauriAvailable()) {
      return () => {};
    }
    return subscribePtyCwd(callback);
  }

  static async getSystemTerminalConfig(): Promise<{
    font_family: string;
    font_size: number;
    theme: string;
    cursor_blink: boolean;
    cursor_style: string;
    opacity: number;
    default_shell?: string;
  } | null> {
    if (!isTauriAvailable()) {
      return null;
    }
    try {
      return await invoke("get_system_terminal_config");
    } catch {
      return null;
    }
  }
}

/**
 * Singleton instance export implementing IPtyService.
 */
export const ptyService: IPtyService = new PtyServiceImpl();
export const PtyService = PtyServiceImpl;
