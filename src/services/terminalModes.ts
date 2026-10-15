/**
 * Shared terminal input-mode recovery (CLI + emulator twin).
 *
 * Fullscreen TUIs (Claude Code, editors, pagers) enable mouse tracking
 * (1000/1002/1003 + SGR 1006 / 1015), focus reporting (1004) and bracketed
 * paste (2004) on startup and are supposed to disable them on exit. When
 * the child is killed, times out, or crashes, that cleanup never runs and
 * the emulator keeps translating every mouse move / window focus / paste
 * into escape sequences the shell echoes back as garbage — the
 * "ghost typing on hover/focus" report after `kai claude`
 * ("Agent finished" then stray input on mouse move).
 *
 * Recovery travels the OUTPUT path (PTY -> emulator):
 * - CLI (`resetTerminalModesAfterAgent` in `core/codeModeWorkflow.ts`)
 *   prints TERMINAL_MODE_RESET_SEQ to stdout after the agent settles.
 * - The frontend (`TerminalView`) feeds the same bytes via `term.write`
 *   when it sees AGENT_FINISHED_MARKER in PTY output.
 *
 * The sequence is idempotent and screen-safe: it only clears input modes,
 * never touches visible content or scrollback.
 */
export const TERMINAL_MODE_RESET_SEQ =
  "\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1005l\x1b[?1006l\x1b[?1015l\x1b[?1004l\x1b[?2004l";

/** Printed by `kai` Code Mode runs once the agent child settles. */
export const AGENT_FINISHED_MARKER = "[kai] Agent finished";

/**
 * Scan a streaming PTY output chunk for AGENT_FINISHED_MARKER, tolerating
 * splits across chunk boundaries. Returns whether the marker was seen and
 * the bounded tail to carry into the next chunk.
 */
export function scanAgentFinishedTail(
  prevTail: string,
  chunk: string
): { hit: boolean; tail: string } {
  const window = `${prevTail}${chunk}`;
  const hit = window.includes(AGENT_FINISHED_MARKER);
  return { hit, tail: window.slice(-AGENT_FINISHED_MARKER.length) };
}

// Terminal-generated input reports (emulator -> host direction) that must
// never reach a shell prompt:
// - SGR mouse:   ESC [ < btn ; x ; y M/m   (e.g. "\x1b[<35;3;3M")
// - X10 mouse:   ESC [ M btn x y           (3 raw bytes after M)
// - Focus in/out: ESC [ I  /  ESC [ O
// None of these is producible by normal keyboard typing (Alt+key sends
// ESC + key without the '['), so on the normal buffer they can only be
// stuck TUI modes leaking mouse/focus movement as "ghost typing".
const STUCK_INPUT_REPORT_RE = /\x1b\[<[0-9;]*[Mm]|\x1b\[M...|\x1b\[[IO]/g;

/**
 * Whether a stripped-report observation should also switch the emulator
 * out of its stuck modes (via TERMINAL_MODE_RESET_SEQ on the output path).
 *
 * Gentle by design: the FIRST stray report is only dropped, never acted
 * on — a TUI that enables mouse a beat before switching to the alternate
 * screen must not lose its mouse because the user moved the pointer in
 * that millisecond window. The reset fires on the second consecutive
 * report (genuinely stuck modes), or immediately once the
 * `[kai] Agent finished` marker proved the agent is gone.
 */
export function shouldAutoResetModes(
  consecutiveStripped: number,
  agentFinishedSeen: boolean
): boolean {
  return agentFinishedSeen || consecutiveStripped >= 2;
}

/**
 * Strip stuck TUI input reports from an xterm onData chunk before it is
 * forwarded to the PTY. Filtering applies ONLY on the normal buffer: a
 * shell prompt never legitimately consumes mouse/focus reports, while a
 * fullscreen TUI on the alternate screen needs them (and runs with
 * `onAlternateScreen === true`, so its mouse keeps working). Pure helper
 * (exported for tests).
 *
 * Reports arrive whole per onData event (the emulator composes each mouse
 * / focus report as one string), so stateless matching is sufficient.
 */
export function stripStuckInputReports(data: string, onAlternateScreen: boolean): string {
  if (onAlternateScreen || !data.includes("\x1b")) return data;
  return data.replace(STUCK_INPUT_REPORT_RE, "");
}
