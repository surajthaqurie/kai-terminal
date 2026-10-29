/**
 * Detects whether a submitted shell line likely changes the working directory.
 *
 * Used to gate the post-Enter cwd probe: previously EVERY Enter (even bare
 * Enter or `ls`) scheduled 3 backend cwd probes plus 3 git spawns and 3 full
 * re-render cascades — the felt "Enter takes time" on Windows, where each
 * IPC and MSYS `git` spawn costs milliseconds plus Defender overhead.
 * Now only directory-changing lines probe; everything else relies on the
 * cheap backstops (OSC 7/9 sequences, focus sync, 5 s interval).
 *
 * Rule: the first word of any `;`-, `&&`-, `||`- or newline-separated segment
 * names a directory-changing builtin. `sudo cd /x` intentionally does NOT
 * match — sudo cannot change our shell's cwd, so probing would be waste.
 * False negatives only delay the footer badge until the next backstop tick;
 * false positives cost a single probe.
 */

const CD_LIKE = new Set([
  "cd",
  "chdir",
  "pushd",
  "popd",
  "z",
  "j",
  "set-location",
  "sl",
  "..",
  "~",
  "-",
]);

function isCdToken(token: string): boolean {
  if (!token) return false;
  if (CD_LIKE.has(token)) return true;
  // cmd.exe allows `cd..` / `cd\` without a space; `cdrom` must NOT match.
  if (/^cd[./\\]/.test(token)) return true;
  // Bare drive switch (`c:`) changes the cwd on cmd.exe and PowerShell.
  if (/^[a-z]:$/.test(token)) return true;
  return false;
}

export function lineLikelyChangesCwd(line: string): boolean {
  if (!line) return false;
  const segments = line.toLowerCase().split(/;|&&|\|\||\r|\n/);
  for (const seg of segments) {
    const token = seg.trim().split(/\s+/, 1)[0] ?? "";
    if (isCdToken(token)) return true;
  }
  return false;
}

/**
 * Post-`cd` live-cwd probe schedule (ms after Enter).
 *
 * Spacing is load-bearing: the backend throttles live-OS probes to one per
 * 2 s per session (`CWD_PROBE_MIN_INTERVAL` in `src-tauri/src/pty.rs`), so
 * probes inside the same window return the cached (pre-cd) directory and
 * the footer looks stuck until the next unrelated action. Each delay here
 * lands in its own throttle window, converging on the post-cd truth even
 * when the user idles afterwards. Keep every gap above 2000 ms (see
 * `cwdCommand.test.ts`) and the first tap prompt-fast. Same on all OSes.
 */
export const CD_PROBE_DELAYS_MS: readonly number[] = [300, 2500, 5000];

/**
 * Quiet period before a CHANGED directory reaches the footer path pill.
 *
 * Cwd reports arrive from many sources (OSC 7 / 9;9 prompt hooks, backend
 * probes, focus sync, the 5 s interval, post-`cd` taps) and used to be
 * applied the instant they arrived, so the path pill flapped and the footer
 * re-rendered while the user was still typing `cd /a/b/c`. A change is now
 * held until no keystroke has happened for this long AND the same candidate
 * has stood still, so only the final, settled directory is shown. The shell's
 * directory only changes once a line is submitted, so Enter does not count as
 * a keystroke here (see TerminalView) — otherwise a finished `cd` would wait
 * out the window twice. 600 ms still rides out fast `cd` hopping and typing
 * pauses, and the footer follows a finished `cd` promptly. Same on all OSes.
 */
export const CWD_SETTLE_MS = 600;

function normalizeForSettle(p: string): string {
  return p
    .replace(/^\\\\\?\\/, "")
    .replace(/\\/g, "/")
    .replace(/\/+$/, "")
    .toLowerCase();
}

export interface CwdSettler {
  /** Report a candidate directory from any source. */
  push(path: string): void;
  /** Forget the last shown directory: the next push applies immediately. */
  reset(): void;
  /** Drop any held candidate and stop timers (unmount). */
  dispose(): void;
}

/**
 * Debounce directory changes: the first directory (and the first after
 * `reset()`) is delivered immediately; later changes are delivered only after
 * {@link CWD_SETTLE_MS} without a newer different candidate and while
 * `isTyping()` is false. Candidates equal to what is already shown cancel any
 * held change (e.g. `cd x` then `cd ..` inside the window shows nothing).
 */
export function createCwdSettler(
  deliver: (path: string) => void,
  opts: { settleMs?: number; isTyping?: () => boolean } = {}
): CwdSettler {
  const settleMs = opts.settleMs ?? CWD_SETTLE_MS;
  let shown: string | null = null;
  let pending: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const clear = (): void => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const arm = (): void => {
    clear();
    timer = setTimeout(() => {
      timer = null;
      if (pending === null) return;
      if (opts.isTyping?.()) {
        arm(); // still typing: keep holding, re-check after another window
        return;
      }
      const next = pending;
      pending = null;
      shown = next;
      deliver(next);
    }, settleMs);
  };

  return {
    push(path: string): void {
      if (!path || !path.trim()) return;
      if (shown === null) {
        shown = path;
        deliver(path);
        return;
      }
      if (normalizeForSettle(path) === normalizeForSettle(shown)) {
        pending = null;
        clear();
        return;
      }
      if (pending !== null && normalizeForSettle(path) === normalizeForSettle(pending)) {
        return; // same candidate re-reported by another source: don't restart
      }
      pending = path;
      arm();
    },
    reset(): void {
      clear();
      pending = null;
      shown = null;
    },
    dispose(): void {
      clear();
      pending = null;
    },
  };
}
