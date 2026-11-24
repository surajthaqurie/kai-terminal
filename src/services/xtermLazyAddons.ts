/**
 * Loaders for the xterm add-ons a pane does not need to start. Search, Serialize and Image together
 * were about 50 kB of the 190 kB (gzip) app chunk that every launch downloads and parses before
 * the first terminal paints; they are fetched when first used instead (PERF-11):
 *
 * - Search: when the search bar is first opened.
 * - Serialize: when a tab is first moved to another window (the screen snapshot).
 * - Image: right after the pane is on screen (inline images are rare at the very first moment).
 *
 * Each is imported once; later calls share the same promise.
 */
import type { ImageAddon } from "@xterm/addon-image";
import type { SearchAddon } from "@xterm/addon-search";
import type { SerializeAddon } from "@xterm/addon-serialize";

let search: Promise<typeof SearchAddon> | undefined;
let serialize: Promise<typeof SerializeAddon> | undefined;
let image: Promise<typeof ImageAddon> | undefined;

export function loadSearchAddon(): Promise<typeof SearchAddon> {
  search ??= import("@xterm/addon-search").then((m) => m.SearchAddon);
  search.catch(() => (search = undefined)); // a failed load may be retried
  return search;
}

export function loadSerializeAddon(): Promise<typeof SerializeAddon> {
  serialize ??= import("@xterm/addon-serialize").then((m) => m.SerializeAddon);
  serialize.catch(() => (serialize = undefined));
  return serialize;
}

export function loadImageAddon(): Promise<typeof ImageAddon> {
  image ??= import("@xterm/addon-image").then((m) => m.ImageAddon);
  image.catch(() => (image = undefined));
  return image;
}

/** What a lazy slot needs from xterm's `Terminal`. */
export interface AddonHost {
  loadAddon(addon: never): void;
}

/**
 * One lazily loaded add-on for one pane: loaded and attached on first `ensure()`, shared by
 * later calls. `reset()` (the terminal is torn down) forgets it, and an add-on whose load
 * finishes after a reset is dropped instead of being attached to a dead or newer terminal.
 * A failed load resolves to null and is retried on the next `ensure()`.
 */
export interface LazyAddonSlot<A> {
  /** The attached add-on, or null if it is not loaded (yet). */
  current(): A | null;
  ensure(): Promise<A | null>;
  reset(): void;
}

export function createLazyAddonSlot<A>(
  load: () => Promise<new () => A>,
  terminal: () => AddonHost | null,
  onAttach?: (addon: A) => void
): LazyAddonSlot<A> {
  let addon: A | null = null;
  let loading: Promise<A | null> | null = null;
  let epoch = 0;
  return {
    current: () => addon,
    ensure() {
      if (addon) return Promise.resolve(addon);
      if (loading) return loading;
      const mine = epoch;
      const attempt: Promise<A | null> = load()
        .then((AddonClass) => {
          const term = terminal();
          if (!term || epoch !== mine) return null;
          const created = new AddonClass();
          term.loadAddon(created as never);
          onAttach?.(created);
          addon = created;
          return created;
        })
        .catch(() => null)
        .then((result) => {
          if (loading === attempt && !result) loading = null; // allow a retry
          return result;
        });
      loading = attempt;
      return attempt;
    },
    reset() {
      epoch += 1;
      addon = null;
      loading = null;
    },
  };
}
