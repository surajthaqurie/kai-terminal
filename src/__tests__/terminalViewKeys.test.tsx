// @vitest-environment jsdom
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../services/settingsService";

/**
 * FUNC-10: in the terminal's own key handler, AltGr (reported as Ctrl+Alt on Windows) must reach
 * the shell as the character it types instead of being taken as Ctrl+Shift+C / V.
 */
let keyHandler: ((e: KeyboardEvent) => boolean) | undefined;
let dataHandler: ((data: string) => void) | undefined;
const oscHandlers = new Map<number, (data: string) => boolean>();
const backendCwd = vi.fn(async (_id: string): Promise<string | null> => "/backend/says");

class FakeTerm {
  cols = 80;
  rows = 24;
  options: Record<string, unknown> = { scrollback: 1000 };
  element: HTMLElement | undefined = undefined;
  textarea: HTMLTextAreaElement | undefined = undefined;
  unicode = { activeVersion: "6" };
  modes = { bracketedPasteMode: false };
  buffer = { active: { type: "normal" } };
  parser = {
    registerOscHandler: (id: number, handler: (data: string) => boolean) => {
      oscHandlers.set(id, handler);
      return { dispose() {} };
    },
  };
  constructor(opts?: Record<string, unknown>) {
    Object.assign(this.options, opts);
  }
  loadAddon() {}
  open() {}
  write(_data: string, cb?: () => void) {
    if (cb) queueMicrotask(cb);
  }
  writeln() {}
  resize() {}
  onData(h: (data: string) => void) {
    dataHandler = h;
    return { dispose() {} };
  }
  attachCustomKeyEventHandler(h: (e: KeyboardEvent) => boolean) {
    keyHandler = h;
  }
  refresh() {}
  clearTextureAtlas() {}
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
    fit() {}
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
    constructor() {}
    onContextLoss(handler: () => void) {
      void handler;
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
    writeToPty: vi.fn(async () => {}),
  },
  PtyService: {
    createPty: vi.fn(async () => {
      return {
        id: "pty-1",
        pid: 1,
        shell_path: "sh",
        cwd: "/",
        cols: 80,
        rows: 24,
        status: "Connected",
      };
    }),
    closePty: vi.fn(async () => {}),
    writeToPty: vi.fn(async () => {}),
    getPtyCwd: (id: string) => backendCwd(id),
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
  keyHandler = undefined;
  dataHandler = undefined;
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, value: 800 });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, value: 400 });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  Reflect.deleteProperty(HTMLElement.prototype, "clientWidth");
  Reflect.deleteProperty(HTMLElement.prototype, "clientHeight");
});

async function mountTerminal(extra: Record<string, unknown> = {}) {
  const { TerminalView } = await import("../components/TerminalView");
  await act(async () => {
    root.render(
      createElement(TerminalView, {
        sessionId: "pane-1",
        visible: true,
        settings: { ...DEFAULT_SETTINGS },
        onSessionStatusChange: vi.fn(),
        onExit: vi.fn(),
        ...extra,
      })
    );
  });
  expect(keyHandler).toBeDefined();
  return keyHandler!;
}

function key(init: KeyboardEventInit & { altGraph?: boolean }): KeyboardEvent {
  const e = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  const altGraph = init.altGraph === true;
  e.getModifierState = (name: string) => (name === "AltGraph" ? altGraph : false);
  return e;
}

describe("AltGr in the terminal key handler (FUNC-10)", () => {
  it("lets AltGr+Shift+C and AltGr+Shift+V through as typed characters", async () => {
    const handler = await mountTerminal();
    // Windows: AltGr arrives as Ctrl+Alt with the AltGraph modifier on.
    for (const code of ["KeyC", "KeyV"]) {
      const e = key({
        key: code.slice(3),
        code,
        ctrlKey: true,
        altKey: true,
        shiftKey: true,
        altGraph: true,
      });
      expect(handler(e), code).toBe(true); // true = xterm keeps the key
    }
  });

  it("still treats a real Ctrl+Shift+V as paste (swallowed, not typed)", async () => {
    const handler = await mountTerminal();
    expect(handler(key({ key: "V", code: "KeyV", ctrlKey: true, shiftKey: true }))).toBe(false);
  });
});

describe("folder reports from the shell (SEC-12)", () => {
  const settle = (ms = 150) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));

  it.each([
    ["OSC 7", 7, "file://evil-host/C:/Users/victim/.ssh"],
    ["OSC 9;9", 9, "9;C:/Users/victim/Documents"],
  ])(
    "%s is a signal; the folder is the backend's, not the payload's",
    async (_name, id, payload) => {
      const onCwdResolved = vi.fn();
      await mountTerminal({ onCwdResolved });
      await settle(); // the shell has started
      onCwdResolved.mockClear();
      backendCwd.mockClear();

      // What `cat evil.txt` or a remote shell can print.
      await act(async () => void oscHandlers.get(id as number)!(payload as string));
      await settle(900); // past the settle delay that holds a changed folder back

      expect(backendCwd).toHaveBeenCalled();
      expect(onCwdResolved.mock.calls.map(([p]) => p)).toEqual(["/backend/says"]);
    }
  );

  it("the idle 5 s poll of an unchanged folder does not make the app refresh git", async () => {
    // Only intervals are faked; the pane's own timers run for real.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const onCwdResolved = vi.fn();
      await mountTerminal({ onCwdResolved });
      await settle();
      // The first poll finds the folder the backend reports and the app takes it over once.
      await act(async () => void vi.advanceTimersByTime(5000));
      await settle(900);
      onCwdResolved.mockClear();

      // Now nothing changes: four more polls over 20 s must tell the app nothing.
      for (let i = 0; i < 4; i++) {
        await act(async () => void vi.advanceTimersByTime(5000));
        await settle(50);
      }
      expect(backendCwd.mock.calls.length).toBeGreaterThanOrEqual(4); // it did poll
      expect(onCwdResolved).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("OSC 9 sequences that are not folder reports do nothing", async () => {
    await mountTerminal({ onCwdResolved: vi.fn() });
    await settle();
    backendCwd.mockClear();
    await act(async () => void oscHandlers.get(9)!("4;1;50")); // progress report
    await settle();
    expect(backendCwd).not.toHaveBeenCalled();
  });
});

describe("folder probes after a submitted line", () => {
  const settle = (ms = 150) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));

  it("re-reads the backend folder after `cd`, but not after other lines", async () => {
    await mountTerminal({ onCwdResolved: vi.fn() });
    await settle(); // the shell has started
    backendCwd.mockClear();

    await act(async () => dataHandler!("ls\r"));
    await settle(400);
    expect(backendCwd).not.toHaveBeenCalled();

    await act(async () => dataHandler!("cd src\r"));
    await settle(400); // past the first probe (300 ms)
    expect(backendCwd).toHaveBeenCalledWith("pty-1");
  });

  it("a pane closed right after `cd` leaves no probe running", async () => {
    await mountTerminal({ onCwdResolved: vi.fn() });
    await settle();
    backendCwd.mockClear();
    await act(async () => dataHandler!("cd src\r"));
    await act(async () => root.unmount());
    root = createRoot(host); // afterEach unmounts again
    await settle(400);
    expect(backendCwd).not.toHaveBeenCalled();
  });
});
