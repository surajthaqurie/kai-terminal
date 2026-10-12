import { SplitDirection, TerminalPane } from "../types/terminal";

export const MAX_PANES_PER_TAB = 4;
export const MIN_PANE_FRACTION = 0.2;
export const MAX_PANE_FRACTION = 0.8;

export function clampPaneFraction(v: number): number {
  if (!Number.isFinite(v)) return 0.5;
  return Math.min(MAX_PANE_FRACTION, Math.max(MIN_PANE_FRACTION, v));
}

export interface SplitTabState {
  panes: TerminalPane[];
  activePaneId: string;
  splitDirection: SplitDirection;
}

export function nextPaneId(tabId: string, panes: TerminalPane[]): string {
  return `${tabId}-p${panes.length + 1}-${Date.now().toString(36)}`;
}

export function activePaneIndex(tab: SplitTabState): number {
  const idx = tab.panes.findIndex((p) => p.id === tab.activePaneId);
  return idx >= 0 ? idx : 0;
}

/**
 * Splits ONLY the active pane: the new pane is inserted immediately after
 * the active pane (not appended at the end), and focus moves to it.
 *
 * The tab keeps a single flat flex direction. When the tab already has
 * >1 pane and the requested direction differs, the existing direction is
 * preserved so the whole tab layout is not flipped — the new pane still
 * appears adjacent to the active one. A fresh direction applies only when
 * going from 1 -> 2 panes.
 */
export function splitTab(
  tab: SplitTabState,
  tabId: string,
  direction: SplitDirection,
  makePane: (id: string) => TerminalPane
): SplitTabState {
  if (tab.panes.length >= MAX_PANES_PER_TAB) return tab;
  if (direction !== "horizontal" && direction !== "vertical") return tab;
  const id = nextPaneId(tabId, tab.panes);
  const pane = makePane(id);
  const at = activePaneIndex(tab);
  const panes = [...tab.panes.slice(0, at + 1), pane, ...tab.panes.slice(at + 1)];
  return {
    panes,
    activePaneId: id,
    // Only the first split sets the direction; later splits keep the tab's
    // existing direction so only the active pane's neighborhood changes.
    splitDirection: tab.panes.length <= 1 ? direction : tab.splitDirection,
  };
}

/**
 * Closes ONLY the active pane. Focus moves to the nearest surviving
 * neighbor (the pane that took its position), not blindly to the last.
 */
export function closePane(tab: SplitTabState): SplitTabState {
  if (tab.panes.length <= 1) return tab;
  const at = activePaneIndex(tab);
  const remaining = tab.panes.filter((p) => p.id !== tab.activePaneId);
  const nextIdx = Math.min(at, remaining.length - 1);
  return {
    panes: remaining,
    activePaneId: remaining[nextIdx].id,
    splitDirection: remaining.length === 1 ? "none" : tab.splitDirection,
  };
}

export function setActivePane(tab: SplitTabState, paneId: string): SplitTabState {
  if (!tab.panes.some((p) => p.id === paneId)) return tab;
  return { ...tab, activePaneId: paneId };
}
