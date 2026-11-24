/**
 * PTY output path from event to xterm, for one pane (ARCH-03 extraction from
 * `TerminalView`).
 *
 * - Output is buffered in a bounded FIFO (`TerminalOutputBuffer`) and written once per
 *   animation frame. rAF stalls for hidden tabs, so a 250 ms timeout guarantees progress.
 * - A flush is written to xterm in slices of at most `MAX_TERM_WRITE_CHARS`: one write of a
 *   1 MB flood blocks the UI thread long enough for Windows to flag "Not Responding".
 * - Flow control (PERF-01): bytes the backend counted as sent (live events) are
 *   acknowledged only after xterm has parsed the last slice of the flush that carried
 *   them. Output handed over by a window move was never counted and is never acknowledged.
 * - Nothing is dropped silently (PERF-02): if the buffer ever had to discard output, the
 *   next flush prints a notice in the terminal.
 * - After `clear` / `cls` / Clear-Host, every row is repainted and the view snaps to the
 *   bottom once the chunk is parsed, so the prompt drawn after the erase is not left
 *   unpainted.
 */

import { TerminalOutputBuffer } from "./terminalOutputBuffer";
import { createOutputAcker, utf8ByteLength, type OutputAcker } from "./outputAcker";
import { outputClearsScreen } from "./terminalModes";

/** Largest single `term.write` (characters). */
export const MAX_TERM_WRITE_CHARS = 65536;
/** Fallback flush delay when rAF does not fire (hidden or background tab). */
export const FLUSH_FALLBACK_MS = 250;

/** The part of xterm's `Terminal` the pipeline uses. */
export interface OutputTerminal {
  readonly rows: number;
  write(data: string, callback?: () => void): void;
  refresh(start: number, end: number): void;
  scrollToBottom(): void;
}

export interface OutputScheduler {
  requestAnimationFrame(fn: () => void): unknown;
  cancelAnimationFrame(handle: unknown): void;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realScheduler: OutputScheduler = {
  requestAnimationFrame: (fn) => requestAnimationFrame(fn),
  cancelAnimationFrame: (handle) => cancelAnimationFrame(handle as number),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface TerminalOutputPipeline {
  /**
   * Queues output and schedules a flush. `counted`: the backend counted these bytes as
   * sent to this pane (a live event) and expects them acknowledged.
   */
  push: (data: string, counted?: boolean) => void;
  /** Writes everything pending now (show-time paint, exit, hand-off release). A closure: safe to pass on its own. */
  flush: () => void;
  /** Cancels scheduled work and pending acknowledgements; the pane is going away. */
  dispose: () => void;
}

export interface TerminalOutputPipelineOptions {
  term: OutputTerminal;
  /** Sends an acknowledgement for `bytes` parsed bytes to the backend. */
  ack: (bytes: number) => void;
  scheduler?: OutputScheduler;
  /** Acknowledgement batching; defaults to `createOutputAcker(ack)`. For tests. */
  acker?: OutputAcker;
  buffer?: TerminalOutputBuffer;
  log?: (message: string, err?: unknown) => void;
}

export function createTerminalOutputPipeline(
  options: TerminalOutputPipelineOptions
): TerminalOutputPipeline {
  const { term } = options;
  const scheduler = options.scheduler ?? realScheduler;
  const acker = options.acker ?? createOutputAcker(options.ack);
  const pending = options.buffer ?? new TerminalOutputBuffer();
  const log =
    options.log ??
    ((message: string, err?: unknown) =>
      err === undefined ? console.error(message) : console.error(message, err));

  // Bytes the backend counted as sent to this pane and has not been told about yet.
  let unackedLiveBytes = 0;
  let scheduled = false;
  let rafId: unknown = null;
  let timerId: unknown = null;
  let disposed = false;

  const cancelScheduled = () => {
    scheduled = false;
    if (rafId !== null) {
      try {
        scheduler.cancelAnimationFrame(rafId);
      } catch {
        // ignore
      }
      rafId = null;
    }
    if (timerId !== null) {
      scheduler.clearTimeout(timerId);
      timerId = null;
    }
  };

  const repaintAfterClear = () => {
    try {
      term.refresh(0, Math.max(0, term.rows - 1));
      term.scrollToBottom();
    } catch {
      // Terminal disposed.
    }
  };

  const flush = () => {
    cancelScheduled();
    if (disposed) return;
    // Output the buffer had to discard is reported, never lost silently.
    const dropped = pending.takeDropped();
    if (dropped > 0) {
      log(
        `[kai] ${dropped} characters of terminal output were skipped: the terminal could not keep up`
      );
      try {
        term.write(
          `\r\n\x1b[33m[kai] ${Math.ceil(dropped / 1024)} KB of output was skipped: the terminal could not keep up\x1b[0m\r\n`
        );
      } catch {
        // Terminal disposed.
      }
    }
    const ackBytes = unackedLiveBytes;
    unackedLiveBytes = 0;
    let ackedOnce = false;
    const ackOnce = () => {
      if (ackedOnce) return;
      ackedOnce = true;
      if (ackBytes > 0) acker.add(ackBytes);
    };
    if (pending.isEmpty) {
      ackOnce();
      return;
    }
    const chunk = pending.flush();
    const clearsScreen = outputClearsScreen(chunk);
    try {
      for (let off = 0; off < chunk.length; off += MAX_TERM_WRITE_CHARS) {
        const isLast = off + MAX_TERM_WRITE_CHARS >= chunk.length;
        term.write(
          chunk.slice(off, off + MAX_TERM_WRITE_CHARS),
          // The last slice's callback runs after every earlier slice was parsed:
          // only then is this flush's output acknowledged to the backend.
          isLast
            ? () => {
                if (clearsScreen) repaintAfterClear();
                ackOnce();
              }
            : undefined
        );
      }
    } catch (err) {
      // xterm refused the write (disposed, or its own 50 MB pending limit). Report it and
      // acknowledge anyway so the backend is never left waiting on bytes that will not
      // be processed.
      log("[kai] terminal output could not be written:", err);
      ackOnce();
    }
  };

  const schedule = () => {
    if (scheduled || disposed) return;
    scheduled = true;
    let flushed = false;
    const doFlush = () => {
      if (!flushed) {
        flushed = true;
        flush();
      }
    };
    try {
      rafId = scheduler.requestAnimationFrame(doFlush);
    } catch {
      doFlush();
      return;
    }
    timerId = scheduler.setTimeout(doFlush, FLUSH_FALLBACK_MS);
  };

  return {
    push(data, counted = true) {
      if (disposed) return;
      if (counted) unackedLiveBytes += utf8ByteLength(data);
      pending.append(data);
      schedule();
    },
    flush,
    dispose() {
      cancelScheduled();
      disposed = true;
      acker.dispose();
    },
  };
}
