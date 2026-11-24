import type { Terminal } from "@xterm/xterm";
import { WebglAddon } from "@xterm/addon-webgl";
import { isSecondaryTerminalWindow } from "../services/terminalWindows";
import { createHiddenGpuBudget } from "./gpuBudget";

/**
 * GPU (WebGL) renderer for xterm. The default DOM renderer is the main cause
 * of typing/scroll lag and dropped frames under heavy output (TUIs, AI CLIs,
 * builds), so panes use WebGL whenever the WebView supports it.
 *
 * - Attached only to VISIBLE panes: browsers cap live WebGL contexts (~16), and
 *   hidden tabs stay mounted, so they release theirs and fall back to DOM.
 * - Any failure (no WebGL2, blocklisted GPU, context loss) silently keeps / falls
 *   back to the DOM renderer — never breaks the terminal.
 * - Escape hatch: `localStorage.kai_renderer = "dom"` forces the DOM renderer.
 */
export function gpuRendererDisabled(): boolean {
  try {
    return window.localStorage.getItem("kai_renderer") === "dom";
  } catch {
    return false;
  }
}

export function attachGpuRenderer(
  term: Terminal,
  slot: { current: WebglAddon | null },
  onContextLost?: () => void
): void {
  if (slot.current || gpuRendererDisabled()) return;
  try {
    const addon = new WebglAddon();
    addon.onContextLoss(() => {
      try {
        addon.dispose();
      } catch {
        // Already disposed with the terminal.
      }
      if (slot.current === addon) slot.current = null;
      // The pane now runs on the slower DOM renderer; the caller decides whether to win
      // the GPU back (a visible pane should, see GPU_REATTACH_DELAYS_MS).
      onContextLost?.();
      // A WebView drops the GPU context of a canvas that sat hidden for a while
      // (and may report it only after the tab is shown again). Disposing the
      // addon hands the screen back to the DOM renderer, whose rows were never
      // painted while the canvas drove the display, so the pane stays blank
      // until something dirties it. Repaint every row right away.
      requestAnimationFrame(() => {
        try {
          term.refresh(0, Math.max(0, term.rows - 1));
        } catch {
          // Terminal already disposed.
        }
      });
    });
    term.loadAddon(addon);
    slot.current = addon;
    term.refresh(0, Math.max(0, term.rows - 1));
  } catch {
    // WebGL2 unavailable: the DOM renderer keeps working.
    slot.current = null;
  }
}

/**
 * Hidden panes that may keep a WebGL context at once. Visible panes (splits)
 * plus this stay well under the ~16 context cap; the longest-hidden go first.
 */
const MAX_HIDDEN_GPU_PANES = 6;
/**
 * Every extra terminal window is another page whose panes hold WebGL contexts, and the
 * browser's cap on live contexts may be shared between them. A window dragged out of
 * the main one therefore keeps fewer hidden panes on the GPU. (Whether WebView2 shares
 * the cap between windows has not been verified; being conservative costs only a
 * renderer rebuild when an old tab is shown again.)
 */
const MAX_HIDDEN_GPU_PANES_SECONDARY_WINDOW = 2;
export const hiddenGpuBudget = createHiddenGpuBudget(
  isSecondaryTerminalWindow() ? MAX_HIDDEN_GPU_PANES_SECONDARY_WINDOW : MAX_HIDDEN_GPU_PANES
);

/**
 * A visible pane that lost its WebGL context asks for a new one after these delays (one
 * try each). Before, it stayed on the DOM renderer until its tab was switched away and
 * back. Bounded so a GPU that really cannot keep a context does not loop.
 */
export const GPU_REATTACH_DELAYS_MS = [500, 2000, 8000];

export function detachGpuRenderer(slot: { current: WebglAddon | null }): void {
  const addon = slot.current;
  slot.current = null;
  if (!addon) return;
  try {
    addon.dispose();
  } catch {
    // Already disposed; safe to ignore.
  }
}
