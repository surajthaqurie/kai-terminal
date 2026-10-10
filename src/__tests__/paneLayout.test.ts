// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import {
  splitTab,
  closePane,
  setActivePane,
  clampPaneFraction,
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
});
