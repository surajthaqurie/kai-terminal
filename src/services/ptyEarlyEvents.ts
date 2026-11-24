/**
 * PTY events that arrive before the frontend knows its session id.
 *
 * `create_pty` starts the backend reader thread before its reply reaches the
 * webview, so a fast shell's first prompt (or an instant spawn failure's exit
 * event) can be emitted while the pane still has no session id. Every pane
 * listens to the same global events and filters by id, so those events used to
 * be dropped: a blank terminal until the next keypress, or a dead shell that
 * still showed as connected.
 *
 * A spawning pane holds events for ids nobody owns yet and replays the ones
 * that turn out to be its own once `create_pty` returns.
 */

export type EarlyPtyEvent =
  | { kind: "output"; id: string; data: string }
  | { kind: "exit"; id: string; exit_code?: number | null };

/** Session ids owned by a mounted pane (so their events are never buffered elsewhere). */
const claimedIds = new Set<string>();

export function claimPtyId(id: string): void {
  claimedIds.add(id);
}

export function releasePtyId(id: string | null | undefined): void {
  if (id) claimedIds.delete(id);
}

/**
 * Bounds: a spawn window is short, so a small buffer is plenty. Sized well above what
 * output flow control lets the backend send before the frontend acknowledges
 * anything (1 MiB in flight), so a held event is never dropped: a dropped one would
 * also never be acknowledged and would eat into that credit.
 */
export const MAX_EARLY_EVENTS = 4096;
export const MAX_EARLY_OUTPUT_CHARS = 4_194_304;

export interface EarlyPtyEvents {
  /** Hold an event seen while spawning. Events for already-owned ids are ignored. */
  hold(event: EarlyPtyEvent): void;
  /** Remove and return, in arrival order, the held events for `id`; drops the rest. */
  take(id: string): EarlyPtyEvent[];
  clear(): void;
}

export function createEarlyPtyEvents(
  isClaimed: (id: string) => boolean = (id) => claimedIds.has(id)
): EarlyPtyEvents {
  let held: EarlyPtyEvent[] = [];
  let chars = 0;
  const weight = (e: EarlyPtyEvent) => (e.kind === "output" ? e.data.length : 0);
  return {
    hold(event) {
      if (isClaimed(event.id)) return;
      held.push(event);
      chars += weight(event);
      // Drop the oldest first so the newest state (and a final exit) survives.
      while (held.length > MAX_EARLY_EVENTS || chars > MAX_EARLY_OUTPUT_CHARS) {
        const dropped = held.shift();
        if (!dropped) break;
        chars -= weight(dropped);
      }
    },
    take(id) {
      const mine = held.filter((e) => e.id === id);
      held = [];
      chars = 0;
      return mine;
    },
    clear() {
      held = [];
      chars = 0;
    },
  };
}
