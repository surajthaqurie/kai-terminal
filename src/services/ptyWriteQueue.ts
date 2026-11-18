/**
 * Chunked, ordered delivery of frontend writes to a PTY.
 *
 * The backend bounds a single `write_to_pty` IPC call at 1 MB
 * (`MAX_INPUT_WRITE_BYTES` in src-tauri/src/pty.rs). Instead of rejecting
 * larger writes (big pastes), the frontend splits the payload into chunks
 * well under that ceiling and sends them one at a time, awaiting each
 * invoke. That awaiting is the backpressure: the IPC bridge only ever holds
 * one bounded chunk per terminal, so neither it nor the render loop freezes.
 *
 * Chunking is pure flow pacing over the byte stream. A bracketed paste is
 * wrapped (ESC[200~ … ESC[201~) BEFORE it reaches the queue, so the markers
 * land at the very start of the first chunk and the very end of the last one
 * and wrap the whole paste, never each chunk.
 */

/** Per-IPC-call chunk size: comfortably under the 1 MB backend ceiling. */
export const PTY_WRITE_CHUNK_BYTES = 256 * 1024;

/** UTF-8 byte length of the code point starting at `s[i]`, and its UTF-16 width. */
function codePointAt(s: string, i: number): { bytes: number; units: number } {
  const c = s.charCodeAt(i);
  if (c < 0x80) return { bytes: 1, units: 1 };
  if (c < 0x800) return { bytes: 2, units: 1 };
  if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
    const next = s.charCodeAt(i + 1);
    if (next >= 0xdc00 && next <= 0xdfff) return { bytes: 4, units: 2 };
  }
  // BMP char, or a lone surrogate (encoded as U+FFFD: 3 bytes).
  return { bytes: 3, units: 1 };
}

/**
 * Split `text` into pieces whose UTF-8 encoding is at most `maxBytes` each.
 * Cuts only between code points, so a surrogate pair or multibyte character
 * is never split. Concatenating the result yields `text` exactly.
 */
export function splitUtf8Chunks(text: string, maxBytes: number = PTY_WRITE_CHUNK_BYTES): string[] {
  if (maxBytes < 4) throw new RangeError("maxBytes must be at least 4");
  // Fast path: every UTF-16 unit encodes to at most 3 bytes.
  if (text.length * 3 <= maxBytes) return [text];
  const chunks: string[] = [];
  let start = 0;
  let bytes = 0;
  let i = 0;
  while (i < text.length) {
    const cp = codePointAt(text, i);
    if (bytes + cp.bytes > maxBytes) {
      chunks.push(text.slice(start, i));
      start = i;
      bytes = 0;
    }
    bytes += cp.bytes;
    i += cp.units;
  }
  if (start < text.length) chunks.push(text.slice(start));
  return chunks;
}

export type PtySend = (id: string, data: string) => Promise<void>;
export type PtyWrite = (id: string, data: string) => Promise<void>;

/**
 * Build a writer that delivers each payload as sequential, awaited chunks
 * and serializes all writes per terminal id: a keystroke issued while a
 * large paste is in flight goes out after the paste, never interleaved.
 *
 * If a chunk fails (e.g. the PTY is gone) the remaining chunks of that write
 * are dropped and its promise rejects once with that error. Later writes for
 * the same id still run (and fail on their own if the PTY is really gone).
 */
export function createPtyWriteQueue(
  send: PtySend,
  chunkBytes: number = PTY_WRITE_CHUNK_BYTES
): PtyWrite {
  // Tail of each terminal's chain; never rejects, so one failure cannot
  // poison the writes queued behind it.
  const tails = new Map<string, Promise<void>>();
  return (id, data) => {
    const prev = tails.get(id) ?? Promise.resolve();
    const run = prev.then(async () => {
      for (const chunk of splitUtf8Chunks(data, chunkBytes)) {
        await send(id, chunk);
      }
    });
    const tail = run.catch(() => {});
    tails.set(id, tail);
    void tail.then(() => {
      if (tails.get(id) === tail) tails.delete(id);
    });
    return run;
  };
}
