// @vitest-environment jsdom
import { createElement, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PaneAdoption } from "../types/terminal";
import type { HandoffRelease } from "../services/terminalWindows";

// ---- a small stand-in for xterm: enough surface for TerminalView, records writes ----
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
  written: string[] = [];
  resizes: Array<[number, number]> = [];
  constructor(opts?: Record<string, unknown>) {
    Object.assign(this.options, opts);
    terminals.push(this);
  }
  loadAddon() {}
  open() {}
  write(data: string, cb?: () => void) {
    this.written.push(data);
    if (cb) queueMicrotask(cb);
  }
  writeln(data: string) {
    this.written.push(`${data}\n`);
  }
  resize(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
    this.resizes.push([cols, rows]);
  }
  onData() {
    return { dispose() {} };
  }
  attachCustomKeyEventHandler() {}
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
vi.mock("@xterm/addon-search", () => ({
  SearchAddon: class {
    onDidChangeResults() {
      return { dispose() {} };
    }
  },
}));
vi.mock("@xterm/addon-serialize", () => ({
  SerializeAddon: class {
    serialize(opts?: { scrollback?: number }) {
      return `SNAPSHOT(scrollback=${opts?.scrollback})`;
    }
  },
}));
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

// ---- the backend, as TerminalView sees it ----
type Listener<T> = (payload: T) => void;
const outputListeners = new Set<Listener<{ id: string; data: string }>>();
const exitListeners = new Set<Listener<{ id: string; exit_code?: number | null }>>();
const createPty = vi.fn();
const closePty = vi.fn(async (_id: string) => {});
const finish = vi.fn<(id: string) => Promise<HandoffRelease>>();

vi.mock("../services/ptyService", () => ({
  isTauriAvailable: () => true,
  ptyService: {
    onPtyOutput: async (cb: Listener<{ id: string; data: string }>) => {
      outputListeners.add(cb);
      return () => outputListeners.delete(cb);
    },
    onPtyExit: async (cb: Listener<{ id: string; exit_code?: number | null }>) => {
      exitListeners.add(cb);
      return () => exitListeners.delete(cb);
    },
    onPtyCwd: async () => () => {},
    resizePty: vi.fn(async () => {}),
    closePty: (id: string) => closePty(id),
  },
  PtyService: {
    createPty: (...args: unknown[]) => createPty(...args),
    closePty: (id: string) => closePty(id),
    writeToPty: vi.fn(async () => {}),
    getPtyCwd: vi.fn(async () => null),
    ackOutput: vi.fn(async () => {}),
  },
}));
vi.mock("../services/terminalWindows", () => ({
  handoffFinish: (id: string) => finish(id),
  isSecondaryTerminalWindow: () => false,
}));

// async: React 19 returns a thenable for act() either way, and awaiting it flushes pending
// work; an async callback makes the types say so (@types/react types the sync form as void).
const emitOutput = (id: string, data: string) =>
  act(async () => outputListeners.forEach((l) => l({ id, data })));

const adoption: PaneAdoption = { ptyId: "pty-moved", snapshot: "SCREEN", cols: 120, rows: 40 };
const none: HandoffRelease = { data: [], exited: false, exit_code: null };

let root: Root;
let host: HTMLElement;

beforeEach(() => {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  terminals.length = 0;
  outputListeners.clear();
  exitListeners.clear();
  createPty.mockReset();
  closePty.mockClear();
  finish.mockReset();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

async function mount(props: Record<string, unknown> = {}) {
  const { TerminalView } = await import("../components/TerminalView");
  const ref = createRef<import("../components/TerminalView").TerminalViewRef>();
  const onSessionStatusChange = vi.fn();
  const onExit = vi.fn();
  await act(async () => {
    root.render(
      createElement(TerminalView, {
        ref,
        sessionId: "pane-1",
        visible: true,
        adopt: adoption,
        onSessionStatusChange,
        onExit,
        ...props,
      })
    );
  });
  return { ref, onSessionStatusChange, onExit };
}

const tick = (ms = 0) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));

describe("TerminalView attaching to a shell moved from another window", () => {
  it("redraws the screen, adds what was held, then goes live, without starting a shell", async () => {
    finish.mockResolvedValue({ data: ["held-1", "held-2"], exited: false, exit_code: null });
    const { onSessionStatusChange } = await mount();
    await tick(20);

    expect(createPty).not.toHaveBeenCalled();
    expect(finish).toHaveBeenCalledWith("pty-moved");
    const term = terminals[0];
    // Drawn at the grid the snapshot was taken at, and in order: screen, then held output.
    expect(term.resizes[0]).toEqual([120, 40]);
    expect(term.written.indexOf("SCREEN")).toBeGreaterThanOrEqual(0);
    expect(term.written.indexOf("SCREEN")).toBeLessThan(term.written.indexOf("held-1"));
    expect(term.written.indexOf("held-1")).toBeLessThan(term.written.indexOf("held-2"));
    expect(onSessionStatusChange).toHaveBeenCalledWith("connected");

    // Live output for that session now reaches the terminal.
    await emitOutput("pty-moved", "live-line");
    await tick(300);
    expect(terminals[0].written.join("")).toContain("live-line");
  });

  it("keeps output that arrives while attaching behind the held output", async () => {
    let release!: (r: HandoffRelease) => void;
    finish.mockReturnValue(new Promise<HandoffRelease>((resolve) => (release = resolve)));
    await mount();
    await tick(5);

    // The shell prints while the held output is still on its way.
    await emitOutput("pty-moved", "early-live");
    await act(async () => release({ data: ["held"], exited: false, exit_code: null }));
    await tick(300);

    const all = terminals[0].written.join("|");
    expect(all.indexOf("held")).toBeGreaterThanOrEqual(0);
    expect(all.indexOf("held")).toBeLessThan(all.indexOf("early-live"));
  });

  it("ignores output of other sessions", async () => {
    finish.mockResolvedValue(none);
    await mount();
    await tick(20);
    await emitOutput("some-other-session", "not mine");
    await tick(300);
    expect(terminals[0].written.join("")).not.toContain("not mine");
  });

  it("reports an exit that happened during the move", async () => {
    finish.mockResolvedValue({ data: ["bye"], exited: true, exit_code: 3 });
    const { onExit, onSessionStatusChange } = await mount();
    await tick(20);
    expect(onSessionStatusChange).toHaveBeenCalledWith("disconnected");
    expect(onExit).toHaveBeenCalledWith(3);
  });

  it("closing the pane while it is still attaching ends the moved shell", async () => {
    finish.mockReturnValue(new Promise<HandoffRelease>(() => {}));
    await mount();
    await tick(5);
    await act(async () => root.unmount());
    expect(closePty).toHaveBeenCalledWith("pty-moved");
    root = createRoot(host); // so afterEach can unmount
  });

  it("closes the shell when the pane closes after attaching", async () => {
    finish.mockResolvedValue(none);
    await mount();
    await tick(20);
    await act(async () => root.unmount());
    expect(closePty).toHaveBeenCalledWith("pty-moved");
    root = createRoot(host);
  });

  it("a pane without an adoption still starts its own shell", async () => {
    createPty.mockResolvedValue({ id: "fresh", shell_path: "sh", cwd: "/", cols: 80, rows: 24 });
    await mount({ adopt: undefined });
    await tick(120);
    expect(createPty).toHaveBeenCalledTimes(1);
    expect(finish).not.toHaveBeenCalled();
  });
});

describe("hand-off failure and exit edge cases (REL-08)", () => {
  it("Retry after a failed attach ends the moved shell instead of leaving it running unseen", async () => {
    finish.mockRejectedValue(new Error("window gone"));
    createPty.mockResolvedValue({ id: "fresh", shell_path: "sh", cwd: "/", cols: 80, rows: 24 });
    const { onSessionStatusChange } = await mount();
    await tick(20);
    expect(onSessionStatusChange).toHaveBeenCalledWith("error", "window gone");
    expect(closePty).not.toHaveBeenCalled();

    // The Retry banner re-spawns the pane (resetKey bump) with a brand-new shell.
    await mount({ adopt: undefined, resetKey: 1 });
    await tick(120);
    expect(closePty).toHaveBeenCalledWith("pty-moved");
    expect(createPty).toHaveBeenCalledTimes(1);
  });

  it("reports an exit seen twice (held event + hand-off result) once", async () => {
    let release!: (r: HandoffRelease) => void;
    finish.mockReturnValue(new Promise<HandoffRelease>((resolve) => (release = resolve)));
    const { onExit } = await mount();
    await tick(5);
    // The shell dies while attaching: the pty-exit event is held, and the hand-off result says so too.
    act(() => exitListeners.forEach((l) => l({ id: "pty-moved", exit_code: 2 })));
    await act(async () => release({ data: [], exited: true, exit_code: 2 }));
    await tick(50);
    expect(onExit).toHaveBeenCalledTimes(1);
    expect(onExit).toHaveBeenCalledWith(2);
  });
});

describe("TerminalView handing its shell to another window", () => {
  async function attached() {
    finish.mockResolvedValue(none);
    const mounted = await mount();
    await tick(20);
    return mounted;
  }

  it("knows its session and snapshots the screen with its grid", async () => {
    const { ref } = await attached();
    expect(ref.current!.handoffSessionId()).toBe("pty-moved");
    const cap = await ref.current!.handoffCapture();
    expect(cap).toMatchObject({
      ptyId: "pty-moved",
      cols: terminals[0].cols,
      rows: terminals[0].rows,
    });
    expect(cap!.snapshot).toContain("SNAPSHOT");
  });

  it("carries the whole scrollback when it is small", async () => {
    const { ref } = await attached();
    terminals[0].options.scrollback = 500;
    expect((await ref.current!.handoffCapture())!.snapshot).toBe("SNAPSHOT(scrollback=500)");
  });

  it("caps the scrollback it carries over", async () => {
    const { ref } = await attached();
    terminals[0].options.scrollback = 100_000;
    const cap = await ref.current!.handoffCapture();
    expect(cap!.snapshot).toBe("SNAPSHOT(scrollback=4000)");
  });

  it("lets go of the session WITHOUT closing it, so the new window keeps the shell", async () => {
    const { ref } = await attached();
    act(() => ref.current!.handoffRelease());
    expect(ref.current!.handoffSessionId()).toBeNull();
    await act(async () => root.unmount());
    expect(closePty).not.toHaveBeenCalled();
    root = createRoot(host);
  });

  it("has nothing to capture once released", async () => {
    const { ref } = await attached();
    act(() => ref.current!.handoffRelease());
    expect(await ref.current!.handoffCapture()).toBeNull();
  });

  it("writes output held during a move that did not happen back into the terminal", async () => {
    const { ref } = await attached();
    act(() =>
      ref.current!.handoffResume({ data: ["kept-1", "kept-2"], exited: false, exit_code: null })
    );
    const text = terminals[0].written.join("");
    expect(text).toContain("kept-1");
    expect(text).toContain("kept-2");
  });
});
