// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalTab } from "../types/terminal";

const windowAt = vi.fn<(x: number, y: number) => Promise<string | null>>();
const detach = vi.fn();
const moveToWindow = vi.fn();

vi.mock("../services/ptyService", () => ({ isTauriAvailable: () => true }));
vi.mock("../services/terminalWindows", () => ({
  terminalWindowAt: (x: number, y: number) => windowAt(x, y),
  terminalWindowName: (label: string) => (label === "main" ? "Main window" : label),
}));
vi.mock("../services/tabHandoff", () => ({
  detachTab: (...args: unknown[]) => detach(...args),
  moveTabToWindow: (...args: unknown[]) => moveToWindow(...args),
}));

const makeTabs = (n: number): TerminalTab[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `t${i + 1}`,
    title: `tab ${i + 1}`,
    status: "connected" as const,
    panes: [{ id: `p${i + 1}`, status: "connected" as const }],
    activePaneId: `p${i + 1}`,
    splitDirection: "none" as const,
  }));

async function setup(tabCount: number) {
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { useTabDetach } = await import("../hooks/useTabDetach");
  type Moves = ReturnType<typeof useTabDetach>;
  const tabsRef = { current: makeTabs(tabCount) };
  const removeTab = vi.fn((id: string) => {
    tabsRef.current = tabsRef.current.filter((t) => t.id !== id);
  });
  const notify = vi.fn();
  const out: { moves: Moves | null } = { moves: null };
  function Harness() {
    out.moves = useTabDetach({ tabsRef, terminalRefs: { current: {} }, removeTab, notify });
    return null;
  }
  const root = createRoot(document.createElement("div"));
  await React.act(async () => root.render(React.createElement(Harness)));
  return { moves: out.moves!, tabsRef, removeTab, notify };
}

describe("moving tabs between windows", () => {
  beforeEach(() => {
    windowAt.mockReset();
    detach.mockReset();
    moveToWindow.mockReset();
  });
  afterEach(() => vi.clearAllMocks());

  it("a tab dropped on another Kai window merges into it instead of opening a new one", async () => {
    windowAt.mockResolvedValue("main");
    moveToWindow.mockResolvedValue({ ok: true, windowLabel: "main" });
    const { moves, removeTab } = await setup(2);
    await moves.detach("t2", 1200, 300);
    expect(windowAt).toHaveBeenCalledWith(1200, 300);
    expect(moveToWindow).toHaveBeenCalledWith(expect.objectContaining({ id: "t2" }), {}, "main");
    expect(detach).not.toHaveBeenCalled();
    expect(removeTab).toHaveBeenCalledWith("t2");
  });

  it("the only tab merges too (removing it then closes its window)", async () => {
    windowAt.mockResolvedValue("main");
    moveToWindow.mockResolvedValue({ ok: true, windowLabel: "main" });
    const { moves, removeTab } = await setup(1);
    await moves.detach("t1", 1200, 300);
    expect(removeTab).toHaveBeenCalledWith("t1");
  });

  it("the only tab dropped on empty desktop stays and says where to drop it", async () => {
    windowAt.mockResolvedValue(null);
    const { moves, removeTab, notify } = await setup(1);
    await moves.detach("t1", 50, 50);
    expect(detach).not.toHaveBeenCalled();
    expect(removeTab).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith("info", expect.stringMatching(/another Kai window/));
  });

  it("dropped away from any window, it still opens a new window", async () => {
    windowAt.mockResolvedValue(null);
    detach.mockResolvedValue({ ok: true, windowLabel: "term-4" });
    const { moves, removeTab } = await setup(2);
    await moves.detach("t2", 600, 400);
    expect(detach).toHaveBeenCalledWith(
      expect.objectContaining({ id: "t2" }),
      {},
      {
        x: 460,
        y: 380,
      }
    );
    expect(removeTab).toHaveBeenCalledWith("t2");
  });

  it("a failed merge keeps the tab and reports why", async () => {
    windowAt.mockResolvedValue("main");
    moveToWindow.mockResolvedValue({ ok: false, reason: "That window is closed." });
    const { moves, removeTab, notify } = await setup(2);
    await moves.detach("t2", 1200, 300);
    expect(removeTab).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith("error", "That window is closed.");
  });

  it("merging a whole window moves every tab in order and stops at the first failure", async () => {
    moveToWindow
      .mockResolvedValueOnce({ ok: true, windowLabel: "main" })
      .mockResolvedValueOnce({ ok: false, reason: "busy" });
    const { moves, removeTab, tabsRef } = await setup(3);
    await moves.moveAllTo("main");
    expect(moveToWindow).toHaveBeenCalledTimes(2);
    expect(removeTab).toHaveBeenCalledTimes(1);
    expect(tabsRef.current.map((t) => t.id)).toEqual(["t2", "t3"]);
  });
});
