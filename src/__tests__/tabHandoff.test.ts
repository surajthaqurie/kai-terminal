import { describe, expect, it, vi } from "vitest";
import {
  buildTabSeed,
  detachTab,
  tabFromSeed,
  type HandoffDeps,
  type HandoffTerminal,
  type PaneCapture,
} from "../services/tabHandoff";
import type { HandoffRelease } from "../services/terminalWindows";
import type { TerminalTab } from "../types/terminal";

const tab = (panes: string[] = ["p1"]): TerminalTab => ({
  id: "t1",
  title: "api",
  color: "#ef4444",
  shellPath: "/bin/zsh",
  cwd: "/work/api",
  status: "connected",
  panes: panes.map((id) => ({
    id,
    shellPath: "/bin/zsh",
    cwd: `/work/${id}`,
    status: "connected" as const,
  })),
  activePaneId: panes[panes.length - 1],
  splitDirection: panes.length > 1 ? "vertical" : "none",
  layout:
    panes.length > 1
      ? {
          kind: "split",
          id: "s1",
          direction: "vertical",
          ratio: 0.4,
          first: { kind: "pane", paneId: panes[0] },
          second: { kind: "pane", paneId: panes[1] },
        }
      : { kind: "pane", paneId: panes[0] },
});

const capture = (ptyId: string): PaneCapture => ({
  ptyId,
  snapshot: `screen-of-${ptyId}`,
  cols: 100,
  rows: 30,
});

const none: HandoffRelease = { data: [], exited: false, exit_code: null };

function terminal(ptyId: string | null, cap: PaneCapture | null = ptyId ? capture(ptyId) : null) {
  return {
    handoffSessionId: vi.fn(() => ptyId),
    handoffCapture: vi.fn(async () => cap),
    handoffRelease: vi.fn(),
    handoffResume: vi.fn(),
  } satisfies HandoffTerminal;
}

function deps(over: Partial<HandoffDeps> = {}) {
  const calls: string[] = [];
  const d: HandoffDeps = {
    begin: vi.fn(async (ids) => void calls.push(`begin:${ids.join(",")}`)),
    finish: vi.fn(async (id) => {
      calls.push(`finish:${id}`);
      return none;
    }),
    open: vi.fn(async () => {
      calls.push("open");
      return "term-2";
    }),
    settle: vi.fn(async () => void calls.push("settle")),
    ...over,
  };
  return { d, calls };
}

describe("tab seed", () => {
  it("carries the layout, colour, folders and the running shell of each pane", () => {
    const seed = buildTabSeed(tab(["a", "b"]), new Map([["a", capture("pty-a")]]));
    expect(seed).toMatchObject({
      title: "api",
      color: "#ef4444",
      activePaneId: "b",
      splitDirection: "vertical",
    });
    expect(seed.layout).toMatchObject({ kind: "split", ratio: 0.4 });
    expect(seed.panes[0]).toMatchObject({ id: "a", cwd: "/work/a", adopt: capture("pty-a") });
    // A pane with no running shell restarts over there (same folder and shell).
    expect(seed.panes[1]).toMatchObject({ id: "b", cwd: "/work/b", shellPath: "/bin/zsh" });
    expect(seed.panes[1].adopt).toBeUndefined();
  });

  it("rebuilds a tab whose panes attach to their running shells", () => {
    const seed = buildTabSeed(tab(["a", "b"]), new Map([["a", capture("pty-a")]]));
    const rebuilt = tabFromSeed(seed);
    expect(rebuilt.id).not.toBe("t1");
    expect(rebuilt.panes.map((p) => p.id)).toEqual(["a", "b"]);
    expect(rebuilt.panes.every((p) => p.status === "connecting")).toBe(true);
    expect(rebuilt.panes[0].adopt?.ptyId).toBe("pty-a");
    expect(rebuilt.activePaneId).toBe("b");
    expect(rebuilt.layout).toEqual(seed.layout);
    expect(rebuilt.color).toBe("#ef4444");
  });

  it("falls back to the first pane when the active one is unknown", () => {
    const seed = { ...buildTabSeed(tab(["a", "b"]), new Map()), activePaneId: "gone" };
    expect(tabFromSeed(seed).activePaneId).toBe("a");
  });
});

describe("detachTab", () => {
  it("holds output, captures, opens the window, then lets go, in that order", async () => {
    const { d, calls } = deps();
    const term = terminal("pty-a");
    const result = await detachTab(tab(), { p1: term }, { x: 10, y: 20 }, d);

    expect(result).toEqual({ ok: true, windowLabel: "term-2" });
    expect(calls).toEqual(["begin:pty-a", "settle", "open"]);
    const [seed, adopt, at] = (d.open as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(seed.panes[0].adopt).toEqual(capture("pty-a"));
    expect(adopt).toEqual(["pty-a"]);
    expect(at).toEqual({ x: 10, y: 20 });
    // The new window owns the shell: this one lets go without closing it.
    expect(term.handoffRelease).toHaveBeenCalledTimes(1);
    expect(term.handoffResume).not.toHaveBeenCalled();
  });

  it("moves every running pane of a split tab, and restarts the ones that are not running", async () => {
    const { d } = deps();
    const a = terminal("pty-a");
    const b = terminal(null); // never started (hidden tab)
    const result = await detachTab(tab(["a", "b"]), { a, b }, undefined, d);
    expect(result.ok).toBe(true);
    expect(d.begin).toHaveBeenCalledWith(["pty-a"]);
    const seed = (d.open as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(seed.panes[0].adopt).toBeDefined();
    expect(seed.panes[1].adopt).toBeUndefined();
    expect(b.handoffRelease).not.toHaveBeenCalled();
  });

  it("leaves the tab untouched and hands held output back when the window cannot open", async () => {
    const released: HandoffRelease = { data: ["held output"], exited: false, exit_code: null };
    const { d } = deps({
      open: vi.fn(async () => {
        throw new Error("no window");
      }),
      finish: vi.fn(async () => released),
    });
    const term = terminal("pty-a");
    const result = await detachTab(tab(), { p1: term }, undefined, d);

    expect(result).toEqual({ ok: false, reason: "Could not open a new window: no window" });
    expect(term.handoffRelease).not.toHaveBeenCalled();
    expect(d.finish).toHaveBeenCalledWith("pty-a");
    expect(term.handoffResume).toHaveBeenCalledWith(released);
  });

  it("does nothing to the tab when the backend refuses to hold the session", async () => {
    const { d } = deps({
      begin: vi.fn(async () => {
        throw new Error("Session not found");
      }),
    });
    const term = terminal("pty-a");
    const result = await detachTab(tab(), { p1: term }, undefined, d);
    expect(result.ok).toBe(false);
    expect(d.open).not.toHaveBeenCalled();
    expect(term.handoffRelease).not.toHaveBeenCalled();
  });

  it("frees a session that cannot be captured and lets that pane restart over there", async () => {
    const { d } = deps();
    const term = terminal("pty-a", null); // ended while the tab was being captured
    const result = await detachTab(tab(), { p1: term }, undefined, d);
    expect(result.ok).toBe(true);
    expect(d.finish).toHaveBeenCalledWith("pty-a");
    expect(term.handoffResume).toHaveBeenCalledTimes(1);
    expect(term.handoffRelease).not.toHaveBeenCalled();
    expect((d.open as ReturnType<typeof vi.fn>).mock.calls[0][1]).toEqual([]);
    expect((d.open as ReturnType<typeof vi.fn>).mock.calls[0][0].panes[0].adopt).toBeUndefined();
  });

  it("opens a window with no hold at all when no pane has a running shell", async () => {
    const { d } = deps();
    const result = await detachTab(tab(), { p1: terminal(null) }, undefined, d);
    expect(result.ok).toBe(true);
    expect(d.begin).not.toHaveBeenCalled();
    expect(d.settle).not.toHaveBeenCalled();
  });
});

describe("moveTabToWindow (merging back into an open window)", () => {
  it("holds, captures, hands the tab to the target window, then lets go", async () => {
    const { moveTabToWindow } = await import("../services/tabHandoff");
    const t = terminal("pty-1");
    const { d, calls } = deps({
      send: vi.fn(async (target: string) => void calls.push(`send:${target}`)),
    });
    const result = await moveTabToWindow(tab(), { p1: t }, "main", d);
    expect(result).toEqual({ ok: true, windowLabel: "main" });
    expect(calls).toEqual(["begin:pty-1", "settle", "send:main"]);
    expect(d.send).toHaveBeenCalledWith("main", expect.objectContaining({ title: "api" }), [
      "pty-1",
    ]);
    expect(d.open).not.toHaveBeenCalled();
    expect(t.handoffRelease).toHaveBeenCalledTimes(1);
  });

  it("keeps the tab here with its held output when the target window is gone", async () => {
    const { moveTabToWindow } = await import("../services/tabHandoff");
    const t = terminal("pty-1");
    const { d } = deps({
      send: vi.fn(async () => {
        throw new Error("That window is closed.");
      }),
    });
    const result = await moveTabToWindow(tab(), { p1: t }, "term-3", d);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/That window is closed/);
    expect(t.handoffRelease).not.toHaveBeenCalled();
    expect(d.finish).toHaveBeenCalledWith("pty-1");
    expect(t.handoffResume).toHaveBeenCalledWith(none);
  });
});
