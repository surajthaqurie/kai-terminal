/**
 * Acknowledgements for PTY output flow control (PERF-01).
 *
 * The backend counts the bytes it emits for a session and pauses the shell once about
 * 1 MiB is unacknowledged. The frontend acknowledges bytes once xterm has parsed them
 * (the `term.write` callback). Sending one IPC call per flush would be chatty during
 * interactive typing, so acknowledgements are batched: sent at once when a batch
 * worth of bytes is pending, otherwise a few milliseconds later. The delay can never
 * stall a session: the backend resumes at 256 KiB, far above one batch.
 */

/** Pending bytes that are acknowledged immediately. */
export const ACK_BATCH_BYTES = 64 * 1024;
/** Longest a smaller amount waits before it is acknowledged. */
export const ACK_MAX_DELAY_MS = 40;

/**
 * UTF-8 length of `text`: the unit the backend counts in (it measures the strings it
 * emits). JS strings are UTF-16, so `text.length` would under-count anything non-ASCII.
 */
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4; // a surrogate pair is one 4-byte code point
        i += 1;
      } else {
        bytes += 3; // lone surrogate: encoded as U+FFFD
      }
    } else bytes += 3;
  }
  return bytes;
}

export interface OutputAcker {
  /** Records bytes the terminal has finished parsing; sends an acknowledgement when due. */
  add(bytes: number): void;
  /** Sends whatever is pending right now. */
  flushNow(): void;
  /** Cancels the pending timer (the pane is going away; its session is closed anyway). */
  dispose(): void;
}

export interface AckTimers {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

const realTimers: AckTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function createOutputAcker(
  send: (bytes: number) => void,
  timers: AckTimers = realTimers
): OutputAcker {
  let pending = 0;
  let timer: unknown = null;
  let disposed = false;

  const flushNow = () => {
    if (timer !== null) {
      timers.clearTimeout(timer);
      timer = null;
    }
    if (pending <= 0) return;
    const bytes = pending;
    pending = 0;
    try {
      send(bytes);
    } catch {
      // The acknowledgement is best effort; the backend recovers a lost one (see
      // FlowControl::wait_for_credit).
    }
  };

  return {
    add(bytes) {
      if (disposed || !(bytes > 0)) return;
      pending += bytes;
      if (pending >= ACK_BATCH_BYTES) {
        flushNow();
      } else if (timer === null) {
        timer = timers.setTimeout(() => {
          timer = null;
          flushNow();
        }, ACK_MAX_DELAY_MS);
      }
    },
    flushNow,
    dispose() {
      disposed = true;
      if (timer !== null) {
        timers.clearTimeout(timer);
        timer = null;
      }
      pending = 0;
    },
  };
}
