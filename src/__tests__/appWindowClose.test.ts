import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * FUNC-07: closing a window while other terminal windows stay open makes it forget its layout
 * (it was closed on purpose); closing the last one, which ends the app, keeps it for next launch.
 */
let live: string[] | null = [];
const invoke = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock("../services/ptyService", () => ({ isTauriAvailable: () => true }));
vi.mock("../services/windowLayouts", () => ({ liveTerminalWindowLabels: async () => live }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

beforeEach(() => invoke.mockClear());

describe("closeAppWindow and individual-close handlers", () => {
  it("runs the handlers when other terminal windows stay open, before closing", async () => {
    const { closeAppWindow, onIndividualWindowClose } = await import("../services/appWindow");
    const order: string[] = [];
    invoke.mockImplementationOnce(async () => void order.push("close"));
    const off = onIndividualWindowClose(() => order.push("forget"));
    live = ["main", "term-2"];
    expect(await closeAppWindow()).toBe(true);
    expect(order).toEqual(["forget", "close"]);
    off();
  });

  it("does not run them when this is the last window (closing it ends the app)", async () => {
    const { closeAppWindow, onIndividualWindowClose } = await import("../services/appWindow");
    const handler = vi.fn();
    const off = onIndividualWindowClose(handler);
    live = ["main"];
    await closeAppWindow();
    expect(handler).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledWith("close_app_window");
    off();
  });

  it("keeps the layout when the open windows cannot be read", async () => {
    const { closeAppWindow, onIndividualWindowClose } = await import("../services/appWindow");
    const handler = vi.fn();
    const off = onIndividualWindowClose(handler);
    live = null;
    await closeAppWindow();
    expect(handler).not.toHaveBeenCalled();
    off();
  });

  it("a failing handler does not stop the close or the other handlers", async () => {
    const { closeAppWindow, onIndividualWindowClose } = await import("../services/appWindow");
    const second = vi.fn();
    const offA = onIndividualWindowClose(() => {
      throw new Error("boom");
    });
    const offB = onIndividualWindowClose(second);
    live = ["main", "term-2"];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await closeAppWindow()).toBe(true);
    expect(second).toHaveBeenCalled();
    warn.mockRestore();
    offA();
    offB();
  });
});
