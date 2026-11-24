import { ESC } from "./ansi";
import type { Frame, Placement } from "./render";

/**
 * Owns the terminal while the chat runs: alternate screen, mouse and
 * bracketed-paste reporting, raw input, and drawing frames. Only rows that
 * changed are rewritten, and an inline image is re-sent only when it moved or
 * the rows under it were redrawn, so typing never re-uploads a picture.
 */

const BEL = "\u0007";

/**
 * True when the terminal can draw images from the iTerm2 inline-image protocol
 * (iTerm2, WezTerm, mintty, and Kai Terminal). `KAI_TEAMS_IMAGES=inline|off`
 * overrides the guess.
 */
export function supportsInlineImages(env: NodeJS.ProcessEnv = process.env): boolean {
  const force = env.KAI_TEAMS_IMAGES?.toLowerCase();
  if (force === "off") return false;
  if (force === "inline") return true;
  const program = env.TERM_PROGRAM ?? "";
  return (
    program === "iTerm.app" ||
    program === "WezTerm" ||
    program === "mintty" ||
    program === "kai" ||
    env.LC_TERMINAL === "iTerm2"
  );
}

/** The escape sequence that draws a base64 image into a cols x rows cell box. */
export function inlineImageSequence(p: Pick<Placement, "b64" | "cols" | "rows" | "name">): string {
  const name = Buffer.from(p.name || "image").toString("base64");
  return `${ESC}]1337;File=name=${name};inline=1;width=${p.cols};height=${p.rows};preserveAspectRatio=1:${p.b64}${BEL}`;
}

export interface ScreenIO {
  out: NodeJS.WriteStream;
  inp: NodeJS.ReadStream;
}

export class Screen {
  private prev: string[] = [];
  private prevImages = new Map<string, Placement>();
  private active = false;

  constructor(private readonly io: ScreenIO = { out: process.stdout, inp: process.stdin }) {}

  size(): { cols: number; rows: number } {
    return { cols: this.io.out.columns || 80, rows: this.io.out.rows || 24 };
  }

  enter(onData: (chunk: string) => void): void {
    if (this.active) return;
    this.active = true;
    this.io.out.write(
      `${ESC}[?1049h${ESC}[2J${ESC}[?25l${ESC}[?1000h${ESC}[?1006h${ESC}[?2004h${ESC}[?1004h`
    );
    this.io.inp.setRawMode?.(true);
    this.io.inp.setEncoding("utf8");
    this.io.inp.on("data", onData);
    this.io.inp.resume();
  }

  leave(onData?: (chunk: string) => void): void {
    if (!this.active) return;
    this.active = false;
    if (onData) this.io.inp.off("data", onData);
    try {
      this.io.inp.setRawMode?.(false);
    } catch {
      // stdin may already be closed
    }
    this.io.inp.pause();
    this.io.out.write(
      `${ESC}[?1004l${ESC}[?2004l${ESC}[?1006l${ESC}[?1000l${ESC}[0m${ESC}[?25h${ESC}[?1049l`
    );
  }

  /** Write a private control sequence (the unread signal to Kai Terminal's tab bar). */
  signal(seq: string): void {
    if (this.active) this.io.out.write(seq);
  }

  /** Ring the terminal bell (a flash or sound, depending on the terminal) to get attention. */
  bell(): void {
    if (this.active) this.io.out.write(BEL);
  }

  /** Forget what is on screen so the next draw repaints everything (after a resize). */
  invalidate(): void {
    this.prev = [];
    this.prevImages.clear();
    this.io.out.write(`${ESC}[2J`);
  }

  draw(frame: Frame): void {
    if (!this.active) return;
    let buf = `${ESC}[?25l`;
    // Rows a picture covered that it no longer covers in the same place (it scrolled, or went
    // away) are rewritten even when their text is unchanged: an image's rows are blank text, so
    // without this the old picture would stay on screen beside the new one.
    const stale = new Set<number>();
    for (const [id, before] of this.prevImages) {
      const now = frame.images.find((p) => p.id === id);
      if (
        now &&
        now.row === before.row &&
        now.col === before.col &&
        now.cols === before.cols &&
        now.rows === before.rows
      )
        continue;
      for (let r = before.row; r < before.row + before.rows; r++) stale.add(r);
    }
    const touched = new Set<number>();
    frame.rows.forEach((row, i) => {
      if (this.prev[i] === row && !stale.has(i + 1)) return;
      buf += `${ESC}[${i + 1};1H${row}`;
      touched.add(i + 1);
    });
    const next = new Map<string, Placement>();
    for (const p of frame.images) {
      next.set(p.id, p);
      const before = this.prevImages.get(p.id);
      const same =
        before &&
        before.row === p.row &&
        before.col === p.col &&
        before.cols === p.cols &&
        before.rows === p.rows;
      let rowsTouched = false;
      for (let r = p.row; r < p.row + p.rows; r++) if (touched.has(r)) rowsTouched = true;
      if (!same || rowsTouched) {
        buf += `${ESC}[${p.row};${p.col}H${inlineImageSequence(p)}`;
      }
    }
    this.prev = frame.rows.slice();
    this.prevImages = next;
    buf += `${ESC}[${frame.cursor.y};${frame.cursor.x}H${ESC}[?25h`;
    this.io.out.write(buf);
  }
}
