// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import {
  LAYOUT_KEY,
  createDefaultTab,
  loadPersistedLayout,
  newTabId,
  savePersistedLayout,
} from "../services/tabFactory";
import { MAX_PANES_PER_TAB } from "../services/paneLayout";

beforeEach(() => localStorage.clear());

describe("newTabId", () => {
  it("never repeats, even within the same millisecond", () => {
    const ids = new Set(Array.from({ length: 500 }, () => newTabId()));
    expect(ids.size).toBe(500);
  });
});

describe("createDefaultTab", () => {
  it("creates one connecting pane with a matching single-pane layout", () => {
    const tab = createDefaultTab("Terminal 1", "/bin/zsh", "/home/me");
    expect(tab.panes).toHaveLength(1);
    expect(tab.panes[0]).toMatchObject({
      shellPath: "/bin/zsh",
      cwd: "/home/me",
      status: "connecting",
    });
    expect(tab.activePaneId).toBe(tab.panes[0].id);
    expect(tab.splitDirection).toBe("none");
    expect(tab.layout).toEqual({ kind: "pane", paneId: tab.panes[0].id });
  });

  it("restores saved panes, falling back to a flat split chain when no layout is stored", () => {
    const tab = createDefaultTab("T", "/bin/sh", "/w", {
      title: "T",
      color: "#fff",
      splitDirection: "horizontal",
      panes: [{ cwd: "/a" }, { shellPath: "/bin/fish" }, {}],
    });
    expect(tab.color).toBe("#fff");
    expect(tab.panes.map((p) => p.cwd)).toEqual(["/a", "/w", "/w"]);
    expect(tab.panes.map((p) => p.shellPath)).toEqual(["/bin/sh", "/bin/fish", "/bin/sh"]);
    expect(tab.splitDirection).toBe("horizontal");
    // Two splits chain the three panes, all along the saved axis.
    expect(tab.layout).toMatchObject({ kind: "split", direction: "horizontal", ratio: 0.5 });
  });

  it("never restores more panes than the per-tab limit", () => {
    const panes = Array.from({ length: MAX_PANES_PER_TAB + 5 }, () => ({}));
    expect(createDefaultTab("T", undefined, undefined, { title: "T", panes }).panes).toHaveLength(
      MAX_PANES_PER_TAB
    );
  });
});

describe("persisted layout", () => {
  it("round-trips titles, colors, cwd and split structure — and nothing else", () => {
    const single = createDefaultTab("One", "/bin/sh", "/one");
    const split = createDefaultTab("Two", "/bin/sh", "/two", {
      title: "Two",
      panes: [{ cwd: "/a" }, { cwd: "/b" }],
    });
    savePersistedLayout([single, { ...split, color: "#abc" }]);
    const loaded = loadPersistedLayout()!;
    expect(loaded.map((t) => t.title)).toEqual(["One", "Two"]);
    expect(loaded[0].cwd).toBe("/one");
    expect(loaded[0].panes).toBeUndefined();
    expect(loaded[1].color).toBe("#abc");
    expect(loaded[1].panes?.map((p) => p.cwd)).toEqual(["/a", "/b"]);
    const raw = localStorage.getItem(LAYOUT_KEY)!;
    // Runtime-only data (status, live pane ids) is never persisted.
    expect(raw).not.toContain("status");
    expect(raw).not.toContain('"paneId"');
    expect(raw).not.toContain("-p1");
  });

  it("keeps at most 10 tabs", () => {
    const tabs = Array.from({ length: 14 }, (_, i) => createDefaultTab(`T${i}`));
    savePersistedLayout(tabs);
    expect(loadPersistedLayout()).toHaveLength(10);
  });

  it.each([
    ["missing", null],
    ["not json", "{oops"],
    ["not an array", '{"a":1}'],
  ])("returns null for a %s layout", (_label, raw) => {
    if (raw !== null) localStorage.setItem(LAYOUT_KEY, raw);
    expect(loadPersistedLayout()).toBeNull();
  });

  it("drops malformed entries instead of failing", () => {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify([null, 42, { title: "Good" }, "x"]));
    expect(loadPersistedLayout()?.map((t) => t.title)).toEqual(["Good"]);
  });
});
