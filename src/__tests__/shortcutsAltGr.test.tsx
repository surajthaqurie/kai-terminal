// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppShortcuts, type AppShortcutHandlers } from "../hooks/useAppShortcuts";
import { DEFAULT_KEYBINDINGS } from "../services/settingsService";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const handlers = {
  // The defaults no longer use Ctrl+Alt (AltGr), but a user can still bind it.
  keybindings: {
    ...DEFAULT_KEYBINDINGS,
    splitHorizontal: "Ctrl+Alt+S",
    nextPane: "Ctrl+Alt+]",
  },
  newTab: vi.fn(),
  closeActiveTab: vi.fn(),
  toggleCommandPalette: vi.fn(),
  toggleSearch: vi.fn(),
  toggleSettings: vi.fn(),
  splitPane: vi.fn(),
  closeActivePane: vi.fn(),
  cycleTab: vi.fn(),
  focusNextPane: vi.fn(),
  focusPrevPane: vi.fn(),
  gotoTab: vi.fn(),
  zoomFont: vi.fn(),
  toggleMusic: vi.fn(),
  musicEvent: vi.fn(),
  reviewChanges: vi.fn(),
} satisfies AppShortcutHandlers;

function Probe() {
  useAppShortcuts(handlers);
  return null;
}

let root: Root;
beforeEach(async () => {
  Object.values(handlers).forEach(
    (h) => typeof h === "function" && "mockClear" in h && h.mockClear()
  );
  root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Probe />));
});
afterEach(() => act(() => root.unmount()));

const press = (init: KeyboardEventInit) => {
  const e = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  act(() => {
    window.dispatchEvent(e);
  });
  return e;
};

describe("AltGr is text input, not a shortcut", () => {
  it("the default bindings avoid Ctrl+Alt entirely", () => {
    for (const binding of Object.values(DEFAULT_KEYBINDINGS)) {
      expect(binding).not.toMatch(/Ctrl\+Alt/);
    }
  });

  // Ctrl+Alt+S is "split horizontal" in this test's custom bindings.
  const CTRL_ALT_S = { code: "KeyS", key: "s", ctrlKey: true, altKey: true };

  it("a real Ctrl+Alt+S still splits the pane", () => {
    const e = press(CTRL_ALT_S);
    expect(handlers.splitPane).toHaveBeenCalledWith("horizontal");
    expect(e.defaultPrevented).toBe(true);
  });

  it("AltGr+S (types 'ś' on a Polish layout) is left to the terminal", () => {
    const e = press({ ...CTRL_ALT_S, key: "ś", modifierAltGraph: true });
    expect(handlers.splitPane).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
  });

  it("AltGr on the physical ']' key (types '~' on a German layout) does not move pane focus", () => {
    const e = press({
      code: "BracketRight",
      key: "~",
      ctrlKey: true,
      altKey: true,
      modifierAltGraph: true,
    });
    expect(handlers.focusNextPane).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
  });

  it("the same physical key without AltGr still triggers next pane", () => {
    press({ code: "BracketRight", key: "]", ctrlKey: true, altKey: true });
    expect(handlers.focusNextPane).toHaveBeenCalledTimes(1);
  });
});
