// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import {
  createPaneLayout,
  splitLayoutNode,
  removePaneFromLayout,
  collectLayoutPaneIds,
  countLayoutPanes,
  setLayoutSplitRatio,
  layoutFromFlat,
  clampPaneFraction,
} from "../services/paneLayout";

describe("nested pane layout tree", () => {
  it("splits only the active leaf and keeps each axis independent", () => {
    let node = createPaneLayout("p1");
    node = splitLayoutNode(node, "p1", "vertical", "p2");
    expect(node.kind).toBe("split");
    if (node.kind !== "split") return;
    expect(node.direction).toBe("vertical");
    expect(collectLayoutPaneIds(node)).toEqual(["p1", "p2"]);

    // Split p1 horizontally: only that leaf becomes a horizontal split,
    // the outer vertical axis is preserved (the old bug flattened all).
    node = splitLayoutNode(node, "p1", "horizontal", "p3");
    if (node.kind !== "split") throw new Error("expected split");
    expect(node.direction).toBe("vertical");
    expect(node.first.kind).toBe("split");
    if (node.first.kind !== "split") return;
    expect(node.first.direction).toBe("horizontal");
    expect(countLayoutPanes(node)).toBe(3);
    expect(collectLayoutPaneIds(node)).toEqual(["p1", "p3", "p2"]);
  });

  it("ignores splits against unknown panes", () => {
    const node = createPaneLayout("p1");
    const next = splitLayoutNode(node, "nope", "vertical", "p2");
    expect(next).toEqual(node);
  });

  it("removes a leaf and collapses its parent", () => {
    let node = createPaneLayout("p1");
    node = splitLayoutNode(node, "p1", "vertical", "p2");
    node = splitLayoutNode(node, "p1", "horizontal", "p3");
    const pruned = removePaneFromLayout(node, "p3");
    expect(pruned).not.toBeNull();
    expect(collectLayoutPaneIds(pruned!)).toEqual(["p1", "p2"]);
    // Removing the last leaf yields null.
    expect(removePaneFromLayout(createPaneLayout("solo"), "solo")).toBeNull();
    // Unknown pane keeps the tree.
    expect(removePaneFromLayout(node, "nope")).toEqual(node);
  });

  it("clamps split ratios", () => {
    let node = createPaneLayout("p1");
    node = splitLayoutNode(node, "p1", "vertical", "p2");
    if (node.kind !== "split") throw new Error("expected split");
    const low = setLayoutSplitRatio(node, node.id, 0);
    if (low.kind !== "split") throw new Error("expected split");
    expect(low.ratio).toBe(0.2);
    const high = setLayoutSplitRatio(node, node.id, 99);
    if (high.kind !== "split") throw new Error("expected split");
    expect(high.ratio).toBe(0.8);
    expect(clampPaneFraction(0.5)).toBe(0.5);
    // Unknown split id leaves the tree unchanged.
    expect(setLayoutSplitRatio(node, "missing", 0.7)).toEqual(node);
  });

  it("builds legacy flat chains for restored sessions", () => {
    const single = layoutFromFlat(["a"], "none");
    expect(single).toEqual({ kind: "pane", paneId: "a" });
    const pair = layoutFromFlat(["a", "b"], "horizontal");
    if (pair.kind !== "split") throw new Error("expected split");
    expect(pair.direction).toBe("horizontal");
    expect(collectLayoutPaneIds(pair)).toEqual(["a", "b"]);
  });
});
