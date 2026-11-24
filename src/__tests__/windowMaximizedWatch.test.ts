import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The maximize-state watcher re-reads the state on every resize. A failing read (the window is
 * going away) used to reject inside the resize callback with nobody listening.
 */
let isMaximized: () => Promise<boolean> = async () => false;
let resizeCallback: (() => unknown) | undefined;
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    isMaximized: () => isMaximized(),
    onResized: async (cb: () => unknown) => {
      resizeCallback = cb;
      return () => {};
    },
  }),
}));
vi.mock("../services/ptyService", () => ({ isTauriAvailable: () => true }));
vi.mock("../services/windowLayouts", () => ({ liveTerminalWindowLabels: async () => null }));

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => unhandled.push(reason);
beforeEach(() => {
  unhandled.length = 0;
  process.on("unhandledRejection", onUnhandled);
});
afterEach(() => {
  process.off("unhandledRejection", onUnhandled);
});
const settle = () => new Promise((r) => setTimeout(r, 20));

describe("watchWindowMaximized", () => {
  it("reports the state at start and after a resize", async () => {
    const { watchWindowMaximized } = await import("../services/appWindow");
    const seen: boolean[] = [];
    isMaximized = async () => false;
    await watchWindowMaximized((m) => seen.push(m));
    isMaximized = async () => true;
    resizeCallback!();
    await settle();
    expect(seen).toEqual([false, true]);
  });

  it("a failing read during a resize is not an unhandled rejection", async () => {
    const { watchWindowMaximized } = await import("../services/appWindow");
    const seen: boolean[] = [];
    isMaximized = async () => false;
    await watchWindowMaximized((m) => seen.push(m));
    isMaximized = async () => {
      throw new Error("window closed");
    };
    resizeCallback!();
    await settle();
    expect(unhandled).toEqual([]);
    expect(seen).toEqual([false]); // nothing made up for the failed read
  });
});
