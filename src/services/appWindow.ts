import { isTauriAvailable } from "./ptyService";
import { liveTerminalWindowLabels } from "./windowLayouts";

const individualCloseHandlers = new Set<() => void>();

/**
 * Runs `handler` when this window is about to close while other terminal windows stay open:
 * the user closed this one on purpose, so its tabs are not part of the next session (FUNC-07).
 * Not called when closing it ends the app. Returns the unsubscribe function.
 */
export function onIndividualWindowClose(handler: () => void): () => void {
  individualCloseHandlers.add(handler);
  return () => individualCloseHandlers.delete(handler);
}

async function beforeClose(): Promise<void> {
  if (individualCloseHandlers.size === 0) return;
  // Unknown (the window list could not be read): keep the layout, so the worst case is an
  // extra window offered next time rather than a lost one.
  const live = await liveTerminalWindowLabels();
  if (!live || live.length <= 1) return;
  for (const handler of individualCloseHandlers) {
    try {
      handler();
    } catch (err) {
      console.warn("A close handler failed:", err);
    }
  }
}

/**
 * Closes the whole app window (desktop). Returns true when the close was
 * issued. Browser/mock fallback returns false so callers can recycle the
 * tab instead of leaving a dead pane.
 */
export async function closeAppWindow(): Promise<boolean> {
  if (!isTauriAvailable()) return false;
  await beforeClose();
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

/**
 * Calls `onRequest` when the system asks this window to close (Alt+F4, the taskbar, the window
 * menu). The backend holds that close back until the page answers: `close_request_ack` says the
 * page has the question; the page then closes the window itself (`closeAppWindow`) or leaves it
 * open. Without the acknowledgement the close goes ahead after a short wait, so a page that
 * cannot answer never traps the window. Returns the unsubscribe function.
 */
export async function watchWindowCloseRequests(onRequest: () => void): Promise<() => void> {
  if (!isTauriAvailable()) return () => {};
  try {
    const { listen } = await import("@tauri-apps/api/event");
    const { invoke } = await import("@tauri-apps/api/core");
    return await listen("kai-close-requested", () => {
      // Acknowledge first: from here on the page owns the decision. A failure to acknowledge is
      // harmless (the close then simply goes ahead after the wait).
      void invoke("close_request_ack").catch(() => {});
      onRequest();
    });
  } catch (err) {
    console.warn("Failed to watch window close requests:", err);
    return () => {};
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

/** A box in CSS pixels, relative to the window's client area. */
export interface ButtonBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** How the maximize button looks while Windows owns its pointer (see `snap_layouts.rs`). */
export type MaximizeButtonState = "none" | "hover" | "pressed";

/** The box of an element, or null when it has no layout (hidden, detached). */
export function boxOf(el: Element | null): ButtonBox | null {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (!(r.width > 0) || !(r.height > 0)) return null;
  return { x: r.left, y: r.top, width: r.width, height: r.height };
}

/**
 * Tells the desktop app where the maximize button is, so Windows 11 shows its
 * snap-layouts popup over it (`null` clears it). Resolves true when Windows
 * now owns the pointer over that box: the page then gets no mouse events
 * there, a click maximizes natively and the button's look arrives through
 * `watchMaximizeButtonState`. False everywhere else (browser, macOS, Linux,
 * Windows 10), where the in-page button handles its own pointer.
 */
export async function reportMaximizeButtonBox(box: ButtonBox | null): Promise<boolean> {
  if (!isTauriAvailable()) return false;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const { x, y, width, height } = box ?? { x: 0, y: 0, width: 0, height: 0 };
    return (await invoke<boolean>("set_maximize_button_rect", { x, y, width, height })) === true;
  } catch (err) {
    console.warn("Failed to report the maximize button position:", err);
    return false;
  }
}

const BUTTON_STATES: readonly string[] = ["none", "hover", "pressed"];

/** Subscribes to the native hover / pressed state of the maximize button. */
export async function watchMaximizeButtonState(
  onChange: (state: MaximizeButtonState) => void
): Promise<() => void> {
  if (!isTauriAvailable()) return () => {};
  try {
    const { listen } = await import("@tauri-apps/api/event");
    return await listen<string>("kai-maximize-button-state", (event) => {
      if (BUTTON_STATES.includes(event.payload)) onChange(event.payload as MaximizeButtonState);
    });
  } catch (err) {
    console.warn("Failed to watch the maximize button state:", err);
    return () => {};
  }
}
