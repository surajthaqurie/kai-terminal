// @vitest-environment jsdom
import { createElement, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../services/settingsService";
import type { ShellProfile } from "../types/terminal";

/**
 * PERF-11: the Search, Serialize and Image add-ons (about 50 kB gzip of the app chunk) are fetched
 * when first used instead of before the first terminal paints. Nothing visible changes: search
 * still works from the first keystroke, a tab can still be moved to another window, and inline
 * images still load.
 */
const log: string[] = [];
const notes: string[] = [];
/** Where the backend says the shell opened (it replaces a missing folder by its parent). */
let openedIn = "/";
const createCalls: Array<{ shell_path?: string; args?: string[] }> = [];
let listenerDelayMs = 0;

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
  }
  loadAddon() {}
  open() {}
  write(_data: string, cb?: () => void) {
    if (cb) queueMicrotask(cb);
  }
  writeln(line?: string) {
    if (line) notes.push(line);
  }
  resize() {}
  onData() {
    return { dispose() {} };
  }
  attachCustomKeyEventHandler() {}
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
const loaded = vi.hoisted(() => ({
  search: 0,
  serialize: 0,
  image: 0,
  findNext: [] as string[],
  serialized: 0,
}));
vi.mock("@xterm/addon-image", () => ({
  ImageAddon: class {
    constructor() {
      loaded.image += 1;
    }
  },
}));
vi.mock("@xterm/addon-search", () => ({
  SearchAddon: class {
    constructor() {
      loaded.search += 1;
    }
    onDidChangeResults() {
      return { dispose() {} };
    }
    findNext(term: string) {
      loaded.findNext.push(term);
      return true;
    }
    findPrevious() {
      return true;
    }
    clearDecorations() {}
  },
}));
vi.mock("@xterm/addon-serialize", () => ({
  SerializeAddon: class {
    constructor() {
      loaded.serialize += 1;
    }
    serialize() {
      loaded.serialized += 1;
      return "SNAPSHOT";
    }
  },
}));
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
const slowListener = () =>
  new Promise<() => void>((resolve) =>
    setTimeout(() => {
      log.push("listener-ready");
      resolve(() => {});
    }, listenerDelayMs)
  );

vi.mock("../services/ptyService", () => ({
  isTauriAvailable: () => true,
  ptyService: {
    onPtyOutput: () => slowListener(),
    onPtyExit: async () => () => {},
    onPtyCwd: async () => () => {},
    resizePty: vi.fn(async () => {}),
    closePty: vi.fn(async () => {}),
  },
  PtyService: {
    createPty: vi.fn(async (req: { shell_path?: string; args?: string[]; cwd?: string }) => {
      log.push("create_pty");
      createCalls.push(req);
      return {
        id: "pty-1",
        pid: 1,
        shell_path: "sh",
        cwd: openedIn,
        cols: 80,
        rows: 24,
        status: "Connected",
      };
    }),
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
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, value: 800 });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, value: 400 });
  log.length = 0;
  Object.assign(loaded, { search: 0, serialize: 0, image: 0, findNext: [], serialized: 0 });
  notes.length = 0;
  openedIn = "/";
  createCalls.length = 0;
  listenerDelayMs = 0;
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

const tick = (ms = 0) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));
const PWSH: ShellProfile = {
  id: "pwsh",
  name: "PowerShell 7",
  path: "/opt/pwsh/pwsh",
  args: ["-NoProfile"],
  is_default: false,
  is_wsl: false,
};

async function render() {
  const { TerminalView } = await import("../components/TerminalView");
  const ref = createRef<import("../components/TerminalView").TerminalViewRef>();
  await act(async () => {
    root.render(
      createElement(TerminalView, {
        ref,
        sessionId: "pane-1",
        visible: true,
        selectedShell: PWSH,
        settings: { ...DEFAULT_SETTINGS },
        onSessionStatusChange: vi.fn(),
        onExit: vi.fn(),
      })
    );
  });
  return ref;
}

describe("add-ons that are not needed to start", () => {
  it("search is not loaded until the search bar is first opened, then only once", async () => {
    const ref = await render();
    await tick(200);
    expect(loaded.search).toBe(0);

    await act(async () => ref.current!.toggleSearch());
    await tick(20);
    expect(loaded.search).toBe(1);

    await act(async () => ref.current!.toggleSearch()); // close
    await act(async () => ref.current!.toggleSearch()); // open again
    await tick(20);
    expect(loaded.search).toBe(1);
  });

  it("serialize is not loaded until a tab is moved, and then a snapshot is still taken", async () => {
    const ref = await render();
    await tick(200); // the shell is up
    expect(loaded.serialize).toBe(0);

    const capture = await ref.current!.handoffCapture();
    expect(loaded.serialize).toBe(1);
    expect(loaded.serialized).toBe(1);
    expect(capture?.snapshot).toBe("SNAPSHOT");

    await ref.current!.handoffCapture();
    expect(loaded.serialize).toBe(1); // loaded once per pane
  });

  it("inline images are loaded right after the pane is up", async () => {
    await render();
    await tick(100);
    expect(loaded.image).toBe(1);
  });

  it("an add-on that finishes loading after the pane was closed is dropped", async () => {
    const ref = await render();
    await tick(200);
    const pending = ref.current!.handoffCapture(); // starts loading serialize
    await act(async () => root.unmount());
    await pending; // must settle, not throw
    expect(loaded.serialized).toBeLessThanOrEqual(1);
    root = createRoot(host); // so afterEach can unmount
  });
});
