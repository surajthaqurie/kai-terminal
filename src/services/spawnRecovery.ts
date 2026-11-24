/**
 * The backend reports a bad working directory as
 * `Invalid working directory: <reason>` (TerminalError::InvalidDirectory).
 *
 * A saved or restored pane keeps its folder, so a project on an unplugged
 * drive, a removed share, or a WSL path while WSL is down made every spawn of
 * that pane fail the same way: Retry and the shell picker re-read the same bad
 * folder, leaving closing the tab as the only way out.
 */
export function isWorkingDirectoryError(message: string): boolean {
  return /\binvalid working directory\b/i.test(message);
}

/**
 * The line to write when the backend opened the shell in an ANCESTOR of the folder that was asked
 * for (it replaces a missing folder, or a file path, by its parent instead of failing), or null
 * when the shell is where it was asked to be. Compared after `normalize`, so `C:\x` and `c:/x/`
 * count as the same place (FUNC-12).
 */
export function describeParentSubstitution(
  requested: string,
  actual: string,
  normalize: (p: string) => string
): string | null {
  const want = normalize(requested).replace(/\/+$/, "");
  const got = normalize(actual).replace(/\/+$/, "");
  if (!want || !got || want === got) return null;
  if (!want.startsWith(got + "/")) return null;
  return `[Folder "${requested}" does not exist. Opened in "${actual}" instead.]`;
}

/** The line written into the pane when it falls back to the default folder. */
export function describeCwdFallback(dir: string): string {
  return `[Folder "${dir}" is not available. Opened in your home folder instead.]`;
}
