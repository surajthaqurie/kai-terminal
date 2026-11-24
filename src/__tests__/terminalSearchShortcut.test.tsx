// @vitest-environment jsdom
import { createElement, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalViewRef } from "../components/TerminalView";
import { DEFAULT_SETTINGS } from "../services/settingsService";
import type { UserSettings } from "../types/terminal";

/**
 * FUNC-01: Ctrl+Shift+F toggled the search bar twice when the terminal had focus
 * (once in xterm's custom key handler, once in App's window handler, because
 * returning `false` from the xterm handler does not cancel the event), so the
 * documented shortcut appeared dead.
 *
 * These tests mount the REAL TerminalView (with a stand-in for xterm) next to
 * the REAL useAppShortcuts hook and push one keystroke through both, in the
 * order the browser does: xterm's handler first, then the bubbled window event.
 */

// ---- a stand-in for xterm that exposes the registered key handler ----
const terminals: FakeTerm[] = [];
class FakeTerm {
  cols = 80;
  rows = 24;
  options: Record<string, unknown> = { scrollback: 1000 };
  element: HTMLElement | undefined = undefined;
  textarea: HTMLTextAreaElement | undefined = undefined;
  unicode = { activeVersion: "6" };
  modes = { bracketedPasteMode: false };
  buffer = { active: { type: "normal" } };
  parser = { registerOscHandler: () => ({ dispose() {} }) };
  keyHandler: ((event: KeyboardEvent) => boolean) | null = null;
  constructor(opts?: Record<string, unknown>) {
    Object.assign(this.options, opts);
    terminals.push(this);
  }
  loadAddon() {}
  open() {}
  write(_data: string, cb?: () => void) {
    if (cb) queueMicrotask(cb);
  }
  writeln() {}
  resize() {}
  onData() {
    return { dispose() {} };
  }
  attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean) {
    this.keyHandler = handler;
  }
  refresh() {}
  scrollToBottom() {}
  scrollToTop() {}
  clearTextureAtlas() {}
  clear() {}
  selectAll() {}
  hasSelection() {
    return false;
  }
  getSelection() {
    return "";
  }
  focus() {}
  dispose() {}
}

vi.mock("@xterm/xterm", () => ({ Terminal: FakeTerm }));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {}
  },
}));
vi.mock("@xterm/addon-image", () => ({ ImageAddon: class {} }));
const clearDecorations = vi.fn();
vi.mock("@xterm/addon-search", () => ({
  SearchAddon: class {
    onDidChangeResults() {
      return { dispose() {} };
    }
    clearDecorations() {
      clearDecorations();
    }
  },
}));
vi.mock("@xterm/addon-serialize", () => ({ SerializeAddon: class {} }));
vi.mock("@xterm/addon-unicode11", () => ({ Unicode11Addon: class {} }));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class {} }));
vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: class {
    onContextLoss() {
      return { dispose() {} };
    }
    dispose() {}
  },
}));

// The search bar is lazy-loaded; a marker element is enough to see whether it is open.
vi.mock("../components/SearchBar", () => ({
  SearchBar: () => createElement("div", { "data-testid": "search-bar" }),
}));

const createPty = vi.fn(async () => ({
  id: "pty-1",
  pid: 1,
  shell_path: "sh",
  cwd: "/",
  cols: 80,
  rows: 24,
  status: "Connected",
}));
vi.mock("../services/ptyService", () => ({
  isTauriAvailable: () => true,
  ptyService: {
    onPtyOutput: async () => () => {},
    onPtyExit: async () => () => {},
    onPtyCwd: async () => () => {},
    resizePty: vi.fn(async () => {}),
    closePty: vi.fn(async () => {}),
    writeToPty: vi.fn(async () => {}),
  },
  PtyService: {
    createPty: (...args: unknown[]) => (createPty as (...a: unknown[]) => unknown)(...args),
    closePty: vi.fn(async () => {}),
    writeToPty: vi.fn(async () => {}),
    getPtyCwd: vi.fn(async () => null),
    ackOutput: vi.fn(async () => {}),
  },
}));
vi.mock("../services/terminalWindows", () => ({
  handoffFinish: vi.fn(),
  isSecondaryTerminalWindow: () => false,
}));

let root: Root;
let host: HTMLElement;

beforeEach(() => {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  terminals.length = 0;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

const tick = (ms = 0) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));
const searchBarOpen = () => host.querySelector('[data-testid="search-bar"]') !== null;

async function mountWithAppShortcuts(settings?: UserSettings) {
  const { TerminalView } = await import("../components/TerminalView");
  const { useAppShortcuts } = await import("../hooks/useAppShortcuts");
  const noop = () => {};
  const effective = settings ?? DEFAULT_SETTINGS;

  // The same wiring App.tsx has: the window handler's `toggleSearch` calls the pane's.
  function Harness() {
    const ref = useRef<TerminalViewRef>(null);
    useAppShortcuts({
      keybindings: effective.keybindings,
      newTab: noop,
      closeActiveTab: noop,
      toggleCommandPalette: noop,
      toggleSearch: () => ref.current?.toggleSearch(),
      toggleSettings: noop,
      splitPane: noop,
      closeActivePane: noop,
      cycleTab: noop,
      focusNextPane: noop,
      focusPrevPane: noop,
      gotoTab: noop,
      zoomFont: noop,
      toggleMusic: noop,
      musicEvent: noop,
      reviewChanges: noop,
      newWindow: noop,
    });
    return createElement(TerminalView, {
      ref,
      sessionId: "pane-1",
      visible: true,
      settings: effective,
      onSessionStatusChange: vi.fn(),
      onExit: vi.fn(),
    });
  }

  await act(async () => {
    root.render(createElement(Harness));
  });
  await tick(100);
  return terminals[terminals.length - 1];
}

/** One physical keydown: xterm's custom handler first, then the bubbled window listener. */
function pressKey(term: FakeTerm, init: KeyboardEventInit) {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  let sentToShell = true;
  act(() => {
    sentToShell = term.keyHandler ? term.keyHandler(event) : true;
    document.body.dispatchEvent(event); // bubbles up to the window listener
  });
  return { sentToShell, event };
}

const CTRL_SHIFT_F = { ctrlKey: true, shiftKey: true, code: "KeyF", key: "F" };

describe("Ctrl+Shift+F with the terminal focused", () => {
  it("opens the search bar exactly once, and a second press closes it", async () => {
    const term = await mountWithAppShortcuts();
    expect(term.keyHandler).toBeTypeOf("function");
    expect(searchBarOpen()).toBe(false);

    const first = pressKey(term, CTRL_SHIFT_F);
    await tick(20);
    expect(first.sentToShell).toBe(false); // the shell never receives the key
    expect(first.event.defaultPrevented).toBe(true); // handled by the app handler
    expect(searchBarOpen()).toBe(true); // before the fix: toggled twice, so still closed

    clearDecorations.mockClear();
    pressKey(term, CTRL_SHIFT_F);
    await tick(20);
    expect(searchBarOpen()).toBe(false);
    // Closing by the shortcut (not the bar's own button) still removes the highlights.
    expect(clearDecorations).toHaveBeenCalled();
  });

  it("does not hijack the key when search is rebound: the shell gets Ctrl+Shift+F", async () => {
    const rebound: UserSettings = {
      ...DEFAULT_SETTINGS,
      keybindings: { ...DEFAULT_SETTINGS.keybindings, search: "Ctrl+Shift+Y" },
    };
    const term = await mountWithAppShortcuts(rebound);

    const press = pressKey(term, CTRL_SHIFT_F);
    await tick(20);
    expect(press.sentToShell).toBe(true); // native terminal behaviour preserved
    expect(searchBarOpen()).toBe(false);

    const bound = pressKey(term, { ctrlKey: true, shiftKey: true, code: "KeyY", key: "Y" });
    await tick(20);
    expect(bound.sentToShell).toBe(false);
    expect(searchBarOpen()).toBe(true);
  });
});
