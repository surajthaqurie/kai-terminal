/**
 * Teams unread signal.
 *
 * `kai teams` runs inside a terminal tab, so the tab bar cannot see its chat
 * list. The chat announces how many messages are unread on its own stdout (the
 * tab's PTY) as a private OSC sequence, the pane's xterm parser turns it into
 * a number for that pane, and the tab shows it as a badge. Same channel as the
 * Code Mode signal (`codeModeSignal.ts`): no files, no polling, and a terminal
 * that is not Kai ignores the sequence.
 *
 * Wire format: `ESC ] 1337 ; KaiTeams=unread;<count> BEL` while the chat runs,
 * `ESC ] 1337 ; KaiTeams=stop BEL` when it closes.
 */

export const TEAMS_OSC = 1337;

const PREFIX = "KaiTeams=";
const UNREAD = `${PREFIX}unread;`;
const STOP = `${PREFIX}stop`;
/** More than any badge shows; keeps a garbled number from becoming huge. */
const MAX_COUNT = 9999;

/** The bytes the chat writes: a count while running, `null` when it closes. */
export function buildTeamsSignal(unread: number | null): string {
  const body =
    unread === null ? STOP : `${UNREAD}${Math.max(0, Math.min(MAX_COUNT, Math.floor(unread)))}`;
  return `\u001b]${TEAMS_OSC};${body}\u0007`;
}

/**
 * Parses an OSC 1337 payload: the unread count, 0 for "stopped", or null when
 * it is not a Teams signal (other 1337 users, malformed data), so the caller
 * leaves the pane's state alone.
 */
export function parseTeamsSignal(data: string): number | null {
  if (data === STOP) return 0;
  if (!data.startsWith(UNREAD)) return null;
  const digits = data.slice(UNREAD.length);
  if (!/^\d{1,4}$/.test(digits)) return null;
  return Math.min(MAX_COUNT, Number(digits));
}
