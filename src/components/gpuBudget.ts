/**
 * Bounds how many HIDDEN panes keep a WebGL context.
 *
 * Browsers cap live WebGL contexts (~16), so hidden tabs cannot all keep one.
 * A timer-based release (drop after N seconds hidden) made switching back to
 * any tab left for a while rebuild the renderer on the UI thread (shader
 * compile + glyph atlas), which showed as a stall and a frame of stale,
 * garbled glyphs. Counting instead means the tabs people actually flip between
 * keep their renderer, and only the longest-hidden ones past `max` give theirs
 * back (they fall back to the DOM renderer and re-attach when shown).
 */
export interface HiddenGpuBudget {
  /** A pane that holds a GPU renderer just became hidden; evicts the oldest past `max`. */
  hide(release: () => void): void;
  /** The pane is visible again (or gone): it no longer counts as hidden. */
  show(release: () => void): void;
  /** Number of hidden panes currently holding a renderer. */
  readonly size: number;
}

export function createHiddenGpuBudget(max: number): HiddenGpuBudget {
  const hidden: Array<() => void> = []; // oldest first
  const remove = (release: () => void) => {
    const i = hidden.indexOf(release);
    if (i >= 0) hidden.splice(i, 1);
  };
  return {
    hide(release) {
      remove(release);
      hidden.push(release);
      while (hidden.length > max) {
        const oldest = hidden.shift();
        try {
          oldest?.();
        } catch {
          // Already disposed with its terminal.
        }
      }
    },
    show: remove,
    get size() {
      return hidden.length;
    },
  };
}
