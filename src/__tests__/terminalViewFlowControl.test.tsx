// @vitest-environment jsdom
import { act, createElement, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalViewRef } from "../components/TerminalView";
import type { HandoffRelease } from "../services/terminalWindows";

/**
 * Output flow control, frontend half (PERF-01 / PERF-02).
 *
 * The backend stops the shell once ~1 MiB of output is unacknowledged, so the real
 * TerminalView must acknowledge exactly what it has handed to xterm, and only after
 * xterm has parsed it. Here the real component runs against an xterm stand-in whose
 * write callbacks the test controls.
 */

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
  /** When true, write callbacks wait until `releaseWrites()` (xterm parsing slowly). */
  holdCallbacks = false;
  private held: Array<() => void> = [];
  constructor(opts?: Record<string, unknown>) {
    Object.assign(this.options, opts);
    terminals.push(this);
  }
  loadAddon() {}
  open() {}
  write(data: string, cb?: () => void) {
    this.written.push(data);
    if (!cb) return;
    if (this.holdCallbacks) this.held.push(cb);
    else queueMicrotask(cb);
  }
  releaseWrites() {
    const callbacks = this.held;
    this.held = [];
    callbacks.forEach((cb) => cb());
  }
  writeln(data: string) {
    this.written.push(`${data}\n`);
  }
  resize() {}
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

type Listener<T> = (payload: T) => void;
const outputListeners = new Set<Listener<{ id: string; data: string }>>();
const ackOutput = vi.fn(async (_id: string, _bytes: number) => {});
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
    onPtyOutput: async (cb: Listener<{ id: string; data: string }>) => {
      outputListeners.add(cb);
      return () => outputListeners.delete(cb);
    },
    onPtyExit: async () => () => {},
    onPtyCwd: async () => () => {},
    resizePty: vi.fn(async () => {}),
    closePty: vi.fn(async () => {}),
  },
  PtyService: {
    createPty: (...args: unknown[]) => (createPty as (...a: unknown[]) => unknown)(...args),
    closePty: vi.fn(async () => {}),
    writeToPty: vi.fn(async () => {}),
    getPtyCwd: vi.fn(async () => null),
    ackOutput: (id: string, bytes: number) => ackOutput(id, bytes),
  },
}));
vi.mock("../services/terminalWindows", () => ({
  handoffFinish: vi.fn(),
  isSecondaryTerminalWindow: () => false,
}));

// async: React 19 returns a thenable for act() either way, and awaiting it flushes pending
// work; an async callback makes the types say so (@types/react types the sync form as void).
const emit = (data: string, id = "pty-1") =>
  act(async () => outputListeners.forEach((l) => l({ id, data })));
const tick = (ms = 0) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));
/** Long enough for the 250 ms flush timer, the 40 ms ack timer and the microtask callbacks. */
const settle = () => tick(400);
const acked = () => ackOutput.mock.calls.reduce((sum, [, bytes]) => sum + bytes, 0);

let root: Root;
let host: HTMLElement;

beforeEach(() => {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  terminals.length = 0;
  outputListeners.clear();
  ackOutput.mockClear();
  createPty.mockClear();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await act(async () => root.unmount());
  host.remove();
});

async function mount() {
  const { TerminalView } = await import("../components/TerminalView");
  const ref = createRef<TerminalViewRef>();
  await act(async () => {
    root.render(
      createElement(TerminalView, {
        ref,
        sessionId: "pane-1",
        visible: true,
        onSessionStatusChange: vi.fn(),
        onExit: vi.fn(),
      })
    );
  });
  await tick(150); // spawn timer + create_pty
  return { ref, term: terminals[terminals.length - 1] };
}

describe("TerminalView acknowledges output to the backend (flow control)", () => {
  it("acknowledges exactly the bytes it was sent, once xterm has parsed them", async () => {
    const { term } = await mount();
    expect(createPty).toHaveBeenCalledTimes(1);

    await emit("hello\r\n");
    await settle();

    expect(term.written.join("")).toContain("hello");
    expect(ackOutput).toHaveBeenCalledTimes(1);
    expect(ackOutput).toHaveBeenCalledWith("pty-1", 7);
  });

  it("counts UTF-8 bytes, which is what the backend counted, not UTF-16 units", async () => {
    const { term } = await mount();
    const text = "café 中文 \u{1F600}"; // 1+1+1+2 +1+ 3+3 +1+ 4 = 17 bytes
    await emit(text);
    await settle();
    expect(term.written.join("")).toContain(text);
    expect(acked()).toBe(new TextEncoder().encode(text).length);
  });

  it("does not acknowledge until xterm has finished parsing (that is what paces the shell)", async () => {
    const { term } = await mount();
    const startup = term.written.join("").length; // text the pane printed itself on start
    term.holdCallbacks = true; // xterm is busy

    await emit("x".repeat(100_000));
    await settle();
    expect(term.written.join("").length - startup).toBe(100_000);
    expect(ackOutput).not.toHaveBeenCalled(); // written to xterm, but not parsed yet

    term.holdCallbacks = false;
    await act(async () => term.releaseWrites());
    await settle();
    expect(acked()).toBe(100_000);
  });

  it("acknowledges a whole flood exactly: every byte sent is eventually credited back", async () => {
    const { term } = await mount();
    const startup = term.written.join("").length;
    let sent = 0;
    for (let i = 0; i < 120; i++) {
      const chunk = `line ${i} ${"y".repeat(40_000)}\n`;
      sent += chunk.length;
      await emit(chunk);
      if (i % 7 === 0) await tick(20); // flushes interleave with arrivals
    }
    await settle();
    expect(term.written.join("").length - startup).toBe(sent);
    expect(acked()).toBe(sent);
    // Batched: far fewer acknowledgements than chunks.
    expect(ackOutput.mock.calls.length).toBeLessThan(120);
  });

  it("does not acknowledge output that a window move handed over (the backend never counted it)", async () => {
    const { ref, term } = await mount();
    const released: HandoffRelease = { data: ["held-1", "held-2"], exited: false, exit_code: null };

    await act(async () => ref.current!.handoffResume(released));
    await settle();

    expect(term.written.join("")).toContain("held-1held-2");
    expect(ackOutput).not.toHaveBeenCalled();

    await emit("live\r\n"); // live output after it is acknowledged as usual
    await settle();
    expect(acked()).toBe(6);
  });

  it("ignores output for other sessions, which are not this pane's to acknowledge", async () => {
    await mount();
    await emit("someone else's output", "pty-OTHER");
    await settle();
    expect(ackOutput).not.toHaveBeenCalled();
  });

  it("reports output it had to skip instead of dropping it silently, and still acknowledges it", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { term } = await mount();
    const { MAX_TERMINAL_PENDING_CHARS } = await import("../services/terminalOutputBuffer");
    const flood = "z".repeat(MAX_TERMINAL_PENDING_CHARS + 500_000);

    await emit(flood);
    await settle();

    const shown = term.written.join("");
    expect(shown).toContain("KB of output was skipped"); // visible in the terminal
    expect(error).toHaveBeenCalledWith(expect.stringContaining("terminal output were skipped"));
    expect(acked()).toBe(flood.length); // the backend must not be left waiting for it
  });

  it("acknowledges even if xterm refuses the write, so the shell is never left waiting", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { term } = await mount();
    term.write = () => {
      throw new Error("write data discarded, use flow control to avoid losing data");
    };
    await emit("some output");
    await settle();
    expect(acked()).toBe(11);
  });
});
