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
