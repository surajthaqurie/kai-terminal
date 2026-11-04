import { EventEmitter } from "events";
import { describe, expect, it } from "vitest";
import type { Frame, Placement } from "../cli/teams/render";
import {
  inlineImageSequence,
  Screen,
  supportsInlineImages,
  type ScreenIO,
} from "../cli/teams/screen";

function fakeIO() {
  const writes: string[] = [];
  const raw: boolean[] = [];
  const inp = Object.assign(new EventEmitter(), {
    setRawMode: (v: boolean) => void raw.push(v),
    setEncoding: () => undefined,
    resume: () => undefined,
    pause: () => undefined,
  });
  const out = { columns: 80, rows: 24, write: (s: string) => void writes.push(s) };
  return { io: { out, inp } as unknown as ScreenIO, writes, raw, inp };
}

const image = (over: Partial<Placement> = {}): Placement => ({
  id: "m1:0",
  row: 5,
  col: 4,
  cols: 20,
  rows: 3,
  b64: "QUJD",
  name: "a.png",
  ...over,
});

const frame = (rows: string[], images: Placement[] = []): Frame => ({
  rows,
  hits: [],
  images,
  cursor: { x: 3, y: 2 },
  pane: { x1: 1, y1: 1, x2: 1, y2: 1 },
  maxScroll: 0,
});

describe("Screen", () => {
  it("takes over the terminal and gives it back", () => {
    const { io, writes, raw, inp } = fakeIO();
    const screen = new Screen(io);
    const onData = () => undefined;
    screen.enter(onData);
    expect(writes[0]).toContain("\u001b[?1049h");
    expect(writes[0]).toContain("\u001b[?1006h");
    expect(writes[0]).toContain("\u001b[?2004h");
    expect(raw).toEqual([true]);
    expect(inp.listenerCount("data")).toBe(1);
    screen.leave(onData);
    expect(writes[writes.length - 1]).toContain("\u001b[?1049l");
    expect(writes[writes.length - 1]).toContain("\u001b[?25h");
    expect(raw).toEqual([true, false]);
    expect(inp.listenerCount("data")).toBe(0);
    // Leaving twice is harmless.
    screen.leave(onData);
    expect(writes.length).toBe(2);
  });

  it("asks the terminal to report focus while it runs, and stops afterwards", () => {
    const { io, writes } = fakeIO();
    const screen = new Screen(io);
    screen.enter(() => undefined);
    expect(writes[0]).toContain("\u001b[?1004h");
    screen.leave();
    expect(writes[writes.length - 1]).toContain("\u001b[?1004l");
  });

  it("rings the bell only while the chat is running", () => {
    const { io, writes } = fakeIO();
    const screen = new Screen(io);
    screen.bell();
    expect(writes).toEqual([]);
    screen.enter(() => undefined);
    writes.length = 0;
    screen.bell();
    expect(writes).toEqual(["\u0007"]);
  });

  it("rewrites only the rows that changed", () => {
    const { io, writes } = fakeIO();
    const screen = new Screen(io);
    screen.enter(() => undefined);
    writes.length = 0;
    screen.draw(frame(["one", "two", "three"]));
    expect(writes[0]).toContain("\u001b[1;1Hone");
    expect(writes[0]).toContain("\u001b[3;1Hthree");
    writes.length = 0;
    screen.draw(frame(["one", "TWO", "three"]));
    expect(writes[0]).toContain("\u001b[2;1HTWO");
    expect(writes[0]).not.toContain("one");
    expect(writes[0]).not.toContain("three");
    writes.length = 0;
    screen.draw(frame(["one", "TWO", "three"]));
    expect(writes[0]).not.toMatch(/\u001b\[\d+;1H/);
  });

  it("sends an inline image once, not on every keystroke", () => {
    const { io, writes } = fakeIO();
    const screen = new Screen(io);
    screen.enter(() => undefined);
    const rows = ["h", "", "", "", "", "", "", "", "", "footer", "input"];
    screen.draw(frame(rows, [image()]));
    expect(writes.join("")).toContain("]1337;File=");
    writes.length = 0;
    // Only the input row changes: the image is not re-sent.
    screen.draw(frame([...rows.slice(0, 10), "input!"], [image()]));
    expect(writes.join("")).not.toContain("]1337;File=");
  });

  it("sends the image again when it moves or the rows under it are redrawn", () => {
    const { io, writes } = fakeIO();
    const screen = new Screen(io);
    screen.enter(() => undefined);
    const rows = ["h", "", "", "", "", "", "", "", "", "footer", "input"];
    screen.draw(frame(rows, [image()]));
    writes.length = 0;
    screen.draw(frame(rows, [image({ row: 6 })]));
    expect(writes.join("")).toContain("]1337;File=");
    writes.length = 0;
    const changed = rows.slice();
    changed[6] = "text over the picture";
    screen.draw(frame(changed, [image({ row: 6 })]));
    expect(writes.join("")).toContain("]1337;File=");
  });

  it("repaints everything after invalidate (a resize)", () => {
    const { io, writes } = fakeIO();
    const screen = new Screen(io);
    screen.enter(() => undefined);
    screen.draw(frame(["a", "b"]));
    screen.invalidate();
    writes.length = 0;
    screen.draw(frame(["a", "b"]));
    expect(writes[0]).toContain("\u001b[1;1Ha");
    expect(writes[0]).toContain("\u001b[2;1Hb");
  });

  it("draws nothing once the terminal has been given back", () => {
    const { io, writes } = fakeIO();
    const screen = new Screen(io);
    screen.draw(frame(["x"]));
    expect(writes).toEqual([]);
  });
});

describe("inline images", () => {
  it("writes the iTerm2 inline-image sequence with the size in cells", () => {
    const seq = inlineImageSequence({ b64: "QUJD", cols: 30, rows: 8, name: "a b.png" });
    expect(seq.startsWith("\u001b]1337;File=")).toBe(true);
    expect(seq).toContain("inline=1;width=30;height=8;preserveAspectRatio=1:QUJD");
    expect(seq).toContain(`name=${Buffer.from("a b.png").toString("base64")}`);
    expect(seq.endsWith("\u0007")).toBe(true);
  });

  it("only guesses inline support in terminals known to draw images, and can be forced", () => {
    const env = (e: Record<string, string>) => e as NodeJS.ProcessEnv;
    expect(supportsInlineImages(env({ TERM_PROGRAM: "iTerm.app" }))).toBe(true);
    expect(supportsInlineImages(env({ TERM_PROGRAM: "WezTerm" }))).toBe(true);
    expect(supportsInlineImages(env({ TERM_PROGRAM: "kai" }))).toBe(true);
    expect(supportsInlineImages(env({ WT_SESSION: "1" }))).toBe(false);
    expect(supportsInlineImages(env({}))).toBe(false);
    expect(supportsInlineImages(env({ KAI_TEAMS_IMAGES: "inline" }))).toBe(true);
    expect(supportsInlineImages(env({ TERM_PROGRAM: "iTerm.app", KAI_TEAMS_IMAGES: "off" }))).toBe(
      false
    );
  });
});
