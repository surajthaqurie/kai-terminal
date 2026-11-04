/**
 * Terminal text helpers: display width (wide characters take two cells,
 * combining marks none), truncation and word wrapping. All pure.
 */

export const ESC = "\u001b";

/** Cells a code point occupies. */
export function charWidth(cp: number): number {
  if (cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0x0300 && cp <= 0x036f)) return 0;
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

export function textWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += charWidth(ch.codePointAt(0) ?? 0);
  return w;
}

/** The longest prefix of `s` that fits in `width` cells. */
export function clip(s: string, width: number): string {
  if (width <= 0) return "";
  let w = 0;
  let out = "";
  for (const ch of s) {
    const cw = charWidth(ch.codePointAt(0) ?? 0);
    if (w + cw > width) break;
    out += ch;
    w += cw;
  }
  return out;
}

/** `s` cut to `width` cells with an ellipsis when it does not fit. */
export function ellipsize(s: string, width: number): string {
  if (textWidth(s) <= width) return s;
  return width <= 1 ? clip(s, width) : `${clip(s, width - 1)}…`;
}

/** Pad with spaces on the right to exactly `width` cells (clipping if longer). */
export function padRight(s: string, width: number): string {
  const c = clip(s, width);
  return c + " ".repeat(Math.max(0, width - textWidth(c)));
}

/** Word-wrap `text` (which may hold newlines) to lines of at most `width` cells. */
export function wrap(text: string, width: number): string[] {
  const w = Math.max(1, width);
  const out: string[] = [];
  for (const para of text.split("\n")) {
    if (para === "") {
      out.push("");
      continue;
    }
    let line = "";
    let lineW = 0;
    for (const word of para.split(/(?<= )/)) {
      let piece = word;
      // A word's trailing space is not visible at the end of a line, so it does not count.
      let need = textWidth(piece.replace(/ +$/, ""));
      // A word longer than the line is broken into full lines.
      while (need > w) {
        if (line) {
          out.push(line.replace(/ +$/, ""));
          line = "";
          lineW = 0;
        }
        const head = clip(piece, w);
        out.push(head);
        piece = piece.slice(head.length);
        need = textWidth(piece.replace(/ +$/, ""));
      }
      if (lineW + need > w && line) {
        out.push(line.replace(/ +$/, ""));
        line = "";
        lineW = 0;
      }
      line += piece;
      lineW += textWidth(piece);
    }
    out.push(line.replace(/ +$/, ""));
  }
  return out;
}

/** Styled run: an SGR parameter string (`"1;36"`) and the text it applies to. */
export type Part = [sgr: string, text: string];

/** Draw parts into exactly `width` cells (clipped or padded), reset at the end. */
export function renderParts(parts: readonly Part[], width: number, fill = ""): string {
  let out = "";
  let used = 0;
  for (const [sgr, text] of parts) {
    if (used >= width) break;
    const t = clip(text, width - used);
    if (!t) continue;
    out += sgr ? `${ESC}[${sgr}m${t}${ESC}[0m` : t;
    used += textWidth(t);
  }
  if (used < width) {
    const pad = " ".repeat(width - used);
    out += fill ? `${ESC}[${fill}m${pad}${ESC}[0m` : pad;
  }
  return out;
}

/** Visible width of a string that may contain SGR sequences (used by tests and the renderer's checks). */
export function visibleWidth(s: string): number {
  return textWidth(s.replace(/\u001b\[[0-9;]*m/g, ""));
}
