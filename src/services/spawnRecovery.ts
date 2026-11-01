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

/** The line written into the pane when it falls back to the default folder. */
export function describeCwdFallback(dir: string): string {
  return `[Folder "${dir}" is not available. Opened in your home folder instead.]`;
}
