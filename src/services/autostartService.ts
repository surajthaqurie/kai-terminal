import { invoke } from "@tauri-apps/api/core";
import { isTauriAvailable } from "./ptyService";

const MOCK_KEY = "kai_autostart_enabled_mock";

/**
 * Cross-platform "launch at startup" client.
 * In Tauri it delegates to the Rust backend (Windows Run key, Linux XDG
 * Autostart .desktop, macOS LaunchAgent). In browser/mock mode it persists
 * to localStorage so settings UI stays testable.
 */
export async function getAutostartEnabled(): Promise<boolean> {
  if (!isTauriAvailable()) {
    try {
      return localStorage.getItem(MOCK_KEY) === "1";
    } catch {
      return false;
    }
  }
  return await invoke<boolean>("get_autostart_enabled");
}

export async function setAutostartEnabled(enabled: boolean): Promise<void> {
  if (!isTauriAvailable()) {
    try {
      localStorage.setItem(MOCK_KEY, enabled ? "1" : "0");
    } catch {
      // ignore
    }
    return;
  }
  await invoke<void>("set_autostart_enabled", { enabled });
}
