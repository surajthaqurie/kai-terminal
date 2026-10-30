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

type WindowAction = "minimize" | "toggleMaximize";

/** Minimizes or maximizes/restores the app window. No-op outside Tauri. */
export async function controlAppWindow(action: WindowAction): Promise<void> {
  if (!isTauriAvailable()) return;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const win = getCurrentWindow();
    if (action === "minimize") await win.minimize();
    else await win.toggleMaximize();
  } catch (err) {
    console.warn(`Failed to ${action} app window:`, err);
  }
}

/**
 * Reports whether the window is maximized now and on every resize, so the
 * maximize button can show its restore icon. Returns an unsubscribe function.
 */
export async function watchWindowMaximized(
  onChange: (maximized: boolean) => void
): Promise<() => void> {
  if (!isTauriAvailable()) return () => {};
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const win = getCurrentWindow();
    onChange(await win.isMaximized());
    return await win.onResized(async () => onChange(await win.isMaximized()));
  } catch (err) {
    console.warn("Failed to watch window maximize state:", err);
    return () => {};
  }
}
