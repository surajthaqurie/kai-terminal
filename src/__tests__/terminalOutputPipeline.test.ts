import { describe, expect, it, vi } from "vitest";
import {
  FLUSH_FALLBACK_MS,
  MAX_TERM_WRITE_CHARS,
  createTerminalOutputPipeline,
  type OutputScheduler,
  type OutputTerminal,
} from "../services/terminalOutputPipeline";
import type { OutputAcker } from "../services/outputAcker";
import { TerminalOutputBuffer } from "../services/terminalOutputBuffer";

/** xterm stand-in: records writes; callbacks run only when `parse()` is called. */
function fakeTerm(opts: { throwOnWrite?: boolean } = {}) {
  const writes: string[] = [];
  const callbacks: Array<() => void> = [];
  const term = {
    rows: 24,
    write(data: string, cb?: () => void) {
      if (opts.throwOnWrite) throw new Error("disposed");
      writes.push(data);
      if (cb) callbacks.push(cb);
    },
    refresh: vi.fn<(start: number, end: number) => void>(),
    scrollToBottom: vi.fn<() => void>(),
  } satisfies OutputTerminal;
  const parse = () => {
    while (callbacks.length) callbacks.shift()!();
  };
  return { term, writes, parse, callbacks };
}

function fakeScheduler(opts: { rafThrows?: boolean } = {}) {
  let next = 1;
  const rafs = new Map<number, () => void>();
  const timers = new Map<number, { fn: () => void; ms: number }>();
  const scheduler: OutputScheduler = {
    requestAnimationFrame(fn) {
      if (opts.rafThrows) throw new Error("no rAF");
      const id = next++;
      rafs.set(id, fn);
      return id;
    },
    cancelAnimationFrame(id) {
      rafs.delete(id as number);
    },
    setTimeout(fn, ms) {
      const id = next++;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id as number);
    },
  };
  return {
    scheduler,
    rafs,
    timers,
    frame() {
      const fns = [...rafs.values()];
      rafs.clear();
      fns.forEach((f) => f());
    },
    fireTimers() {
      const fns = [...timers.values()];
      timers.clear();
      fns.forEach((t) => t.fn());
    },
  };
}

function recordingAcker() {
  const added: number[] = [];
  const acker: OutputAcker & { disposed: boolean } = {
    disposed: false,
    add: (b) => added.push(b),
    flushNow: () => {},
    dispose() {
      this.disposed = true;
    },
  };
  return { acker, added };
}

function setup(
  opts: { throwOnWrite?: boolean; rafThrows?: boolean; buffer?: TerminalOutputBuffer } = {}
) {
  const t = fakeTerm(opts);
  const s = fakeScheduler(opts);
  const a = recordingAcker();
  const log = vi.fn();
  const pipeline = createTerminalOutputPipeline({
    term: t.term,
    ack: () => {},
    scheduler: s.scheduler,
    acker: a.acker,
    buffer: opts.buffer,
    log,
  });
  return { ...t, ...s, ...a, log, pipeline };
}

describe("terminalOutputPipeline", () => {
  it("coalesces pushes into one write per animation frame", () => {
    const h = setup();
    h.pipeline.push("a");
    h.pipeline.push("b");
    h.pipeline.push("c");
    expect(h.writes).toEqual([]);
    expect(h.rafs.size).toBe(1);
    h.frame();
    expect(h.writes).toEqual(["abc"]);
  });

  it("flushes by timeout when rAF never fires (hidden tab), and only once", () => {
    const h = setup();
    h.pipeline.push("x");
    expect([...h.timers.values()][0].ms).toBe(FLUSH_FALLBACK_MS);
    h.fireTimers();
    expect(h.writes).toEqual(["x"]);
    // The frame callback was cancelled by the flush; a late frame writes nothing more.
    h.frame();
    expect(h.writes).toEqual(["x"]);
  });

  it("a synchronous flush cancels the scheduled frame and timer", () => {
    const h = setup();
    h.pipeline.push("y");
    h.pipeline.flush();
    expect(h.writes).toEqual(["y"]);
    expect(h.rafs.size).toBe(0);
    expect(h.timers.size).toBe(0);
  });

  it("flushes immediately when rAF is unavailable", () => {
    const h = setup({ rafThrows: true });
    h.pipeline.push("z");
    expect(h.writes).toEqual(["z"]);
    expect(h.timers.size).toBe(0);
  });

  it("splits a large flush into slices of at most MAX_TERM_WRITE_CHARS, in order", () => {
    const h = setup();
    const big = "q".repeat(MAX_TERM_WRITE_CHARS * 2 + 10);
    h.pipeline.push(big);
    h.frame();
    expect(h.writes.map((w) => w.length)).toEqual([MAX_TERM_WRITE_CHARS, MAX_TERM_WRITE_CHARS, 10]);
    expect(h.writes.join("")).toBe(big);
    // Only the last slice carries a callback.
    expect(h.callbacks.length).toBe(1);
  });

  it("acknowledges counted bytes only after xterm parsed the last slice", () => {
    const h = setup();
    h.pipeline.push("x".repeat(MAX_TERM_WRITE_CHARS + 5));
    h.frame();
    expect(h.added).toEqual([]);
    h.parse();
    expect(h.added).toEqual([MAX_TERM_WRITE_CHARS + 5]);
  });

  it("counts acknowledgements in UTF-8 bytes, not UTF-16 units", () => {
    const h = setup();
    h.pipeline.push("é😀"); // 2 + 4 bytes
    h.frame();
    h.parse();
    expect(h.added).toEqual([6]);
  });

  it("never acknowledges output that was not counted (window hand-off)", () => {
    const h = setup();
    h.pipeline.push("moved", false);
    h.pipeline.push("live");
    h.pipeline.flush();
    h.parse();
    expect(h.writes).toEqual(["movedlive"]);
    expect(h.added).toEqual([4]);
  });

  it("acknowledges anyway when xterm refuses the write, and logs it", () => {
    const h = setup({ throwOnWrite: true });
    h.pipeline.push("abc");
    h.pipeline.flush();
    expect(h.added).toEqual([3]);
    expect(h.log).toHaveBeenCalledWith(
      "[kai] terminal output could not be written:",
      expect.any(Error)
    );
  });

  it("acknowledges exactly once per flush", () => {
    const h = setup();
    h.pipeline.push("ab");
    h.pipeline.flush();
    h.parse();
    h.pipeline.flush(); // nothing pending, nothing counted
    h.parse();
    expect(h.added).toEqual([2]);
  });

  it("reports output the buffer had to discard instead of losing it silently", () => {
    const h = setup({ buffer: new TerminalOutputBuffer(4) });
    h.pipeline.push("1234");
    h.pipeline.push("5678"); // pushes "1234" out
    h.pipeline.flush();
    expect(h.writes[0]).toContain("KB of output was skipped");
    expect(h.writes[1]).toBe("5678");
    expect(h.log).toHaveBeenCalledWith(
      expect.stringContaining("4 characters of terminal output were skipped")
    );
    // Counted bytes include the dropped ones, so the backend's credit is fully returned.
    h.parse();
    expect(h.added).toEqual([8]);
  });

  it("repaints and snaps to the bottom after a clear-screen chunk is parsed", () => {
    const h = setup();
    h.pipeline.push("\x1b[2J\x1b[Hprompt> ");
    h.frame();
    expect(h.term.refresh).not.toHaveBeenCalled();
    h.parse();
    expect(h.term.refresh).toHaveBeenCalledWith(0, 23);
    expect(h.term.scrollToBottom).toHaveBeenCalled();
  });

  it("does not repaint for ordinary output", () => {
    const h = setup();
    h.pipeline.push("hello\r\n");
    h.frame();
    h.parse();
    expect(h.term.refresh).not.toHaveBeenCalled();
  });

  it("dispose cancels scheduled work, disposes the acker and ignores later output", () => {
    const h = setup();
    h.pipeline.push("late");
    h.pipeline.dispose();
    expect(h.rafs.size).toBe(0);
    expect(h.timers.size).toBe(0);
    expect(h.acker.disposed).toBe(true);
    h.pipeline.push("more");
    h.pipeline.flush();
    h.frame();
    h.fireTimers();
    expect(h.writes).toEqual([]);
  });
});
