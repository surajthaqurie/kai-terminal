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
