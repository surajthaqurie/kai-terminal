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
 * Detects whether a submitted shell line likely changes Code Mode state.
 *
 * Gates the POST-execution Code Mode re-sync: `kai code .` / `kai stop code`
 * write/remove the state file DURING execution (after indexing), so the
 * pre-Enter sync reads stale state and — inside Kai's own tab — no window
 * focus change ever follows to correct it. Only `kai` lines invoking a
 * state-changing subcommand (`code`, `stop`, `clear`, or a bare/direct path
 * like `kai .`, which also enters Code Mode) schedule delayed re-syncs;
 * every other line relies on the cheap pre-Enter sync + focus polling.
 * False positives cost a few file-read IPCs; false negatives only delay the
 * badge until the next focus event or command.
 */
const CODE_MODE_SUBCOMMANDS = new Set(["code", "stop", "clear"]);

function kaiBasename(token: string): string {
  const base = token.toLowerCase().split(/[/\\]/).pop() ?? "";
  return base.replace(/\.(js|cmd|bat|exe|ps1)$/, "");
}

export function lineLikelyChangesCodeMode(line: string): boolean {
  if (!line) return false;
  const segments = line.split(/;|&&|\|\||\r|\n/);
  for (const seg of segments) {
    const parts = seg.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) continue;
    let idx = 0;
    // Tolerate common wrappers: `sudo kai code .`, `npx kai stop code`.
    const first = parts[0].toLowerCase();
    if ((first === "sudo" || first === "npx") && parts.length > 1) idx = 1;
    if (kaiBasename(parts[idx] ?? "") !== "kai") continue;
    const sub = (parts[idx + 1] ?? "").toLowerCase();
    // Bare `kai` (prints help) and flag-only invocations such as
    // `kai --version` change no state.
    if (!sub || sub.startsWith("-")) continue;
    if (CODE_MODE_SUBCOMMANDS.has(sub)) return true;
    // Direct-path invocation (`kai .`, `kai ~/proj`, `kai C:\work`, `kai /x`)
    // also registers + enters Code Mode (see runCli isDirectPath).
    if (
      sub === "." ||
      sub === "~" ||
      sub.startsWith("./") ||
      sub.startsWith("../") ||
      sub.startsWith("~/") ||
      sub.startsWith("/") ||
      /^[a-zA-Z]:/.test(sub)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Quiet period before a CHANGED directory reaches the footer path pill.
 *
 * Cwd reports arrive from many sources (OSC 7 / 9;9 prompt hooks, backend
 * probes, focus sync, the 5 s interval, post-`cd` taps) and used to be
 * applied the instant they arrived, so the path pill flapped and the footer
 * re-rendered while the user was still typing `cd /a/b/c`. A change is now
 * held until no keystroke has happened for this long AND the same candidate
 * has stood still, so only the final, settled directory is shown. 1.5 s is
 * long enough to ride out typing pauses and fast `cd` hopping, short enough
 * that the footer still follows a finished `cd` promptly. Same on all OSes.
 */
export const CWD_SETTLE_MS = 1500;

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
