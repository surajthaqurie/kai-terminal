import { PtyService } from "./ptyService";

/** What a close would end; decides the wording of the confirmation. */
export type CloseKind = "tab" | "pane" | "window" | "workspace";

export interface CloseConfirmation {
  title: string;
  message: string;
  confirmLabel: string;
}

/**
 * How many of `paneIds` have a command running right now.
 *
 * `backendIdOf` maps a pane to its live shell session (null while it has none,
 * e.g. a restored tab that was never shown). Several panes can't share a session,
 * but ids are de-duplicated anyway. Any failure counts as "none busy": checking
 * must never be able to stop the user from closing something.
 */
export async function countBusyPanes(
  paneIds: readonly string[],
  backendIdOf: (paneId: string) => string | null | undefined,
  busySessions: (ids: string[]) => Promise<string[]> = (ids) => PtyService.busySessions(ids)
): Promise<number> {
  const ids = liveSessionIds(paneIds, backendIdOf);
  if (ids.length === 0) return 0;
  try {
    return (await busySessions(ids)).length;
  } catch {
    return 0;
  }
}

/** Live shell session ids behind `paneIds` (no nulls, no duplicates). */
export function liveSessionIds(
  paneIds: readonly string[],
  backendIdOf: (paneId: string) => string | null | undefined
): string[] {
  const ids = new Set<string>();
  for (const paneId of paneIds) {
    const id = backendIdOf(paneId);
    if (id) ids.add(id);
  }
  return [...ids];
}

/** Confirmation text for closing `kind` while `busy` panes still run a command. */
export function describeClose(kind: CloseKind, busy: number): CloseConfirmation {
  const what =
    busy === 1 ? "a command that is still running" : `${busy} commands that are still running`;
  switch (kind) {
    case "pane":
      return {
        title: "Close this pane?",
        message: `This pane has ${what}. Closing it ends the command.`,
        confirmLabel: "Close pane",
      };
    case "tab":
      return {
        title: "Close this tab?",
        message: `This tab has ${what}. Closing it ends ${busy === 1 ? "it" : "them"}.`,
        confirmLabel: "Close tab",
      };
    case "window":
      return {
        title: "Close this window?",
        message: `This is the last tab and it has ${what}. Closing it ends ${
          busy === 1 ? "it" : "them"
        } and closes the window.`,
        confirmLabel: "Close window",
      };
    case "workspace":
      return {
        title: "Replace the open tabs?",
        message: `Loading this workspace closes every open tab, and ${what} will be ended.`,
        confirmLabel: "Load workspace",
      };
  }
}
