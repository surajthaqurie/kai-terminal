/**
 * Per-terminal Code Mode signal.
 *
 * Code Mode belongs to the terminal (pane) whose shell ran the agent, not to
 * the whole app. The CLI announces it on its own stdout — which IS that pane's
 * PTY — as a private OSC sequence, and the pane's xterm parser turns it into
 * state for that pane only. No shared file, no polling, no session ids: the
 * byte stream already knows which terminal it belongs to, on every OS.
 *
 * Wire format: `ESC ] 1337 ; KaiCodeMode=start;<encodeURIComponent(path)> BEL`
 * to enter, `ESC ] 1337 ; KaiCodeMode=stop BEL` to leave. OSC 1337 is the
 * private-use range terminals already ignore when they don't know a payload,
 * so a terminal that is not Kai (or a multiplexer that drops it) shows nothing.
 */

/** OSC function number carrying the signal (xterm hands the handler the text after `1337;`). */
export const CODE_MODE_OSC = 1337;

const PREFIX = "KaiCodeMode=";
const START = `${PREFIX}start;`;
const STOP = `${PREFIX}stop`;

/** Longest project path accepted from the byte stream (matches the backend's path cap). */
const MAX_PATH_CHARS = 4096;

/** The raw bytes the CLI writes: `projectPath` enters Code Mode, `null` leaves it. */
export function buildCodeModeSignal(projectPath: string | null): string {
  const body = projectPath === null ? STOP : `${START}${encodeURIComponent(projectPath)}`;
  return `\u001b]${CODE_MODE_OSC};${body}\u0007`;
}

export type CodeModeSignal = { active: true; path: string } | { active: false };

/**
 * Parses an OSC 1337 payload. Returns null for anything that is not a Kai
 * Code Mode signal (other 1337 users, malformed or oversized data) so the
 * caller leaves the pane's state untouched.
 */
export function parseCodeModeSignal(data: string): CodeModeSignal | null {
  if (data === STOP) return { active: false };
  if (!data.startsWith(START)) return null;
  const encoded = data.slice(START.length);
  if (!encoded || encoded.length > MAX_PATH_CHARS * 3) return null;
  try {
    const path = decodeURIComponent(encoded);
    if (!path.trim() || path.length > MAX_PATH_CHARS || path.includes("\0")) return null;
    return { active: true, path };
  } catch {
    return null;
  }
}
