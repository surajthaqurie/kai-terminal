/**
 * Bounded FIFO buffer for PTY output awaiting an xterm write.
 *
 * The old path accumulated pending output with `pendingOutput += data` and
 * re-sliced a ~1 MB string on every chunk once the cap engaged — O(n^2)
 * copying that stalls the UI thread for seconds on floods such as
 * `npm install` output. This buffer appends whole payloads to a chunk array
 * (O(1) per append, no large copies) and only joins on flush. Trimming drops
 * whole chunks from the front, so surrogate pairs are never split. Memory
 * stays bounded by `maxChars` plus one in-flight payload.
 */
export const MAX_TERMINAL_PENDING_CHARS = 1_048_576;

// Compact the dead head of the chunk array once it grows past this many
// entries so long sessions cannot leak array slots without bound.
const MAX_DEAD_HEAD_ENTRIES = 4096;

export class TerminalOutputBuffer {
  private parts: string[] = [];
  private head = 0;
  private pendingChars = 0;
  private readonly maxChars: number;

  constructor(maxChars: number = MAX_TERMINAL_PENDING_CHARS) {
    this.maxChars = Math.max(1, Math.floor(maxChars));
  }

  append(data: string): void {
    if (!data) return;
    let chunk = data;
    if (chunk.length > this.maxChars) {
      // Single payload larger than the whole window: keep only its tail.
      let start = chunk.length - this.maxChars;
      const code = chunk.charCodeAt(start);
      if (code >= 0xdc00 && code <= 0xdfff) start += 1;
      chunk = chunk.slice(start);
    }
    this.parts.push(chunk);
    this.pendingChars += chunk.length;
    while (this.pendingChars > this.maxChars && this.head < this.parts.length) {
      this.pendingChars -= this.parts[this.head].length;
      this.head += 1;
    }
    if (this.head >= this.parts.length) {
      this.parts = [];
      this.head = 0;
    } else if (this.head > MAX_DEAD_HEAD_ENTRIES) {
      this.parts.splice(0, this.head);
      this.head = 0;
    }
  }

  get size(): number {
    return this.pendingChars;
  }

  get isEmpty(): boolean {
    return this.pendingChars === 0;
  }

  /** Drain the buffer and return the concatenated pending output. */
  flush(): string {
    if (this.pendingChars === 0) return "";
    const out = this.head === 0 ? this.parts.join("") : this.parts.slice(this.head).join("");
    this.parts = [];
    this.head = 0;
    this.pendingChars = 0;
    return out;
  }

  clear(): void {
    this.parts = [];
    this.head = 0;
    this.pendingChars = 0;
  }
}
