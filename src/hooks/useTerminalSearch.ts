/**
 * Find-in-terminal for one pane (ARCH-03 extraction from `TerminalView`): the search bar's
 * open state, the match count, and the search add-on, which is fetched when the bar is first
 * opened (PERF-11) so it is ready before the first keystroke.
 *
 * Matches are highlighted in the pane's theme colours; the add-on reports "3 of 17" after
 * every find (`resultIndex` is -1 when the count passes the highlight limit). Clearing the
 * query removes the highlights; so does closing the bar by any route (its close button, the
 * shortcut, the palette), and the bar's own close button returns focus to the terminal.
 */
import { useEffect, useRef, useState } from "react";
import type { SearchAddon } from "@xterm/addon-search";
import type { Terminal } from "@xterm/xterm";
import {
  createLazyAddonSlot,
  loadSearchAddon,
  type LazyAddonSlot,
} from "../services/xtermLazyAddons";
import { getTheme, searchDecorations } from "../theme/registry";
import type { SearchOptions, SearchResults } from "../components/SearchBar";

export interface TerminalSearch {
  visible: boolean;
  /** Match count from the last find (null: no search yet, or cleared). */
  results: SearchResults | null;
  /** Opens or closes the bar (shortcut, palette, header button). */
  toggle(): void;
  close(): void;
  search(term: string, options: SearchOptions): void;
  next(term: string, options: SearchOptions): void;
  previous(term: string, options: SearchOptions): void;
  /** The terminal is being torn down: forget the add-on (a late load is dropped). */
  reset(): void;
}

export function useTerminalSearch(terminal: () => Terminal | null, theme: string): TerminalSearch {
  const [visible, setVisible] = useState(false);
  const [results, setResults] = useState<SearchResults | null>(null);
  const slotRef = useRef<LazyAddonSlot<SearchAddon> | null>(null);
  slotRef.current ??= createLazyAddonSlot<SearchAddon>(loadSearchAddon, terminal, (addon) => {
    addon.onDidChangeResults(({ resultIndex, resultCount }) =>
      setResults({ index: resultIndex, count: resultCount })
    );
  });
  const slot = slotRef.current;

  const findOptions = (options: SearchOptions) => ({
    ...options,
    decorations: searchDecorations(getTheme(theme)),
  });
  const clear = () => {
    slot.current()?.clearDecorations();
    setResults(null);
  };
  // Every way of closing the bar (toggle included) leaves no highlights behind.
  const wasVisibleRef = useRef(false);
  useEffect(() => {
    if (wasVisibleRef.current && !visible) clear();
    wasVisibleRef.current = visible;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  return {
    visible,
    results,
    toggle() {
      void slot.ensure();
      setVisible((prev) => !prev);
    },
    close() {
      setVisible(false);
      terminal()?.focus();
    },
    search(term, options) {
      if (!term) {
        clear();
        return;
      }
      void slot
        .ensure()
        .then((addon) => addon?.findNext(term, { ...findOptions(options), incremental: true }));
    },
    next(term, options) {
      if (term) void slot.ensure().then((addon) => addon?.findNext(term, findOptions(options)));
    },
    previous(term, options) {
      if (term) void slot.ensure().then((addon) => addon?.findPrevious(term, findOptions(options)));
    },
    reset: () => slot.reset(),
  };
}
