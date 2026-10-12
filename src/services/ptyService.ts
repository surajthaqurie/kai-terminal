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
export class PtyServiceImpl implements IPtyService {
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
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("PTY launch timed out after 20s")), 20000)
    );
    return await Promise.race([invoke<PtySessionInfo>("create_pty", { options }), timeout]);
  }

  static async writeToPty(id: string, data: string): Promise<void> {
    if (!isTauriAvailable()) return;
    await invoke<void>("write_to_pty", { id, data });
  }

  static async resizePty(id: string, cols: number, rows: number): Promise<void> {
    if (!isTauriAvailable()) return;
    await invoke<void>("resize_pty", { id, cols, rows });
  }

  static async closePty(id: string): Promise<void> {
    if (!isTauriAvailable()) return;
    await invoke<void>("close_pty", { id });
  }

  static async onPtyOutput(callback: (payload: PtyOutputPayload) => void): Promise<UnlistenFn> {
    if (!isTauriAvailable()) {
      return () => {};
    }
    return await listen<PtyOutputPayload>("pty-output", (event) => {
      callback(event.payload);
    });
  }

  static async onPtyExit(callback: (payload: PtyExitPayload) => void): Promise<UnlistenFn> {
    if (!isTauriAvailable()) {
      return () => {};
    }
    return await listen<PtyExitPayload>("pty-exit", (event) => {
      callback(event.payload);
    });
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
    return await listen<{ id: string; cwd: string }>("pty-cwd", (event) => {
      callback(event.payload);
    });
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
