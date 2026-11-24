import { describe, expect, it, vi } from "vitest";
import { countBusyPanes, describeClose, liveSessionIds } from "../services/closeGuard";

describe("liveSessionIds", () => {
  it("keeps only panes with a live shell, without duplicates", () => {
    const ids: Record<string, string | null> = { a: "s1", b: null, c: "s1", d: "s2" };
    expect(liveSessionIds(["a", "b", "c", "d", "missing"], (p) => ids[p])).toEqual(["s1", "s2"]);
  });
});

describe("countBusyPanes", () => {
  const ids: Record<string, string | null> = { a: "s1", b: "s2", c: null };

  it("does not query the backend when no pane has a live shell", async () => {
    const query = vi.fn(async () => ["x"]);
    expect(await countBusyPanes(["c"], (p) => ids[p], query)).toBe(0);
    expect(await countBusyPanes([], (p) => ids[p], query)).toBe(0);
    expect(query).not.toHaveBeenCalled();
  });

  it("counts the sessions the backend reports as busy", async () => {
    const query = vi.fn(async () => ["s2"]);
    expect(await countBusyPanes(["a", "b", "c"], (p) => ids[p], query)).toBe(1);
    expect(query).toHaveBeenCalledWith(["s1", "s2"]);
  });

  it("treats a failing check as nothing running, so closing is never blocked by it", async () => {
    const query = vi.fn(async () => {
      throw new Error("backend unavailable");
    });
    expect(await countBusyPanes(["a"], (p) => ids[p], query)).toBe(0);
  });
});

describe("describeClose", () => {
  it("names what is being closed and how many commands end", () => {
    expect(describeClose("tab", 1)).toMatchObject({
      title: "Close this tab?",
      confirmLabel: "Close tab",
    });
    expect(describeClose("tab", 1).message).toContain("a command that is still running");
    expect(describeClose("tab", 3).message).toContain("3 commands that are still running");
    expect(describeClose("pane", 1).confirmLabel).toBe("Close pane");
    expect(describeClose("window", 2).message).toContain("closes the window");
    expect(describeClose("workspace", 2).confirmLabel).toBe("Load workspace");
  });
});
