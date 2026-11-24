// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../services/settingsService";
import type { UserSettings } from "../types/terminal";

/**
 * Rendering work in the real TerminalView (PERF-07 / PERF-08):
 *  - a settings object that changed only unrelated things must not rebuild the glyph atlas
 *    or repaint, and a look change does only the work it needs;
 *  - a visible pane that loses its WebGL context gets it back, on a bounded backoff.
 */

const counts = { atlasClears: 0, refreshes: 0, fits: 0, webglCreated: 0 };
const contextLossHandlers: Array<() => void> = [];
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
  attachCustomKeyEventHandler() {}
  refresh() {
    counts.refreshes += 1;
  }
  clearTextureAtlas() {
    counts.atlasClears += 1;
  }
  scrollToBottom() {}
  scrollToTop() {}
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
    fit() {
      counts.fits += 1;
    }
  },
}));
vi.mock("@xterm/addon-image", () => ({ ImageAddon: class {} }));
vi.mock("@xterm/addon-search", () => ({
  SearchAddon: class {
    onDidChangeResults() {
      return { dispose() {} };
    }
  },
}));
vi.mock("@xterm/addon-serialize", () => ({ SerializeAddon: class {} }));
vi.mock("@xterm/addon-unicode11", () => ({ Unicode11Addon: class {} }));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class {} }));
vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: class {
    constructor() {
      counts.webglCreated += 1;
    }
    onContextLoss(handler: () => void) {
      contextLossHandlers.push(handler);
      return { dispose() {} };
    }
    dispose() {}
  },
}));
vi.mock("../services/ptyService", () => ({
  isTauriAvailable: () => true,
  ptyService: {
    onPtyOutput: async () => () => {},
    onPtyExit: async () => () => {},
    onPtyCwd: async () => () => {},
    resizePty: vi.fn(async () => {}),
    closePty: vi.fn(async () => {}),
  },
  PtyService: {
    createPty: vi.fn(async () => ({
      id: "pty-1",
      pid: 1,
      shell_path: "sh",
      cwd: "/",
      cols: 80,
      rows: 24,
      status: "Connected",
    })),
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
  // The pane must have a size for a fit to run.
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, value: 800 });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, value: 400 });
  Object.assign(counts, { atlasClears: 0, refreshes: 0, fits: 0, webglCreated: 0 });
  contextLossHandlers.length = 0;
  terminals.length = 0;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  vi.useRealTimers();
  await act(async () => root.unmount());
  host.remove();
  Reflect.deleteProperty(HTMLElement.prototype, "clientWidth");
  Reflect.deleteProperty(HTMLElement.prototype, "clientHeight");
});

const tick = (ms = 0) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));

async function render(settings: UserSettings, visible = true) {
  const { TerminalView } = await import("../components/TerminalView");
  await act(async () => {
    root.render(
      createElement(TerminalView, {
        sessionId: "pane-1",
        visible,
        settings,
        onSessionStatusChange: vi.fn(),
        onExit: vi.fn(),
      })
    );
  });
}

describe("settings changes repaint only what they affect", () => {
  it("a new settings object with the same terminal look does no repaint, refit or atlas rebuild", async () => {
    await render({ ...DEFAULT_SETTINGS });
    await tick(100);
    const before = { ...counts };

    // Things that are not the terminal's look: a shortcut, the music toggles, ...
    await render({
      ...DEFAULT_SETTINGS,
      keybindings: { ...DEFAULT_SETTINGS.keybindings, newTab: "Ctrl+Alt+Shift+N" },
    });
    await render({ ...DEFAULT_SETTINGS, autoCheckUpdates: !DEFAULT_SETTINGS.autoCheckUpdates });
    await render({ ...DEFAULT_SETTINGS });
    await tick(50);

    expect(counts.atlasClears).toBe(before.atlasClears);
    expect(counts.refreshes).toBe(before.refreshes);
    expect(counts.fits).toBe(before.fits);
  });

  it("a theme change rebuilds the glyph atlas and repaints, but does not refit the grid", async () => {
    await render({ ...DEFAULT_SETTINGS, theme: "kai-dark" });
    await tick(100);
    const before = { ...counts };

    await render({ ...DEFAULT_SETTINGS, theme: "kai-light" });
    await tick(50);

    expect(counts.atlasClears).toBe(before.atlasClears + 1);
    expect(counts.refreshes).toBeGreaterThan(before.refreshes);
    expect(counts.fits).toBe(before.fits); // colours do not change the cell size
    expect((terminals[0].options.theme as { background?: string }).background).toBeTruthy();
  });

  it("a font size change rebuilds glyphs AND refits (cell metrics changed)", async () => {
    await render({ ...DEFAULT_SETTINGS, fontSize: 14 });
    await tick(100);
    const before = { ...counts };

    await render({ ...DEFAULT_SETTINGS, fontSize: 18 });
    await tick(50);

    expect(terminals[0].options.fontSize).toBe(18);
    expect(counts.atlasClears).toBe(before.atlasClears + 1);
    expect(counts.fits).toBeGreaterThan(before.fits);
  });

  it("a cursor or scrollback change applies the option and nothing else", async () => {
    await render({ ...DEFAULT_SETTINGS, cursorBlink: false, scrollback: 5000 });
    await tick(100);
    const before = { ...counts };

    await render({ ...DEFAULT_SETTINGS, cursorBlink: true, scrollback: 20000 });
    await tick(50);

    expect(terminals[0].options.cursorBlink).toBe(true);
    expect(terminals[0].options.scrollback).toBe(20000);
    expect(counts.atlasClears).toBe(before.atlasClears);
    expect(counts.refreshes).toBe(before.refreshes);
    expect(counts.fits).toBe(before.fits);
  });
});

describe("WebGL context loss", () => {
  it("a visible pane gets the GPU renderer back after the context is lost", async () => {
    await render({ ...DEFAULT_SETTINGS }, true);
    await tick(50);
    expect(counts.webglCreated).toBe(1);

    await act(async () => contextLossHandlers[0]()); // the browser took the context away
    expect(counts.webglCreated).toBe(1); // not instantly: give the GPU a moment

    await tick(650); // first retry after 500 ms
    expect(counts.webglCreated).toBe(2);
  });

  it("retries on a bounded backoff and then stops (a GPU that cannot keep a context must not loop)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    await render({ ...DEFAULT_SETTINGS }, true);
    expect(counts.webglCreated).toBe(1);

    const loseLatest = async () => {
      await act(async () => contextLossHandlers[contextLossHandlers.length - 1]());
    };
    await loseLatest();
    await act(async () => void (await vi.advanceTimersByTimeAsync(500)));
    expect(counts.webglCreated).toBe(2);
    await loseLatest();
    await act(async () => void (await vi.advanceTimersByTimeAsync(2000)));
    expect(counts.webglCreated).toBe(3);
    await loseLatest();
    await act(async () => void (await vi.advanceTimersByTimeAsync(8000)));
    expect(counts.webglCreated).toBe(4);

    await loseLatest(); // out of retries
    await act(async () => void (await vi.advanceTimersByTimeAsync(60_000)));
    expect(counts.webglCreated).toBe(4);
  });

  it("a hidden pane does not retry (it re-attaches when it is shown)", async () => {
    await render({ ...DEFAULT_SETTINGS }, true);
    await tick(50);
    expect(counts.webglCreated).toBe(1);

    await render({ ...DEFAULT_SETTINGS }, false); // the tab is switched away
    await tick(20);
    await act(async () => contextLossHandlers[0]());
    await tick(700);
    expect(counts.webglCreated).toBe(1);

    await render({ ...DEFAULT_SETTINGS }, true); // and back
    await tick(50);
    expect(counts.webglCreated).toBe(2);
  });
});
