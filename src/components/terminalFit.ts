/** The part of a pane's container the fit decision needs (an HTMLElement fits). */
export interface PaneBox {
  clientWidth: number;
  clientHeight: number;
}

/**
 * Whether a terminal pane may be fitted, and its shell resized, right now.
 *
 * A hidden tab is `display:none`: its container has no layout box, yet the
 * ResizeObserver still fires when it collapses and FitAddon then derives a
 * grid from the container's stale computed style (observed: 12x5). Sending that
 * to the PTY reflows the shell's screen at 12 columns on every tab switch,
 * which shows as a garbled, displaced prompt after switching back.
 */
export function canFitPane(visible: boolean, box: PaneBox | null): boolean {
  return visible && box !== null && box.clientWidth > 0 && box.clientHeight > 0;
}
