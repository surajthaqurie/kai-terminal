// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const platform = { tauri: true, mac: false };
let nativeActive = true;
let emitState: (payload: string) => void = () => {};
const invoke = vi.fn(async (command: string, _args?: unknown) =>
  command === "set_maximize_button_rect" ? nativeActive : undefined
);
const unlisten = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (command: string, args?: unknown) => invoke(command, args),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, cb: (e: { payload: string }) => void) => {
    if (name === "kai-maximize-button-state") emitState = (payload) => cb({ payload });
    return unlisten;
  }),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    isMaximized: async () => false,
    onResized: async () => () => {},
    minimize: async () => {},
    toggleMaximize: async () => {},
  }),
}));
vi.mock("../services/ptyService", () => ({ isTauriAvailable: () => platform.tauri }));
vi.mock("../services/shortcuts", () => ({ isMacPlatform: () => platform.mac }));

import { WindowControls } from "../components/WindowControls";
import { boxOf, reportMaximizeButtonBox, watchMaximizeButtonState } from "../services/appWindow";

const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));

function rectOf(el: Element, box: { left: number; top: number; width: number; height: number }) {
  el.getBoundingClientRect = () =>
    ({
      ...box,
      right: box.left + box.width,
      bottom: box.top + box.height,
      x: box.left,
      y: box.top,
    }) as DOMRect;
}

beforeEach(() => {
  platform.tauri = true;
  platform.mac = false;
  nativeActive = true;
  invoke.mockClear();
  unlisten.mockClear();
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    cb(0);
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("boxOf", () => {
  it("returns the element's box, or null with no layout", () => {
    const el = document.createElement("button");
    expect(boxOf(null)).toBeNull();
    expect(boxOf(el)).toBeNull(); // jsdom: all zeros
    rectOf(el, { left: 10, top: 2, width: 46, height: 30 });
    expect(boxOf(el)).toEqual({ x: 10, y: 2, width: 46, height: 30 });
  });
});

describe("reportMaximizeButtonBox", () => {
  it("sends the box and returns whether Windows owns the pointer there", async () => {
    await expect(reportMaximizeButtonBox({ x: 1, y: 2, width: 46, height: 30 })).resolves.toBe(
      true
    );
    expect(invoke).toHaveBeenCalledWith("set_maximize_button_rect", {
      x: 1,
      y: 2,
      width: 46,
      height: 30,
    });
    nativeActive = false;
    await expect(reportMaximizeButtonBox({ x: 1, y: 2, width: 46, height: 30 })).resolves.toBe(
      false
    );
  });

  it("clears the box with zeros, and does nothing outside the desktop app", async () => {
    await reportMaximizeButtonBox(null);
    expect(invoke).toHaveBeenCalledWith("set_maximize_button_rect", {
      x: 0,
      y: 0,
      width: 0,
      height: 0,
    });
    invoke.mockClear();
    platform.tauri = false;
    await expect(reportMaximizeButtonBox({ x: 1, y: 2, width: 3, height: 4 })).resolves.toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("is false when the backend call fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    invoke.mockRejectedValueOnce(new Error("no such command"));
    await expect(reportMaximizeButtonBox({ x: 1, y: 2, width: 3, height: 4 })).resolves.toBe(false);
  });
});

describe("watchMaximizeButtonState", () => {
  it("passes on known states and ignores anything else", async () => {
    const seen: string[] = [];
    const stop = await watchMaximizeButtonState((s) => seen.push(s));
    emitState("hover");
    emitState("bogus");
    emitState("pressed");
    emitState("none");
    expect(seen).toEqual(["hover", "pressed", "none"]);
    stop();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });
});

describe("<WindowControls /> maximize button", () => {
  let host: HTMLElement;
  let root: Root;

  async function mount() {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root.render(<WindowControls />));
    await flush();
  }

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  const maximize = () => host.querySelector<HTMLButtonElement>('button[aria-label$="window"]');
  const maximizeBtn = () =>
    [...host.querySelectorAll("button")].find((b) => /Maximize|Restore/.test(b.title))!;

  it("reports its box to the app and shows the native hover and pressed look", async () => {
    const proto = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function () {
      return {
        left: 900,
        top: 0,
        width: 46,
        height: 30,
        right: 946,
        bottom: 30,
        x: 900,
        y: 0,
      } as DOMRect;
    };
    try {
      await mount();
    } finally {
      HTMLElement.prototype.getBoundingClientRect = proto;
    }
    expect(maximize()).not.toBeNull();
    expect(invoke).toHaveBeenCalledWith("set_maximize_button_rect", {
      x: 900,
      y: 0,
      width: 46,
      height: 30,
    });
    const btn = maximizeBtn();
    expect(btn.className).toBe("window-control-btn");
    await act(async () => emitState("hover"));
    expect(btn.className).toContain("is-native-hover");
    await act(async () => emitState("pressed"));
    expect(btn.className).toContain("is-native-pressed");
    await act(async () => emitState("none"));
    expect(btn.className).toBe("window-control-btn");
  });

  it("leaves the in-page button alone when Windows does not take over", async () => {
    nativeActive = false;
    await mount();
    await act(async () => emitState("hover")); // a stray event is still shown, then cleared on next report
    window.dispatchEvent(new Event("resize"));
    await flush();
    expect(maximizeBtn().className).toBe("window-control-btn");
  });

  it("clears the box when it unmounts", async () => {
    await mount();
    invoke.mockClear();
    await act(async () => root.unmount());
    expect(invoke).toHaveBeenCalledWith("set_maximize_button_rect", {
      x: 0,
      y: 0,
      width: 0,
      height: 0,
    });
    root = createRoot(host); // so afterEach can unmount a live root
  });

  it("renders nothing, and reports nothing, on macOS", async () => {
    platform.mac = true;
    await mount();
    expect(host.querySelector("button")).toBeNull();
    expect(invoke).not.toHaveBeenCalledWith("set_maximize_button_rect", expect.anything());
  });
});
