import { isTauriAvailable } from "./ptyService";
import { isMacPlatform } from "./shortcuts";

/** Lowest background opacity the Appearance slider (and settings) allow. */
export const MIN_WINDOW_OPACITY = 0.2;

/**
 * Whether the app window itself can be see-through. The frameless window is
 * created transparent on Windows and Linux (`src-tauri/tauri.windows.conf.json`
 * / `tauri.linux.conf.json`). macOS would need Tauri's private API, so there
 * only the terminal background follows the slider, and a browser tab has no
 * transparent window at all.
 */
export function windowTransparencySupported(): boolean {
  return isTauriAvailable() && !isMacPlatform();
}

/**
 * Drives the see-through chrome from the "Terminal Background Opacity"
 * setting. `--win-alpha` feeds the `.win-translucent` rules in App.css (header,
 * tabs, footer, canvas); the terminal background itself is repainted by xterm
 * from the same value (`SettingsService.getThemeColors`).
 */
export function applyWindowOpacity(
  opacity: number | undefined,
  root: HTMLElement = document.documentElement
): void {
  const raw = typeof opacity === "number" && Number.isFinite(opacity) ? opacity : 1;
  const alpha = Math.max(MIN_WINDOW_OPACITY, Math.min(1, raw));
  const translucent = alpha < 1 && windowTransparencySupported();
  if (translucent) {
    root.style.setProperty("--win-alpha", alpha.toFixed(2));
  } else {
    root.style.removeProperty("--win-alpha");
  }
  root.classList.toggle("win-translucent", translucent);
}
