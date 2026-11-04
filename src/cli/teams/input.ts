/**
 * Turns the bytes a terminal sends into events: keys, pasted text (bracketed
 * paste) and mouse reports (SGR 1006). A pure state machine over strings, so it
 * can be tested without a terminal.
 */
export type KeyName =
  | "enter"
  | "newline"
  | "backspace"
  | "delete"
  | "tab"
  | "escape"
  | "up"
  | "down"
  | "left"
  | "right"
  | "home"
  | "end"
  | "pageup"
  | "pagedown";

export type InputEvent =
  | { type: "key"; key: KeyName }
  | { type: "ctrl"; letter: string }
  | { type: "text"; text: string }
  | { type: "paste"; text: string }
  | { type: "focus"; focused: boolean }
  | {
      type: "mouse";
      action: "press" | "release" | "wheelup" | "wheeldown" | "other";
      x: number;
      y: number;
    };

const PASTE_START = "\u001b[200~";
const PASTE_END = "\u001b[201~";
/** A paste longer than this is cut, so a runaway clipboard cannot fill memory. */
const MAX_PASTE_CHARS = 200_000;

const CSI_KEYS: Record<string, KeyName> = {
  A: "up",
  B: "down",
  C: "right",
  D: "left",
  H: "home",
  F: "end",
};
const TILDE_KEYS: Record<string, KeyName> = {
  "1": "home",
  "3": "delete",
  "4": "end",
  "5": "pageup",
  "6": "pagedown",
  "7": "home",
  "8": "end",
};

export class InputParser {
  private buffer = "";
  private pasting: string | null = null;

  /** Feed a chunk from stdin; returns the events it completes. */
  feed(chunk: string): InputEvent[] {
    const events: InputEvent[] = [];
    let s = this.buffer + chunk;
    this.buffer = "";
    let i = 0;
    while (i < s.length) {
      if (this.pasting !== null) {
        const end = s.indexOf(PASTE_END, i);
        if (end === -1) {
          this.pasting = (this.pasting + s.slice(i)).slice(0, MAX_PASTE_CHARS);
          // Keep a partial end marker for the next chunk.
          const keep = partialSuffix(this.pasting, PASTE_END);
          if (keep) {
            this.pasting = this.pasting.slice(0, this.pasting.length - keep.length);
            this.buffer = keep;
          }
          return events;
        }
        this.pasting = (this.pasting + s.slice(i, end)).slice(0, MAX_PASTE_CHARS);
        events.push({ type: "paste", text: this.pasting.replace(/\r\n?/g, "\n") });
        this.pasting = null;
        i = end + PASTE_END.length;
        continue;
      }
      const c = s[i];
      if (c === "\u001b") {
        const rest = s.slice(i);
        if (rest === "\u001b") {
          events.push({ type: "key", key: "escape" });
          i++;
          continue;
        }
        if (rest.startsWith(PASTE_START)) {
          this.pasting = "";
          i += PASTE_START.length;
          continue;
        }
        const mouse = /^\u001b\[<(\d+);(\d+);(\d+)([Mm])/.exec(rest);
        if (mouse) {
          events.push(
            mouseEvent(Number(mouse[1]), Number(mouse[2]), Number(mouse[3]), mouse[4] === "M")
          );
          i += mouse[0].length;
          continue;
        }
        const csi = /^\u001b\[([0-9;]*)([A-Za-z~])/.exec(rest);
        if (csi) {
          const final = csi[2];
          // Focus reporting: ESC [ I when the window gains focus, ESC [ O when it loses it.
          if (csi[1] === "" && (final === "I" || final === "O")) {
            events.push({ type: "focus", focused: final === "I" });
            i += csi[0].length;
            continue;
          }
          const key = final === "~" ? TILDE_KEYS[csi[1].split(";")[0]] : CSI_KEYS[final];
          if (key) events.push({ type: "key", key });
          i += csi[0].length;
          continue;
        }
        const ss3 = /^\u001bO([A-Z])/.exec(rest);
        if (ss3) {
          const key = CSI_KEYS[ss3[1]];
          if (key) events.push({ type: "key", key });
          i += ss3[0].length;
          continue;
        }
        // An unfinished sequence at the end of the chunk: wait for the rest.
        if (/^\u001b(\[[0-9;<]*|O?)$/.test(rest)) {
          this.buffer = rest;
          return events;
        }
        // Alt+key or an unknown sequence: drop the ESC.
        i++;
        continue;
      }
      if (c === "\r") {
        events.push({ type: "key", key: "enter" });
        i++;
      } else if (c === "\n") {
        events.push({ type: "key", key: "newline" });
        i++;
      } else if (c === "\u007f" || c === "\b") {
        events.push({ type: "key", key: "backspace" });
        i++;
      } else if (c === "\t") {
        events.push({ type: "key", key: "tab" });
        i++;
      } else if (c < " ") {
        events.push({ type: "ctrl", letter: String.fromCharCode(c.charCodeAt(0) + 96) });
        i++;
      } else {
        // A run of printable characters becomes one text event.
        let j = i;
        while (j < s.length && s[j] >= " " && s[j] !== "\u007f" && s[j] !== "\u001b") j++;
        events.push({ type: "text", text: s.slice(i, j) });
        i = j;
      }
    }
    s = "";
    return events;
  }
}

function partialSuffix(text: string, marker: string): string {
  for (let n = Math.min(marker.length - 1, text.length); n > 0; n--) {
    if (text.endsWith(marker.slice(0, n))) return marker.slice(0, n);
  }
  return "";
}

function mouseEvent(code: number, x: number, y: number, down: boolean): InputEvent {
  if (code & 64) {
    return { type: "mouse", action: (code & 1) === 0 ? "wheelup" : "wheeldown", x, y };
  }
  if ((code & 3) === 0) return { type: "mouse", action: down ? "press" : "release", x, y };
  return { type: "mouse", action: "other", x, y };
}
