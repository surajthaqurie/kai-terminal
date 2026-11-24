/**
 * How much of a pane's history travels with a tab moved to another window (REL-08).
 *
 * The whole configured scrollback goes along (the default is 10,000 rows; a fixed 4,000-row cap
 * used to drop the oldest 6,000 on every move). Only a pane whose snapshot is unusually large
 * gives up its oldest rows, so that a tab of several panes stays under the backend's 32 MB limit
 * for one new window (`MAX_SEED_BYTES` in terminal_windows.rs), where the move would be refused.
 */

/** Characters of serialized screen one pane may carry: 6 panes stay well under 32 MB as JSON. */
export const MAX_HANDOFF_SNAPSHOT_CHARS = 3 * 1024 * 1024;

/**
 * `serialize(rows)` with all `scrollback` rows, halving the rows while the result is longer
 * than `maxChars`. The visible screen is always included (rows 0 still serializes it).
 */
export function boundedSnapshot(
  serialize: (scrollbackRows: number) => string,
  scrollback: number,
  maxChars = MAX_HANDOFF_SNAPSHOT_CHARS
): string {
  let rows = Math.max(0, Math.floor(scrollback));
  let text = serialize(rows);
  while (text.length > maxChars && rows > 0) {
    rows = Math.floor(rows / 2);
    text = serialize(rows);
  }
  return text;
}
