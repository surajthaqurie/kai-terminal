import { describe, it, expect, vi } from "vitest";
import {
  PTY_WRITE_CHUNK_BYTES,
  createPtyWriteQueue,
  splitUtf8Chunks,
} from "../services/ptyWriteQueue";
import { preparePasteText } from "../services/terminalModes";

const enc = new TextEncoder();
const byteLen = (s: string) => enc.encode(s).length;

function isLoneSurrogateEdge(s: string): boolean {
  const first = s.charCodeAt(0);
  const last = s.charCodeAt(s.length - 1);
  return (first >= 0xdc00 && first <= 0xdfff) || (last >= 0xd800 && last <= 0xdbff);
}

describe("splitUtf8Chunks", () => {
  it("returns small payloads as a single chunk", () => {
    expect(splitUtf8Chunks("ls -la\r")).toEqual(["ls -la\r"]);
    expect(splitUtf8Chunks("")).toEqual([""]);
  });

  it("stays under the 1 MB backend ceiling by default", () => {
    expect(PTY_WRITE_CHUNK_BYTES).toBeLessThan(1_048_576);
  });

  it("cuts ASCII exactly at the byte limit", () => {
    const chunks = splitUtf8Chunks("a".repeat(25), 10);
    expect(chunks).toEqual(["a".repeat(10), "a".repeat(10), "a".repeat(5)]);
  });

  it("measures UTF-8 bytes, not UTF-16 length", () => {
    // "é" is 1 UTF-16 unit but 2 bytes; 6 of them = 12 bytes.
    const chunks = splitUtf8Chunks("é".repeat(6), 10);
    expect(chunks).toEqual(["é".repeat(5), "é"]);
    for (const c of chunks) expect(byteLen(c)).toBeLessThanOrEqual(10);
  });

  it("never splits a 3-byte character across chunks", () => {
    // "ab" + 3-byte CJK chars: a cut at 10 bytes would land mid-char.
    const text = "ab" + "世".repeat(5); // 2 + 15 = 17 bytes
    const chunks = splitUtf8Chunks(text, 10);
    expect(chunks).toEqual(["ab世世", "世世世"]);
    expect(chunks.join("")).toBe(text);
  });

  it("never splits a surrogate pair (4-byte emoji)", () => {
    const text = "x" + "🚀".repeat(10); // 1 + 40 bytes
    const chunks = splitUtf8Chunks(text, 10);
    for (const c of chunks) {
      expect(byteLen(c)).toBeLessThanOrEqual(10);
      expect(isLoneSurrogateEdge(c)).toBe(false);
    }
    expect(chunks.join("")).toBe(text);
    expect(chunks[0]).toBe("x🚀🚀");
  });

  it("round-trips a mixed multi-megabyte payload byte-exactly", () => {
    const unit = "🚀 \x1b[32mHello\x1b[0m 漢字 café\r";
    const text = unit.repeat(120_000); // several MB
    const chunks = splitUtf8Chunks(text);
    expect(chunks.length).toBeGreaterThan(4);
    let total = 0;
    for (const c of chunks) {
      const n = byteLen(c);
      expect(n).toBeLessThanOrEqual(PTY_WRITE_CHUNK_BYTES);
      expect(isLoneSurrogateEdge(c)).toBe(false);
      total += n;
    }
    expect(chunks.join("")).toBe(text);
    expect(total).toBe(byteLen(text));
  });

  it("keeps bracketed-paste markers around the whole paste, not each chunk", () => {
    const prepared = preparePasteText("line\n".repeat(200_000), true); // ~1 MB
    const chunks = splitUtf8Chunks(prepared);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].startsWith("\x1b[200~")).toBe(true);
    expect(chunks[chunks.length - 1].endsWith("\x1b[201~")).toBe(true);
    const joined = chunks.join("");
    expect(joined.split("\x1b[200~").length - 1).toBe(1);
    expect(joined.split("\x1b[201~").length - 1).toBe(1);
  });
});

/** A controllable fake `invoke` that records calls and resolves on demand. */
function deferredSend() {
  const calls: { id: string; data: string; resolve: () => void; reject: (e: unknown) => void }[] =
    [];
  const send = vi.fn(
    (id: string, data: string) =>
      new Promise<void>((resolve, reject) => {
        calls.push({ id, data, resolve, reject });
      })
  );
  return { send, calls };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("createPtyWriteQueue", () => {
  it("sends chunks sequentially, awaiting each before the next (backpressure)", async () => {
    const { send, calls } = deferredSend();
    const write = createPtyWriteQueue(send, 10);
    const done = write("t1", "a".repeat(25));
    await flush();
    expect(calls.map((c) => c.data)).toEqual(["a".repeat(10)]);
    calls[0].resolve();
    await flush();
    expect(calls).toHaveLength(2);
    calls[1].resolve();
    await flush();
    calls[2].resolve();
    await expect(done).resolves.toBeUndefined();
    expect(calls.map((c) => c.data).join("")).toBe("a".repeat(25));
  });

  it("orders a write issued mid-paste after the whole paste for the same terminal", async () => {
    const { send, calls } = deferredSend();
    const write = createPtyWriteQueue(send, 10);
    const paste = write("t1", "p".repeat(20));
    const key = write("t1", "K");
    await flush();
    expect(calls.map((c) => c.data)).toEqual(["p".repeat(10)]);
    calls[0].resolve();
    await flush();
    expect(calls.map((c) => c.data)).toEqual(["p".repeat(10), "p".repeat(10)]);
    calls[1].resolve();
    await flush();
    expect(calls.map((c) => c.data)).toEqual(["p".repeat(10), "p".repeat(10), "K"]);
    calls[2].resolve();
    await Promise.all([paste, key]);
  });

  it("does not block other terminals behind a paste in flight", async () => {
    const { send, calls } = deferredSend();
    const write = createPtyWriteQueue(send, 10);
    void write("t1", "p".repeat(20));
    void write("t2", "K");
    await flush();
    expect(calls.map((c) => `${c.id}:${c.data}`)).toEqual([`t1:${"p".repeat(10)}`, "t2:K"]);
  });

  it("stops sending after a failed chunk and rejects once with that error", async () => {
    const { send, calls } = deferredSend();
    const write = createPtyWriteQueue(send, 10);
    const done = write("t1", "a".repeat(35));
    const onError = vi.fn();
    done.catch(onError);
    await flush();
    calls[0].resolve();
    await flush();
    calls[1].reject(new Error("PTY session not found"));
    await flush();
    await flush();
    expect(calls).toHaveLength(2); // chunks 3 and 4 never sent
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toBeInstanceOf(Error);
    expect((onError.mock.calls[0][0] as Error).message).toBe("PTY session not found");
  });

  it("still runs later writes after an earlier one failed", async () => {
    const send = vi
      .fn<(id: string, data: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue(undefined);
    const write = createPtyWriteQueue(send, 10);
    const first = write("t1", "x");
    const second = write("t1", "y");
    await expect(first).rejects.toThrow("boom");
    await expect(second).resolves.toBeUndefined();
    expect(send.mock.calls.map((c) => c[1])).toEqual(["x", "y"]);
  });
});
