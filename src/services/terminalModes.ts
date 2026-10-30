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

/**
 * Cleanup for the moment an agent TUI has exited, emitted BEFORE the
 * `[kai] Agent finished` line. Inline TUIs (Claude Code's "Enter to confirm ·
 * Esc to cancel" footer) leave their last frame on the normal screen with the
 * cursor at the end of it, so the next log line was printed on top of that
 * footer and looked stuck / duplicated. Pops the extended keyboard modes the
 * TUI pushed (kitty, modifyOtherKeys), restores cursor visibility, autowrap and
 * normal cursor keys, resets SGR, then returns to column 0 and erases from
 * there to the end of the screen. Plain VT/ANSI, so it behaves the same under
 * ConPTY on Windows, macOS terminals and Linux terminals. Unlike
 * {@link TERMINAL_MODE_RESET_SEQ} it DOES erase (below the cursor only), so it
 * must run once, right after the agent exits, never on a timer.
 */
export const AGENT_EXIT_CLEANUP_SEQ = "\x1b[<u\x1b[>4;0m\x1b[?25h\x1b[?7h\x1b[?1l\x1b[0m\r\x1b[J";

// Erase-display (ED 2 / ED 3, what `clear` / `cls` / Clear-Host emit) and full
// reset (RIS).
// eslint-disable-next-line no-control-regex
const CLEAR_SCREEN_RE = /\x1b\[[23]J|\x1bc/;

/**
 * Whether a PTY output chunk wipes the screen. The pane forces a full repaint
 * once such a chunk is parsed: the fresh prompt that follows `clear` is drawn
 * onto a just-erased grid, and a renderer that skips the repaint (WebGL
 * texture atlas, see-through background) left the prompt line missing until
 * the next keystroke. Pure helper (exported for tests).
 */
export function outputClearsScreen(chunk: string): boolean {
  return chunk.includes("\x1b") && CLEAR_SCREEN_RE.test(chunk);
}

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

// Terminal query REPLIES (emulator -> host) that a TUI asked for at startup:
// device attributes (DA1/DA2/DA3), cursor position (CPR), DECRQM mode
// reports, kitty-keyboard query, OSC 4/10/11/12 colour replies and DCS
// XTVERSION. If the asking agent exits/dies before the reply is delivered,
// the shell receives the bytes as typed input: visible garbage such as
// `^[[?1;2c` or `]11;rgb:0000/0000/0000`, and the lone ESC leaves
// readline/PSReadLine waiting for the rest of a sequence so real typing
// looks "blocked". Only ever stripped inside the short post-agent window
// (see STALE_REPLY_WINDOW_MS) because a live non-alt-screen TUI needs them.
const STALE_TERMINAL_REPLY_RE =
  // eslint-disable-next-line no-control-regex
  /\x1b\[[?>=]?[0-9;]*c|\x1b\[[0-9;]*R|\x1b\[\?[0-9;]*\$y|\x1b\[\?[0-9;]*u|\x1b\](?:4;[0-9]+|1[012]);[^\x07\x1b]*(?:\x07|\x1b\\)|\x1bP[>!]?\|[^\x1b]*\x1b\\/g;

/** How long after `[kai] Agent finished` leftover terminal replies are dropped. */
export const STALE_REPLY_WINDOW_MS = 10_000;

/**
 * Drop leftover terminal query replies from an xterm onData chunk. Callers
 * must only apply this while the post-agent window is open and the normal
 * buffer is active. Pure helper (exported for tests).
 */
export function stripStaleTerminalReplies(data: string): string {
  if (!data.includes("\x1b")) return data;
  return data.replace(STALE_TERMINAL_REPLY_RE, "");
}

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

/**
 * Prepare clipboard text for the PTY so a paste never auto-submits.
 *
 * - Line endings become `\r` (what Enter sends), like xterm's own paste.
 * - When the shell/app enabled bracketed paste (DECSET 2004) the text is
 *   wrapped in ESC[200~ … ESC[201~, so readline/zsh/PSReadLine treat embedded
 *   newlines as text instead of executing them.
 * - Otherwise there is no way to mark the paste as data, so trailing
 *   newlines (copied lines almost always end with one) are dropped; without
 *   this the shell ran the pasted command immediately.
 *
 * Pure helper (exported for tests).
 */
export function preparePasteText(text: string, bracketedPaste: boolean): string {
  let out = text.replace(/\r\n|\r|\n/g, "\r");
  if (bracketedPaste) {
    // A pasted end marker would let the clipboard break out of the paste.
    out = out.replace(/\x1b\[20[01]~/g, "");
    return `\x1b[200~${out}\x1b[201~`;
  }
  return out.replace(/\r+$/, "");
}
