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
  onPtyOutput(callback: (payload: PtyOutputPayload) => void): Promise<UnlistenFn>;
  onPtyExit(callback: (payload: PtyExitPayload) => void): Promise<UnlistenFn>;
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

  async onPtyOutput(callback: (payload: PtyOutputPayload) => void): Promise<UnlistenFn> {
    return PtyServiceImpl.onPtyOutput(callback);
  }

  async onPtyExit(callback: (payload: PtyExitPayload) => void): Promise<UnlistenFn> {
    return PtyServiceImpl.onPtyExit(callback);
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
    return await invoke<PtySessionInfo>("create_pty", { options });
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
}

/**
 * Singleton instance export implementing IPtyService.
 */
export const ptyService: IPtyService = new PtyServiceImpl();
export const PtyService = PtyServiceImpl;
