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
  return {
    panes: [...tab.panes, pane],
    activePaneId: id,
    splitDirection: direction,
  };
}

export function closePane(tab: SplitTabState): SplitTabState {
  if (tab.panes.length <= 1) return tab;
  const remaining = tab.panes.filter((p) => p.id !== tab.activePaneId);
  return {
    panes: remaining,
    activePaneId: remaining[remaining.length - 1].id,
    splitDirection: remaining.length === 1 ? "none" : tab.splitDirection,
  };
}

export function setActivePane(tab: SplitTabState, paneId: string): SplitTabState {
  if (!tab.panes.some((p) => p.id === paneId)) return tab;
  return { ...tab, activePaneId: paneId };
}
