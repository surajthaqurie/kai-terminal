import { isTauriAvailable } from "./ptyService";

/**
 * Closes the whole app window (desktop). Returns true when the close was
 * issued. Browser/mock fallback returns false so callers can recycle the
 * tab instead of leaving a dead pane.
 */
export async function closeAppWindow(): Promise<boolean> {
  if (!isTauriAvailable()) return false;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("close_app_window");
    return true;
  } catch (err) {
    console.warn("Failed to close app window via invoke close_app_window:", err);
  }
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().close();
    return true;
  } catch (err) {
    console.error("Failed to close app window:", err);
    return false;
  }
}
