// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../services/settingsService";
import type { ShellProfile } from "../types/terminal";

/**
 * Cold-start ordering in the real TerminalView:
 *  - FUNC-05: a new pane waits (bounded) for the shell list instead of starting the backend's
 *    default shell while the footer shows the configured one;
 *  - REL-09: a shell never starts before the pane's event listeners exist, or its first prompt
 *    would be emitted to nobody and the pane would stay blank.
 */
const log: string[] = [];
const notes: string[] = [];
/** Where the backend says the shell opened (it replaces a missing folder by its parent). */
let openedIn = "/";
const createCalls: Array<{ shell_path?: string; args?: string[]; cwd?: string }> = [];
let listenerDelayMs = 0;
/** When set, the output listener registers only once this resolves (the test decides when). */
let listenerGate: Promise<void> | null = null;
type CreateReq = { shell_path?: string; args?: string[]; cwd?: string };
/** Per-test override of create_pty (failures, slow spawns). */
let createImpl: ((req: CreateReq, n: number) => Promise<unknown>) | null = null;

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
const slowListener = () =>
  new Promise<() => void>((resolve) => {
    const ready = () => {
      log.push("listener-ready");
      resolve(() => {});
    };
    if (listenerGate) void listenerGate.then(ready);
    else setTimeout(ready, listenerDelayMs);
  });

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
    createPty: vi.fn(async (req: CreateReq) => {
      log.push("create_pty");
      createCalls.push(req);
      if (createImpl) return createImpl(req, createCalls.length);
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
  };
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, value: 800 });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, value: 400 });
  log.length = 0;
  notes.length = 0;
  openedIn = "/";
  createCalls.length = 0;
  listenerDelayMs = 0;
  listenerGate = null;
  createImpl = null;
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

async function render(props: { selectedShell?: ShellProfile; shellsReady?: boolean }) {
  const { TerminalView } = await import("../components/TerminalView");
  await act(async () => {
    root.render(
      createElement(TerminalView, {
        sessionId: "pane-1",
        visible: true,
        settings: { ...DEFAULT_SETTINGS },
        onSessionStatusChange: vi.fn(),
        onExit: vi.fn(),
        ...props,
      })
    );
  });
}

describe("first spawn waits for the configured shell (FUNC-05)", () => {
  it("does not start the default shell while the shell list is still loading", async () => {
    await render({ selectedShell: undefined, shellsReady: false });
    await tick(200); // well past the 60 ms spawn timer
    expect(createCalls).toHaveLength(0);

    await render({ selectedShell: PWSH, shellsReady: true });
    await tick(100);
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0].shell_path).toBe(PWSH.path);
    expect(createCalls[0].args).toEqual(["-NoProfile"]);
  });

  it("gives up waiting after a bounded time and still starts a shell", async () => {
    await render({ selectedShell: undefined, shellsReady: false });
    await tick(900);
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0].shell_path).toBeUndefined(); // backend default, as a last resort
  });

  it("does not wait at all when the shell is already known", async () => {
    await render({ selectedShell: PWSH, shellsReady: true });
    await tick(150);
    expect(createCalls).toHaveLength(1);
  });
});

describe("a shell starts only after the pane listens for its output (REL-09)", () => {
  it("holds create_pty until the Tauri listeners are registered", async () => {
    // A busy main thread on a cold start: the listener registers only when the test says so, so
    // the outcome never depends on how long the machine takes to run the timers (a timed delay
    // made this flaky under load).
    let release!: () => void;
    listenerGate = new Promise<void>((r) => (release = r));
    await render({ selectedShell: PWSH, shellsReady: true });
    await tick(300); // well past the 60 ms spawn timer, well inside the 2 s listener bound
    expect(log).not.toContain("create_pty"); // the spawn is waiting for the listener
    await act(async () => release());
    await tick(100);
    expect(log.indexOf("listener-ready")).toBeGreaterThanOrEqual(0);
    expect(log.indexOf("create_pty")).toBeGreaterThan(log.indexOf("listener-ready"));
  });
});

describe("a missing folder is not replaced silently (FUNC-12)", () => {
  it("tells the user when the shell opened in the parent of the folder the pane asked for", async () => {
    openedIn = "/work/app";
    const { TerminalView } = await import("../components/TerminalView");
    await act(async () => {
      root.render(
        createElement(TerminalView, {
          sessionId: "pane-1",
          visible: true,
          cwd: "/work/app/gone",
          selectedShell: PWSH,
          settings: { ...DEFAULT_SETTINGS },
          onSessionStatusChange: vi.fn(),
          onExit: vi.fn(),
        })
      );
    });
    await tick(200);
    expect(notes.some((n) => n.includes("/work/app/gone") && n.includes("does not exist"))).toBe(
      true
    );
  });

  it("says nothing when the shell opened where it was asked to", async () => {
    openedIn = "/work/app";
    const { TerminalView } = await import("../components/TerminalView");
    await act(async () => {
      root.render(
        createElement(TerminalView, {
          sessionId: "pane-1",
          visible: true,
          cwd: "/work/app",
          selectedShell: PWSH,
          settings: { ...DEFAULT_SETTINGS },
          onSessionStatusChange: vi.fn(),
          onExit: vi.fn(),
        })
      );
    });
    await tick(200);
    expect(notes.filter((n) => n.includes("does not exist"))).toEqual([]);
  });
});

const session = (id: string, cwd = "/") => ({
  id,
  pid: 1,
  shell_path: "sh",
  cwd,
  cols: 80,
  rows: 24,
  status: "Connected",
});

async function renderPane(extra: Record<string, unknown>) {
  const { TerminalView } = await import("../components/TerminalView");
  const onSessionStatusChange = vi.fn();
  const props = {
    sessionId: "pane-1",
    visible: true,
    selectedShell: PWSH,
    shellsReady: true,
    settings: { ...DEFAULT_SETTINGS },
    onSessionStatusChange,
    onExit: vi.fn(),
  };
  const rerender = (more: Record<string, unknown>) =>
    act(async () => {
      root.render(createElement(TerminalView, { ...props, ...extra, ...more }));
    });
  await rerender({});
  return { onSessionStatusChange, rerender };
}

describe("spawn failures and recovery", () => {
  it("a saved folder that no longer exists opens the shell in the default folder, and says so", async () => {
    createImpl = async (req) => {
      if (req.cwd)
        throw new Error("Invalid working directory: Working directory '/gone' does not exist");
      return session("pty-home", "/home/me");
    };
    const { onSessionStatusChange } = await renderPane({ cwd: "/gone" });
    await tick(200);
    expect(createCalls.map((c) => c.cwd)).toEqual(["/gone", undefined]);
    expect(notes.some((n) => n.includes("/gone"))).toBe(true);
    expect(onSessionStatusChange).toHaveBeenLastCalledWith("connected");
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it("a spawn failure shows the error overlay and reports the error status", async () => {
    createImpl = async () => {
      throw new Error("shell binary not found");
    };
    const { onSessionStatusChange } = await renderPane({});
    await tick(200);
    expect(createCalls).toHaveLength(1); // not a folder problem: no second attempt
    const alert = host.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("shell binary not found");
    expect(notes.some((n) => n.includes("Shell failed to start"))).toBe(true);
    expect(onSessionStatusChange).toHaveBeenLastCalledWith("error", "shell binary not found");
  });

  it("a failure in the default folder too reaches the error overlay", async () => {
    createImpl = async (req) => {
      throw new Error(
        req.cwd
          ? "Invalid working directory: Working directory '/gone' does not exist"
          : "spawn failed"
      );
    };
    await renderPane({ cwd: "/gone" });
    await tick(200);
    expect(createCalls).toHaveLength(2);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("spawn failed");
  });

  it("Retry (resetKey) closes the failed state and starts a working shell", async () => {
    createImpl = async (_req, n) => {
      if (n === 1) throw new Error("first try failed");
      return session("pty-2");
    };
    const { onSessionStatusChange, rerender } = await renderPane({ resetKey: 0 });
    await tick(200);
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    await rerender({ resetKey: 1 });
    await tick(100);
    expect(createCalls).toHaveLength(2);
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(onSessionStatusChange).toHaveBeenLastCalledWith("connected");
  });

  it("a shell whose spawn was overtaken by a newer one is closed, not left running", async () => {
    const { PtyService } = await import("../services/ptyService");
    const closePty = vi.mocked(PtyService.closePty);
    closePty.mockClear();
    let releaseFirst!: () => void;
    createImpl = (_req, n) =>
      n === 1
        ? new Promise((resolve) => (releaseFirst = () => resolve(session("pty-old"))))
        : Promise.resolve(session("pty-new"));
    const { rerender } = await renderPane({ resetKey: 0 });
    await tick(150); // the first spawn is in flight
    expect(createCalls).toHaveLength(1);
    await rerender({ resetKey: 1 }); // Retry while it is still starting
    await tick(100);
    expect(createCalls).toHaveLength(2);
    releaseFirst();
    await tick(50);
    expect(closePty).toHaveBeenCalledWith("pty-old");
    expect(closePty).not.toHaveBeenCalledWith("pty-new");
  });
});
