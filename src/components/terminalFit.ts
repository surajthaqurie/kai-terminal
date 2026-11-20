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

/** Tracks which grid the backend PTY currently has, so only real changes are sent. */
export interface PtySizeSync {
  /** Record the grid a PTY was spawned with (the backend already knows it). */
  spawned(id: string, cols: number, rows: number): void;
  /**
   * Send the grid to the backend unless it already has it. Returns whether a
   * resize was sent; a missing id (no live session yet) or an empty grid is skipped.
   */
  push(id: string | null, cols: number, rows: number): boolean;
}

/**
 * De-duplicates PTY resizes. A tab flip or window-focus refit lands on the
 * same grid, and on Windows every ConPTY resize makes the shell repaint, so
 * repeating one is not free. Keyed by session id too, so a respawned shell
 * (new id, same grid) is never mistaken for one that already has the size.
 */
export function createPtySizeSync(
  send: (id: string, cols: number, rows: number) => void
): PtySizeSync {
  let last = "";
  const key = (id: string, cols: number, rows: number) => `${id}:${cols}x${rows}`;
  return {
    spawned(id, cols, rows) {
      last = key(id, cols, rows);
    },
    push(id, cols, rows) {
      if (!id || !cols || !rows) return false;
      const next = key(id, cols, rows);
      if (next === last) return false;
      last = next;
      send(id, cols, rows);
      return true;
    },
  };
}

/**
 * Serialize an async sender so calls reach the backend in order, keeping only
 * the newest pending call. PTY resizes run on a thread pool, so two quick
 * resizes sent at once (dragging a split) could otherwise land out of order
 * and leave the shell at a stale size; intermediate sizes are not worth
 * sending anyway.
 */
export function serializeLatest<A extends unknown[]>(
  send: (...args: A) => Promise<unknown>
): (...args: A) => void {
  let inFlight = false;
  let pending: A | null = null;
  const run = (args: A) => {
    inFlight = true;
    let done: Promise<unknown>;
    try {
      done = send(...args);
    } catch (err) {
      done = Promise.reject(err);
    }
    void done
      .catch(() => {})
      .finally(() => {
        inFlight = false;
        if (pending) {
          const next = pending;
          pending = null;
          run(next);
        }
      });
  };
  return (...args: A) => {
    if (inFlight) {
      pending = args;
      return;
    }
    run(args);
  };
}
