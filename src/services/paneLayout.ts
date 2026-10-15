import {
  PaneLayoutNode,
  PaneSplitDirection,
  SplitDirection,
  TerminalPane,
} from "../types/terminal";

/**
 * Hard ceiling on panes per tab (a 4x2 / 2x4 grid is still readable on a
 * 1080p window). Single source of truth: persistence and restore import this.
 */
export const MAX_PANES_PER_TAB = 8;
/**
 * Smallest share of the pane area (per axis) a split may leave a pane.
 * Repeatedly splitting the newest pane halves it every time; without this
 * floor 8 panes could shrink to 1/128 of the window and become unusable.
 * 1/8 matches the narrowest pane the previous 4-pane cap could ever produce.
 */
export const MIN_SPLIT_EXTENT = 0.125;
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
  layout?: PaneLayoutNode;
}

export function nextPaneId(tabId: string, panes: TerminalPane[]): string {
  return `${tabId}-p${panes.length + 1}-${Date.now().toString(36)}`;
}

let splitSeq = 0;
export function nextSplitId(): string {
  splitSeq += 1;
  return `split-${Date.now().toString(36)}-${splitSeq}-${Math.floor(Math.random() * 0xffff).toString(16)}`;
}

export function activePaneIndex(tab: SplitTabState): number {
  const idx = tab.panes.findIndex((p) => p.id === tab.activePaneId);
  return idx >= 0 ? idx : 0;
}

/**
 * Splits ONLY the active pane: the new pane is inserted immediately after
 * the active pane (not appended at the end), and focus moves to it.
 *
 * Sets the layout split direction to the requested direction (horizontal or vertical)
 * and supports arbitrary N splits up to MAX_PANES_PER_TAB. A split that would
 * leave the active pane narrower/shorter than MIN_SPLIT_EXTENT of the pane
 * area is refused (tab returned unchanged), same as hitting the pane cap.
 *
 * NOTE: legacy flat helper kept for compat/tests. New UI should prefer the
 * nested tree helpers below (`createPaneLayout` / `splitLayoutNode`), which
 * preserve mixed directions instead of overwriting one global axis.
 */
export function splitTab(
  tab: SplitTabState,
  tabId: string,
  direction: SplitDirection,
  makePane: (id: string) => TerminalPane
): SplitTabState {
  if (tab.panes.length >= MAX_PANES_PER_TAB) return tab;
  if (direction !== "horizontal" && direction !== "vertical") return tab;
  const baseLayout =
    tab.layout ??
    layoutFromFlat(
      tab.panes.map((p) => p.id),
      tab.splitDirection
    );
  if (!paneFitsSplit(baseLayout, tab.activePaneId, direction)) return tab;
  const id = nextPaneId(tabId, tab.panes);
  const pane = makePane(id);
  const at = activePaneIndex(tab);
  const panes = [...tab.panes.slice(0, at + 1), pane, ...tab.panes.slice(at + 1)];
  const layout = splitLayoutNode(baseLayout, tab.activePaneId, direction, id);
  return {
    panes,
    activePaneId: id,
    splitDirection: direction,
    layout,
  };
}

/**
 * Removes ANY pane by id (exit path, close button, teardown).
 *
 * Survivor guarantees (the flat-grid renderer depends on these to keep live
 * terminals mounted on every OS — no refresh of the remaining splits):
 * - surviving pane objects are preserved by reference with unchanged ids,
 * - the layout tree is pruned to exactly the survivors (stale trees fall
 *   back to an even tiling via the same rule as `resolveTabLayout`),
 * - focus moves to the nearest surviving neighbor only when the removed
 *   pane had focus; otherwise the active pane is untouched.
 * Unknown id (or a sole pane) -> tab unchanged.
 */
export function removePaneById(tab: SplitTabState, paneId: string): SplitTabState {
  if (tab.panes.length <= 1) return tab;
  const at = tab.panes.findIndex((p) => p.id === paneId);
  if (at < 0) return tab;
  const remaining = tab.panes.filter((p) => p.id !== paneId);
  const nextIdx = Math.min(at, remaining.length - 1);
  const baseLayout =
    tab.layout ??
    layoutFromFlat(
      tab.panes.map((p) => p.id),
      tab.splitDirection
    );
  const pruned = removePaneFromLayout(baseLayout, paneId) ?? createPaneLayout(remaining[0].id);
  return {
    panes: remaining,
    activePaneId: tab.activePaneId === paneId ? remaining[nextIdx].id : tab.activePaneId,
    splitDirection: remaining.length === 1 ? "none" : tab.splitDirection,
    layout: remaining.length === 1 ? createPaneLayout(remaining[0].id) : pruned,
  };
}

/**
 * Closes ONLY the active pane. Focus moves to the nearest surviving
 * neighbor (the pane that took its position), not blindly to the last.
 */
export function closePane(tab: SplitTabState): SplitTabState {
  if (tab.panes.length <= 1) return tab;
  return removePaneById(tab, tab.activePaneId);
}

export function setActivePane(tab: SplitTabState, paneId: string): SplitTabState {
  if (!tab.panes.some((p) => p.id === paneId)) return tab;
  return { ...tab, activePaneId: paneId };
}

// ---------------------------------------------------------------------------
// Nested binary split tree (proper mixed-direction layouts)
// ---------------------------------------------------------------------------

/** Single-pane tree. */
export function createPaneLayout(paneId: string): PaneLayoutNode {
  return { kind: "pane", paneId };
}

/**
 * Build a tree from a legacy flat pane list + one global direction.
 * 1 pane -> leaf. 2 panes -> one split. N panes -> left-leaning chain
 * along the same axis (matches the old flat rendering exactly).
 */
export function layoutFromFlat(paneIds: string[], direction: SplitDirection): PaneLayoutNode {
  if (paneIds.length === 0) return { kind: "pane", paneId: "" };
  if (paneIds.length === 1 || direction === "none") return createPaneLayout(paneIds[0]);
  const axis: PaneSplitDirection = direction === "horizontal" ? "horizontal" : "vertical";
  let node: PaneLayoutNode = createPaneLayout(paneIds[0]);
  for (const id of paneIds.slice(1)) {
    node = {
      kind: "split",
      id: nextSplitId(),
      direction: axis,
      ratio: 0.5,
      first: node,
      second: createPaneLayout(id),
    };
  }
  return node;
}

/**
 * Split ONLY the leaf holding `targetPaneId` along `direction`.
 * The target stays as `first`, the new pane becomes `second` and receives
 * focus. Unknown target -> tree unchanged.
 */
export function splitLayoutNode(
  node: PaneLayoutNode,
  targetPaneId: string,
  direction: PaneSplitDirection,
  newPaneId: string
): PaneLayoutNode {
  if (node.kind === "pane") {
    if (node.paneId !== targetPaneId) return node;
    return {
      kind: "split",
      id: nextSplitId(),
      direction,
      ratio: 0.5,
      first: { kind: "pane", paneId: targetPaneId },
      second: { kind: "pane", paneId: newPaneId },
    };
  }
  return {
    ...node,
    first: splitLayoutNode(node.first, targetPaneId, direction, newPaneId),
    second: splitLayoutNode(node.second, targetPaneId, direction, newPaneId),
  };
}

/**
 * Remove a leaf and collapse its parent split (the surviving sibling takes
 * the parent's place). Returns null when the tree becomes empty.
 */
export function removePaneFromLayout(node: PaneLayoutNode, paneId: string): PaneLayoutNode | null {
  if (node.kind === "pane") {
    return node.paneId === paneId ? null : node;
  }
  const first = removePaneFromLayout(node.first, paneId);
  const second = removePaneFromLayout(node.second, paneId);
  if (first && second) {
    if (first === node.first && second === node.second) return node;
    return { ...node, first, second };
  }
  // One side vanished: collapse.
  return first ?? second;
}

/** All pane ids referenced by the tree (depth-first, first-before-second). */
export function collectLayoutPaneIds(node: PaneLayoutNode): string[] {
  if (node.kind === "pane") return [node.paneId];
  return [...collectLayoutPaneIds(node.first), ...collectLayoutPaneIds(node.second)];
}

export function countLayoutPanes(node: PaneLayoutNode): number {
  if (node.kind === "pane") return 1;
  return countLayoutPanes(node.first) + countLayoutPanes(node.second);
}

/** Update one split's ratio by id (clamped). Unknown id -> tree unchanged. */
export function setLayoutSplitRatio(
  node: PaneLayoutNode,
  splitId: string,
  ratio: number
): PaneLayoutNode {
  if (node.kind === "pane") return node;
  if (node.id === splitId) return { ...node, ratio: clampPaneFraction(ratio) };
  return {
    ...node,
    first: setLayoutSplitRatio(node.first, splitId, ratio),
    second: setLayoutSplitRatio(node.second, splitId, ratio),
  };
}

/** Find a split node by id (for drag handlers). */
export function findLayoutSplit(node: PaneLayoutNode, splitId: string): PaneLayoutNode | null {
  if (node.kind === "pane") return null;
  if (node.id === splitId) return node;
  return findLayoutSplit(node.first, splitId) ?? findLayoutSplit(node.second, splitId);
}

// ---------------------------------------------------------------------------
// Flat-grid geometry: DOM-stable rendering without remounts
// ---------------------------------------------------------------------------

/**
 * Fractional rectangle (0..1 of the tab's pane area) for one pane.
 */
export interface PaneRect {
  paneId: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Geometry for one split divider: its stable id, axis, clamped ratio, and
 * the fractional rectangle of the split it divides (used to position the
 * divider and to convert pointer drags into ratios).
 */
export interface SplitDividerGeometry {
  splitId: string;
  direction: PaneSplitDirection;
  ratio: number;
  parent: PaneRect;
}

/**
 * Computes every leaf's rectangle from a layout tree.
 *
 * This is what lets the renderer keep a FLAT list of absolutely-positioned
 * pane elements with stable `key={pane.id}`: the tree drives geometry only,
 * never DOM nesting. Splitting/closing/resizing therefore never reparents a
 * live pane, so React never unmounts its TerminalView — previously the
 * nested flexbox tree moved the old pane under a new split element on every
 * split, disposing its xterm, closing its backend PTY, and respawning a
 * fresh shell ("opening a split refreshes the older terminal").
 */
export function computePaneRects(node: PaneLayoutNode): PaneRect[] {
  const out: PaneRect[] = [];
  const walk = (n: PaneLayoutNode, x: number, y: number, w: number, h: number): void => {
    if (n.kind === "pane") {
      out.push({ paneId: n.paneId, x, y, w, h });
      return;
    }
    const ratio = clampPaneFraction(n.ratio);
    if (n.direction === "vertical") {
      // Side-by-side: first takes the left `ratio` share.
      const wFirst = w * ratio;
      walk(n.first, x, y, wFirst, h);
      walk(n.second, x + wFirst, y, w - wFirst, h);
    } else {
      // Stacked: first takes the top `ratio` share.
      const hFirst = h * ratio;
      walk(n.first, x, y, w, hFirst);
      walk(n.second, x, y + hFirst, w, h - hFirst);
    }
  };
  walk(node, 0, 0, 1, 1);
  return out;
}

/**
 * Computes every split divider's geometry from a layout tree (same traversal
 * as `computePaneRects`, so dividers always sit exactly on pane seams).
 */
export function computeSplitDividers(node: PaneLayoutNode): SplitDividerGeometry[] {
  const out: SplitDividerGeometry[] = [];
  const walk = (n: PaneLayoutNode, x: number, y: number, w: number, h: number): void => {
    if (n.kind === "pane") return;
    const ratio = clampPaneFraction(n.ratio);
    out.push({ splitId: n.id, direction: n.direction, ratio, parent: { paneId: "", x, y, w, h } });
    if (n.direction === "vertical") {
      const wFirst = w * ratio;
      walk(n.first, x, y, wFirst, h);
      walk(n.second, x + wFirst, y, w - wFirst, h);
    } else {
      const hFirst = h * ratio;
      walk(n.first, x, y, w, hFirst);
      walk(n.second, x, y + hFirst, w, h - hFirst);
    }
  };
  walk(node, 0, 0, 1, 1);
  return out;
}

/**
 * Resolves the renderable layout tree for a tab's CURRENT panes.
 *
 * The stored tree can reference stale ids (restored sessions, corrupt
 * persistence, races between split/close updates). When it does not cover
 * exactly the live pane ids, fall back to an even tiling so every live pane
 * renders exactly once and no ghost pane renders at all. The fallback is
 * geometry-only: it never mutates tab state, so a transient mismatch cannot
 * destroy live sessions.
 */
export function resolveTabLayout(
  paneIds: string[],
  layout: PaneLayoutNode | undefined,
  splitDirection: SplitDirection
): PaneLayoutNode {
  if (paneIds.length === 0) return { kind: "pane", paneId: "" };
  if (layout) {
    const ids = collectLayoutPaneIds(layout);
    // Exact cover AND uniqueness: a persisted tree referencing one pane
    // twice (duplicate paneIndex refs) must not render the same live pane
    // in two cells. Fall back to an even tiling in that case.
    if (
      ids.length === paneIds.length &&
      new Set(ids).size === ids.length &&
      ids.every((id) => paneIds.includes(id))
    ) {
      return layout;
    }
  }
  if (paneIds.length === 1) return createPaneLayout(paneIds[0]);
  return layoutFromFlat(paneIds, splitDirection === "none" ? "vertical" : splitDirection);
}

/**
 * True when splitting `paneId` along `direction` (halving it) leaves both
 * halves at least MIN_SPLIT_EXTENT of the pane area on that axis. Unknown
 * pane ids are not blocked here (the split itself is a no-op for them).
 * Geometry-only; a small epsilon absorbs float error from repeated halving.
 */
export function paneFitsSplit(
  layout: PaneLayoutNode,
  paneId: string,
  direction: PaneSplitDirection
): boolean {
  const rect = computePaneRects(layout).find((r) => r.paneId === paneId);
  if (!rect) return true;
  const extent = direction === "vertical" ? rect.w : rect.h;
  return extent / 2 >= MIN_SPLIT_EXTENT - 1e-9;
}
