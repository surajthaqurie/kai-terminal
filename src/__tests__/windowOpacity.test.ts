// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const platform = { tauri: true, mac: false };
vi.mock("../services/ptyService", () => ({ isTauriAvailable: () => platform.tauri }));
vi.mock("../services/shortcuts", () => ({ isMacPlatform: () => platform.mac }));

import { applyWindowOpacity, windowTransparencySupported } from "../services/windowOpacity";

const root = () => document.documentElement;

beforeEach(() => {
  platform.tauri = true;
  platform.mac = false;
});

afterEach(() => {
  root().classList.remove("win-translucent");
  root().style.removeProperty("--win-alpha");
});

describe("windowTransparencySupported", () => {
  it("is on for the Windows / Linux desktop app only", () => {
    expect(windowTransparencySupported()).toBe(true);
    platform.mac = true;
    expect(windowTransparencySupported()).toBe(false);
    platform.mac = false;
    platform.tauri = false;
    expect(windowTransparencySupported()).toBe(false);
  });
});

describe("applyWindowOpacity", () => {
  it("makes the chrome translucent from the saved opacity", () => {
    applyWindowOpacity(0.6);
    expect(root().classList.contains("win-translucent")).toBe(true);
    expect(root().style.getPropertyValue("--win-alpha")).toBe("0.60");
  });

  it("clamps to the slider's range", () => {
    applyWindowOpacity(0.01);
    expect(root().style.getPropertyValue("--win-alpha")).toBe("0.20");
  });

  it("goes back to an opaque window at 100% (and for junk values)", () => {
    applyWindowOpacity(0.5);
    applyWindowOpacity(1);
    expect(root().classList.contains("win-translucent")).toBe(false);
    expect(root().style.getPropertyValue("--win-alpha")).toBe("");
    applyWindowOpacity(0.5);
    applyWindowOpacity(Number.NaN);
    expect(root().classList.contains("win-translucent")).toBe(false);
    applyWindowOpacity(undefined);
    expect(root().classList.contains("win-translucent")).toBe(false);
  });

  it("leaves the chrome opaque where the window cannot be see-through", () => {
    platform.mac = true;
    applyWindowOpacity(0.5);
    expect(root().classList.contains("win-translucent")).toBe(false);
    expect(root().style.getPropertyValue("--win-alpha")).toBe("");
  });
});
