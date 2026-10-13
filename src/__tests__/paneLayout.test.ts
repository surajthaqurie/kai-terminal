// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import {
  splitTab,
  closePane,
  removePaneById,
  setActivePane,
  clampPaneFraction,
  computePaneRects,
  computeSplitDividers,
  resolveTabLayout,
  createPaneLayout,
  MAX_PANES_PER_TAB,
  SplitTabState,
} from "../services/paneLayout";
import { TerminalPane } from "../types/terminal";

function pane(id: string): TerminalPane {
  return { id, status: "connecting" };
}

describe("pane layout model", () => {
  it("splits tabs into independent panes with unique ids", () => {
    const tab = {
      panes: [pane("t-p1")],
      activePaneId: "t-p1",
      splitDirection: "none" as const,
    };
    const next = splitTab(tab, "t", "vertical", (id) => pane(id));
    expect(next.panes).toHaveLength(2);
    expect(next.panes[0].id).not.toBe(next.panes[1].id);
    expect(next.splitDirection).toBe("vertical");
    expect(next.activePaneId).toBe(next.panes[1].id);
  });

  it("bounds pane count and clamps drag fractions", () => {
    let tab: SplitTabState = {
      panes: [pane("t-p1")],
      activePaneId: "t-p1",
      splitDirection: "none" as const,
    };
    for (let i = 0; i < 10; i++) {
      tab = splitTab(tab, "t", "vertical", (id) => pane(id));
    }
    expect(tab.panes.length).toBeLessThanOrEqual(MAX_PANES_PER_TAB);
    expect(clampPaneFraction(0)).toBe(0.2);
    expect(clampPaneFraction(1)).toBe(0.8);
    expect(clampPaneFraction(0.5)).toBe(0.5);
    expect(clampPaneFraction(NaN)).toBe(0.5);
  });

  it("routes focus to one pane and closes only the active pane", () => {
    const tab = {
      panes: [pane("t-p1"), pane("t-p2")],
      activePaneId: "t-p1",
      splitDirection: "vertical" as const,
    };
    const focused = setActivePane(tab, "t-p2");
    expect(focused.activePaneId).toBe("t-p2");
    // Unknown pane id never steals focus.
    expect(setActivePane(tab, "nope").activePaneId).toBe("t-p1");
    const closed = closePane(focused);
    expect(closed.panes).toHaveLength(1);
    expect(closed.panes[0].id).toBe("t-p1");
    expect(closed.splitDirection).toBe("none");
  });

  it("never broadcasts close to a single pane", () => {
    const tab = {
      panes: [pane("t-p1")],
      activePaneId: "t-p1",
      splitDirection: "none" as const,
    };
    expect(closePane(tab).panes).toHaveLength(1);
  });

  it("splits only the active pane: inserts adjacent and updates layout direction", () => {
    let tab: SplitTabState = {
      panes: [pane("t-p1")],
      activePaneId: "t-p1",
      splitDirection: "none" as const,
    };
    tab = splitTab(tab, "t", "vertical", (id) => pane(id));
    expect(tab.splitDirection).toBe("vertical");
    // Focus first pane, then split: new pane lands right after it.
    tab = { ...tab, activePaneId: tab.panes[0].id };
    const before = tab.panes.map((p) => p.id);
    tab = splitTab(tab, "t", "vertical", (id) => pane(id));
    expect(tab.panes).toHaveLength(3);
    expect(tab.panes[0].id).toBe(before[0]);
    expect(tab.panes[1].id).toBe(tab.activePaneId);
    expect(tab.panes[2].id).toBe(before[1]);
    // Splitting with horizontal updates splitDirection to horizontal.
    tab = splitTab(tab, "t", "horizontal", (id) => pane(id));
    expect(tab.splitDirection).toBe("horizontal");
    expect(tab.panes).toHaveLength(4);
  });

  it("closes the active pane and focuses its neighbor", () => {
    const tab: SplitTabState = {
      panes: [pane("t-p1"), pane("t-p2"), pane("t-p3")],
      activePaneId: "t-p2",
      splitDirection: "vertical" as const,
    };
    const closed = closePane(tab);
    expect(closed.panes.map((p) => p.id)).toEqual(["t-p1", "t-p3"]);
    expect(closed.activePaneId).toBe("t-p3");
  });
});

describe("flat-grid geometry (no-remount splits)", () => {
  const approx = (v: number) => expect(v).toBeCloseTo(0, 10);

  it("renders a single pane full-bleed with no dividers", () => {
    const rects = computePaneRects(createPaneLayout("p1"));
    expect(rects).toEqual([{ paneId: "p1", x: 0, y: 0, w: 1, h: 1 }]);
    expect(computeSplitDividers(createPaneLayout("p1"))).toEqual([]);
  });

  it("tiles vertical splits side-by-side with the divider on the seam", () => {
    let tab: SplitTabState = {
      panes: [pane("t-p1")],
      activePaneId: "t-p1",
      splitDirection: "none" as const,
    };
    tab = splitTab(tab, "t", "vertical", (id) => pane(id));
    const layout = tab.layout!;
    const rects = computePaneRects(layout);
    expect(rects).toHaveLength(2);
    // First keeps its identity and left half; new pane takes the right half.
    expect(rects[0].paneId).toBe("t-p1");
    expect(rects[0]).toMatchObject({ x: 0, y: 0, h: 1 });
    expect(rects[0].w).toBeCloseTo(0.5, 10);
    expect(rects[1]).toMatchObject({ y: 0, h: 1 });
    expect(rects[1].x).toBeCloseTo(0.5, 10);
    expect(rects[1].w).toBeCloseTo(0.5, 10);
    // Halves tile exactly: no gap, no overlap.
    approx(rects[0].w + rects[1].w - 1);
    const divs = computeSplitDividers(layout);
    expect(divs).toHaveLength(1);
    expect(divs[0].direction).toBe("vertical");
    expect(divs[0].ratio).toBeCloseTo(0.5, 10);
    expect(divs[0].parent).toMatchObject({ x: 0, y: 0, w: 1, h: 1 });
  });

  it("tiles horizontal splits top/bottom", () => {
    let tab: SplitTabState = {
      panes: [pane("t-p1")],
      activePaneId: "t-p1",
      splitDirection: "none" as const,
    };
    tab = splitTab(tab, "t", "horizontal", (id) => pane(id));
    const rects = computePaneRects(tab.layout!);
    expect(rects[0]).toMatchObject({ x: 0, y: 0, w: 1 });
    expect(rects[0].h).toBeCloseTo(0.5, 10);
    expect(rects[1].y).toBeCloseTo(0.5, 10);
    const divs = computeSplitDividers(tab.layout!);
    expect(divs).toHaveLength(1);
    expect(divs[0].direction).toBe("horizontal");
  });

  it("keeps nested splits tiling the full area with dividers on seams", () => {
    let tab: SplitTabState = {
      panes: [pane("a")],
      activePaneId: "a",
      splitDirection: "none" as const,
    };
    tab = splitTab(tab, "t", "vertical", (id) => pane(id)); // a | b
    tab = { ...tab, activePaneId: tab.panes[1].id };
    tab = splitTab(tab, "t", "horizontal", (id) => pane(id)); // a | (b / c)
    const rects = computePaneRects(tab.layout!);
    expect(rects).toHaveLength(3);
    // Full-area tiling: union area is exactly 1.
    const area = rects.reduce((s, r) => s + r.w * r.h, 0);
    expect(area).toBeCloseTo(1, 10);
    // Pairwise non-overlap (positive-area intersection check).
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const A = rects[i];
        const B = rects[j];
        const ix = Math.min(A.x + A.w, B.x + B.w) - Math.max(A.x, B.x);
        const iy = Math.min(A.y + A.h, B.y + B.h) - Math.max(A.y, B.y);
        expect(Math.min(ix, iy)).toBeLessThanOrEqual(0);
      }
    }
    const divs = computeSplitDividers(tab.layout!);
    expect(divs).toHaveLength(2);
    // The nested divider lives inside the right half (parent x = 0.5).
    const nested = divs.find((d) => d.direction === "horizontal")!;
    expect(nested.parent.x).toBeCloseTo(0.5, 10);
    expect(nested.parent.w).toBeCloseTo(0.5, 10);
  });

  it("clamps out-of-range ratios in geometry", () => {
    const rects = computePaneRects({
      kind: "split",
      id: "s",
      direction: "vertical",
      ratio: 0.01,
      first: { kind: "pane", paneId: "a" },
      second: { kind: "pane", paneId: "b" },
    });
    expect(rects[0].w).toBeCloseTo(0.2, 10);
    expect(rects[1].w).toBeCloseTo(0.8, 10);
  });

  it("resolveTabLayout passes valid trees through and repairs the rest", () => {
    let tab: SplitTabState = {
      panes: [pane("a")],
      activePaneId: "a",
      splitDirection: "none" as const,
    };
    tab = splitTab(tab, "t", "vertical", (id) => pane(id));
    // Valid tree: identical object back (stable divider ids across renders).
    expect(resolveTabLayout(["a", tab.panes[1].id], tab.layout, "vertical")).toBe(tab.layout);
    // Stale ids (restored session): fallback covers exactly the live panes.
    const repaired = resolveTabLayout(["a", "b"], undefined, "vertical");
    expect(
      computePaneRects(repaired)
        .map((r) => r.paneId)
        .sort()
    ).toEqual(["a", "b"]);
    // Ghost ids are dropped, missing panes are added — every live pane renders once.
    const ghost = resolveTabLayout(["a", "c"], tab.layout, "vertical");
    expect(
      computePaneRects(ghost)
        .map((r) => r.paneId)
        .sort()
    ).toEqual(["a", "c"]);
    // Single pane always fills the area.
    expect(computePaneRects(resolveTabLayout(["solo"], undefined, "none"))).toEqual([
      { paneId: "solo", x: 0, y: 0, w: 1, h: 1 },
    ]);
  });

  it("split/close preserve surviving pane ids (renderer keys stay stable)", () => {
    let tab: SplitTabState = {
      panes: [pane("a")],
      activePaneId: "a",
      splitDirection: "none" as const,
    };
    tab = splitTab(tab, "t", "vertical", (id) => pane(id));
    const b = tab.panes[1].id;
    // Closing the new pane restores the original single-pane tree for "a".
    const closed = closePane({ ...tab, activePaneId: b });
    expect(closed.panes.map((p) => p.id)).toEqual(["a"]);
    expect(computePaneRects(closed.layout!).map((r) => r.paneId)).toEqual(["a"]);
  });
});

describe("removePaneById (shared exit/close path)", () => {
  function threePane(): SplitTabState {
    // a | (b / c): mixed-direction tree over three live panes.
    let tab: SplitTabState = {
      panes: [pane("a")],
      activePaneId: "a",
      splitDirection: "none" as const,
    };
    tab = splitTab(tab, "t", "vertical", (id) => pane(id));
    const b = tab.panes[1].id;
    tab = { ...tab, activePaneId: b };
    tab = splitTab(tab, "t", "horizontal", (id) => pane(id));
    return tab;
  }

  it("exiting one pane preserves survivor ids/objects (no neighbor refresh)", () => {
    const tab = threePane();
    const before = new Map(tab.panes.map((p) => [p.id, p]));
    const exiting = tab.panes[2].id;
    const next = removePaneById(tab, exiting);
    // Survivors keep identity: the renderer's stable keys keep them mounted.
    expect(next.panes.map((p) => p.id).sort()).toEqual(
      [...before.keys()].filter((id) => id !== exiting).sort()
    );
    for (const p of next.panes) {
      expect(p).toBe(before.get(p.id));
    }
    // Layout prunes to exactly the survivors.
    const ids = computePaneRects(next.layout!)
      .map((r) => r.paneId)
      .sort();
    expect(ids).toEqual(next.panes.map((p) => p.id).sort());
    // Full-area tiling is preserved after the collapse.
    const area = computePaneRects(next.layout!).reduce((s, r) => s + r.w * r.h, 0);
    expect(area).toBeCloseTo(1, 10);
  });

  it("moves focus to the neighbor only when the focused pane exits", () => {
    const tab = threePane();
    const focused = tab.activePaneId;
    const afterFocusedExit = removePaneById(tab, focused);
    expect(afterFocusedExit.activePaneId).not.toBe(focused);
    expect(afterFocusedExit.panes.some((p) => p.id === afterFocusedExit.activePaneId)).toBe(true);
    // Removing a background pane never steals focus.
    const background = tab.panes.find((p) => p.id !== focused)!.id;
    expect(removePaneById(tab, background).activePaneId).toBe(focused);
  });

  it("collapses the last two panes to a single full-bleed layout", () => {
    let tab: SplitTabState = {
      panes: [pane("a")],
      activePaneId: "a",
      splitDirection: "none" as const,
    };
    tab = splitTab(tab, "t", "vertical", (id) => pane(id));
    const next = removePaneById(tab, tab.panes[1].id);
    expect(next.panes.map((p) => p.id)).toEqual(["a"]);
    expect(next.splitDirection).toBe("none");
    expect(computePaneRects(next.layout!)).toEqual([{ paneId: "a", x: 0, y: 0, w: 1, h: 1 }]);
    expect(computeSplitDividers(next.layout!)).toEqual([]);
  });

  it("is a no-op for unknown ids and sole panes", () => {
    const tab = threePane();
    expect(removePaneById(tab, "nope")).toBe(tab);
    const solo: SplitTabState = {
      panes: [pane("a")],
      activePaneId: "a",
      splitDirection: "none" as const,
    };
    expect(removePaneById(solo, "a")).toBe(solo);
  });

  it("closePane behaves identically to removing the active pane", () => {
    const tab = threePane();
    expect(closePane(tab)).toEqual(removePaneById(tab, tab.activePaneId));
  });
});
