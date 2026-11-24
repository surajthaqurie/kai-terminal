/**
 * Working-directory tracking for one terminal pane (ARCH-03 extraction from `TerminalView`).
 *
 * Every source of a directory goes through one `CwdSettler`, whose `deliver` is the only
 * path to the app (footer, git badge, new-tab folder):
 * - the folder `create_pty` returned (`sessionStarted`: the settler restarts, so it shows at once);
 * - `pty-cwd` events from the backend (`report`);
 * - backend reads (`check`) triggered by a shell's OSC 7 / OSC 9;9 folder report, by the pane
 *   gaining focus, by a moved shell being adopted, and by the probes after a submitted line;
 * - the periodic poll (`poll`), which is quiet: an unchanged folder on a timer is not a sign
 *   the shell ran anything, so it never forces a git refresh (PERF-12).
 *
 * Shell folder reports are only a SIGNAL to read the backend, which has checked the folder
 * (SEC-12); their path is never used.
 *
 * Probes after Enter (`lineSubmitted`): a line that probably changes the directory is
 * re-checked at `CD_PROBE_DELAYS_MS` (the next prompt can land well after 300 ms on slow
 * commands); a line that changes git state but not the folder (`git checkout`) is re-checked at
 * `GIT_PROBE_DELAYS_MS`, for shells with no prompt integration. Other lines probe nothing:
 * probing on every Enter was the felt input lag on Windows.
 *
 * While the user is typing (a key within `CWD_SETTLE_MS`, not Enter) a changed folder is held
 * back so the footer does not jump mid-line.
 */

import {
  CD_PROBE_DELAYS_MS,
  CWD_SETTLE_MS,
  GIT_PROBE_DELAYS_MS,
  createCwdSettler,
  lineLikelyChangesCwd,
  lineMayChangeGitState,
  type CwdSettler,
} from "./cwdCommand";

export interface PaneCwdTracker {
  /** Typed input (not yet sent): holds a changed folder back while typing. Enter does not. */
  keyTyped(data: string): void;
  /** A new shell started in `path`: shown immediately, whatever was shown before. */
  sessionStarted(path: string | null | undefined): void;
  /** A folder the backend pushed (`pty-cwd` event). */
  report(path: string): void;
  /** Reads the backend's folder for `ptyId` (default: the pane's current session). */
  check(ptyId?: string | null): void;
  /** Periodic read: quiet, never counts as a sign the shell ran something. */
  poll(): void;
  /** A line was submitted with Enter: schedule the probes it calls for. */
  lineSubmitted(line: string): void;
  /**
   * Stops pending probes and any held folder. The tracker stays usable: a pane's mount
   * effect can run again (React StrictMode, session switch) with the same tracker.
   */
  dispose(): void;
}

export interface PaneCwdTrackerTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realTimers: PaneCwdTrackerTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface PaneCwdTrackerOptions {
  /** The pane's current backend session, if any. */
  ptyId: () => string | null;
  /** The backend's checked folder for a session (`get_pty_cwd`). */
  readCwd: (ptyId: string) => Promise<string | null | undefined>;
  /** Delivers a folder (changed, or re-reported by the shell) to the app. */
  deliver: (path: string) => void;
  now?: () => number;
  timers?: PaneCwdTrackerTimers;
  /** Injected for tests; defaults to a settler wired to `deliver`. */
  settler?: CwdSettler;
}

export function createPaneCwdTracker(options: PaneCwdTrackerOptions): PaneCwdTracker {
  const now = options.now ?? Date.now;
  const timers = options.timers ?? realTimers;
  let lastKeyAt = Number.NEGATIVE_INFINITY;
  const settler =
    options.settler ??
    createCwdSettler(options.deliver, {
      isTyping: () => now() - lastKeyAt < CWD_SETTLE_MS,
      // Same directory, but the shell just reported in: the git badge may be stale (FUNC-04).
      onUnchanged: options.deliver,
    });
  const probes = new Set<unknown>();

  const read = (ptyId: string | null | undefined, quiet: boolean) => {
    if (!ptyId) return;
    let pending: Promise<string | null | undefined>;
    try {
      pending = options.readCwd(ptyId);
    } catch {
      return;
    }
    pending.then(
      (resolved) => {
        if (resolved) settler.push(resolved, quiet ? { quiet: true } : undefined);
      },
      () => {
        // The session is gone or the backend could not read it; the next report corrects it.
      }
    );
  };

  const probeAfter = (delays: readonly number[]) => {
    for (const delay of delays) {
      const handle = timers.setTimeout(() => {
        probes.delete(handle);
        read(options.ptyId(), false);
      }, delay);
      probes.add(handle);
    }
  };

  return {
    keyTyped(data) {
      if (!/[\r\n]/.test(data)) lastKeyAt = now();
    },
    sessionStarted(path) {
      if (!path) return;
      settler.reset();
      settler.push(path);
    },
    report(path) {
      if (path) settler.push(path);
    },
    check(ptyId) {
      read(ptyId ?? options.ptyId(), false);
    },
    poll() {
      read(options.ptyId(), true);
    },
    lineSubmitted(line) {
      if (!line) return;
      if (lineLikelyChangesCwd(line)) probeAfter(CD_PROBE_DELAYS_MS);
      else if (lineMayChangeGitState(line)) probeAfter(GIT_PROBE_DELAYS_MS);
    },
    dispose() {
      for (const handle of probes) timers.clearTimeout(handle);
      probes.clear();
      settler.dispose();
    },
  };
}
