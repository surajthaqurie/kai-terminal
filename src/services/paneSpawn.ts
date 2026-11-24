/**
 * The two ways a pane gets its shell (ARCH-03 extraction from `TerminalView`), without the
 * React state around them:
 *
 * - `spawnPaneShell`: start a new shell. A saved folder that no longer exists must not lock
 *   the pane out, so a working-directory failure is said in the terminal and the shell opens
 *   in the default (home) folder instead; any other failure, or a second failure there, is
 *   thrown for the error overlay. When the backend opened the shell in the parent of a missing
 *   folder, that is said too, so the shell is never silently somewhere other than the tab
 *   claims (FUNC-12). A spawn overtaken by a newer one (Retry, unmount) closes its shell
 *   instead of leaving it running unseen, and returns null.
 *
 * - `replayHandoff`: attach to a shell moved from another window. Redraw its screen from the
 *   snapshot at the grid it was taken at, then the output it printed during the move, and
 *   resolve once xterm has parsed all of it, so live output can follow in order. Null when
 *   overtaken.
 */
import type { PaneAdoption, PtySessionInfo } from "../types/terminal";
import type { HandoffRelease } from "./terminalWindows";
import {
  describeCwdFallback,
  describeParentSubstitution,
  isWorkingDirectoryError,
} from "./spawnRecovery";
import { normalizeCwdForCompare } from "./projectService";

export interface PaneSpawnRequest {
  shell_path?: string;
  args?: string[];
  cwd?: string;
  cols: number;
  rows: number;
}

export interface SpawnPaneShellOptions {
  createPty: (req: PaneSpawnRequest) => Promise<PtySessionInfo>;
  closePty: (id: string) => Promise<unknown>;
  shellPath?: string;
  args?: string[];
  /** The folder the pane wants (blank means the default folder). */
  cwd?: string | null;
  cols: number;
  rows: number;
  /** False once a newer launch or teardown has overtaken this one. */
  isCurrent: () => boolean;
  /** A line for the user in the terminal (shown highlighted). */
  notice: (text: string) => void;
}

/** The folder to ask for: trimmed, or undefined for the default folder. */
export function requestedFolder(cwd: string | null | undefined): string | undefined {
  const c = cwd?.trim();
  return c ? c : undefined;
}

export async function spawnPaneShell(opts: SpawnPaneShellOptions): Promise<PtySessionInfo | null> {
  const requested = requestedFolder(opts.cwd);
  const spawn = (dir: string | undefined) =>
    opts.createPty({
      shell_path: opts.shellPath,
      args: opts.args,
      cwd: dir,
      cols: opts.cols,
      rows: opts.rows,
    });
  let info: PtySessionInfo;
  let openedInHome = false;
  try {
    info = await spawn(requested);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    if (!requested || !isWorkingDirectoryError(reason) || !opts.isCurrent()) throw err;
    opts.notice(describeCwdFallback(requested));
    info = await spawn(undefined);
    openedInHome = true;
  }
  if (requested && !openedInHome && info.cwd) {
    const note = describeParentSubstitution(requested, info.cwd, normalizeCwdForCompare);
    if (note) opts.notice(note);
  }
  if (!opts.isCurrent()) {
    try {
      await opts.closePty(info.id);
    } catch {
      // Already gone.
    }
    return null;
  }
  return info;
}

/** What `replayHandoff` needs from xterm's `Terminal`. */
export interface ReplayTerminal {
  resize(cols: number, rows: number): void;
  write(data: string, callback?: () => void): void;
}

export async function replayHandoff(opts: {
  term: ReplayTerminal;
  adoption: PaneAdoption;
  /** Takes over the session from the old window; resolves with the output it held. */
  finish: (ptyId: string) => Promise<HandoffRelease>;
  isCurrent: () => boolean;
}): Promise<HandoffRelease | null> {
  const { term, adoption } = opts;
  try {
    // The snapshot was taken at this grid; xterm reflows it on the next refit.
    term.resize(adoption.cols, adoption.rows);
  } catch {
    // Keep the current grid.
  }
  await new Promise<void>((resolve) => term.write(adoption.snapshot, resolve));
  const released = await opts.finish(adoption.ptyId);
  if (!opts.isCurrent()) return null;
  for (const chunk of released.data) term.write(chunk);
  await new Promise<void>((resolve) => term.write("", resolve));
  if (!opts.isCurrent()) return null;
  return released;
}
