import { describe, expect, it, vi } from "vitest";
import {
  ACK_BATCH_BYTES,
  ACK_MAX_DELAY_MS,
  createOutputAcker,
  utf8ByteLength,
  type AckTimers,
} from "../services/outputAcker";

/** Timers the test advances by hand. */
function fakeTimers() {
  let now = 0;
  let next = 1;
  const pending = new Map<number, { at: number; fn: () => void }>();
  const timers: AckTimers = {
    setTimeout: (fn, ms) => {
      const id = next++;
      pending.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout: (handle) => void pending.delete(handle as number),
  };
  return {
    timers,
    advance(ms: number) {
      now += ms;
      for (const [id, t] of [...pending]) {
        if (t.at <= now) {
          pending.delete(id);
          t.fn();
        }
      }
    },
    get pending() {
      return pending.size;
    },
  };
}

describe("utf8ByteLength matches what the backend counts", () => {
  const encoder = new TextEncoder();
  it.each([
    "",
    "plain ascii\r\n",
    "café üñ",
    "€ 中文 ──",
    "emoji \u{1F600}\u{1F4A9} done",
    "\u001b[31mred\u001b[0m",
  ])("%j", (text) => {
    expect(utf8ByteLength(text)).toBe(encoder.encode(text).length);
  });

  it("counts a lone surrogate like the replacement character a UTF-8 encoder emits", () => {
    for (const text of ["\ud800", "a\udc00b", "\ud800x"]) {
      expect(utf8ByteLength(text)).toBe(encoder.encode(text).length);
    }
  });
});

describe("createOutputAcker", () => {
  it("acknowledges at once once a batch is pending", () => {
    const t = fakeTimers();
    const send = vi.fn();
    const acker = createOutputAcker(send, t.timers);
    acker.add(ACK_BATCH_BYTES - 1);
    expect(send).not.toHaveBeenCalled();
    acker.add(1);
    expect(send).toHaveBeenCalledExactlyOnceWith(ACK_BATCH_BYTES);
    expect(t.pending).toBe(0);
  });

  it("acknowledges a small amount shortly after, so it can never be stranded", () => {
    const t = fakeTimers();
    const send = vi.fn();
    const acker = createOutputAcker(send, t.timers);
    acker.add(100);
    acker.add(200);
    t.advance(ACK_MAX_DELAY_MS - 1);
    expect(send).not.toHaveBeenCalled();
    t.advance(1);
    expect(send).toHaveBeenCalledExactlyOnceWith(300); // coalesced into one call
  });

  it("sums what it was given and never sends zero or garbage", () => {
    const t = fakeTimers();
    const send = vi.fn();
    const acker = createOutputAcker(send, t.timers);
    acker.add(0);
    acker.add(-5);
    acker.add(Number.NaN);
    acker.flushNow();
    expect(send).not.toHaveBeenCalled();
    acker.add(10);
    acker.flushNow();
    expect(send).toHaveBeenCalledExactlyOnceWith(10);
    acker.flushNow();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("keeps the credit flowing across many chunks: everything added is eventually sent", () => {
    const t = fakeTimers();
    let total = 0;
    const acker = createOutputAcker((n) => (total += n), t.timers);
    let added = 0;
    for (let i = 0; i < 1000; i++) {
      const n = 1 + ((i * 7919) % 90_000);
      added += n;
      acker.add(n);
      if (i % 3 === 0) t.advance(15);
    }
    t.advance(ACK_MAX_DELAY_MS);
    expect(total).toBe(added);
  });

  it("stops after dispose and survives a failing send", () => {
    const t = fakeTimers();
    const send = vi.fn(() => {
      throw new Error("ipc down");
    });
    const acker = createOutputAcker(send, t.timers);
    acker.add(ACK_BATCH_BYTES);
    expect(send).toHaveBeenCalledTimes(1); // the throw is contained
    acker.add(5);
    acker.dispose();
    t.advance(1000);
    acker.add(ACK_BATCH_BYTES);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
