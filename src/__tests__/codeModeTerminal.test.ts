// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { Terminal } from "@xterm/xterm";
import { CODE_MODE_OSC, buildCodeModeSignal, parseCodeModeSignal } from "../core/codeModeSignal";

/** The same handler TerminalView registers, on a REAL xterm parser. */
function terminalReporting(seen: Array<string | null>): Terminal {
  const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
  term.parser.registerOscHandler(CODE_MODE_OSC, (data) => {
    const signal = parseCodeModeSignal(data);
    if (signal) seen.push(signal.active ? signal.path : null);
    return signal !== null;
  });
  return term;
}

const write = (term: Terminal, data: string) =>
  new Promise<void>((resolve) => term.write(data, resolve));

describe("Code Mode signal through the real xterm parser", () => {
  it("reports start and stop between ordinary output, in order", async () => {
    const seen: Array<string | null> = [];
    const term = terminalReporting(seen);
    await write(term, `$ kai claude\r\n${buildCodeModeSignal("C:\Work\My App")}[kai] running\r\n`);
    await write(term, `${buildCodeModeSignal(null)}$ `);
    expect(seen).toEqual(["C:\Work\My App", null]);
    term.dispose();
  });

  it("survives a signal split across output chunks at every byte boundary", async () => {
    const bytes = buildCodeModeSignal("/home/me/proj");
    for (let cut = 1; cut < bytes.length; cut++) {
      const seen: Array<string | null> = [];
      const term = terminalReporting(seen);
      await write(term, `before${bytes.slice(0, cut)}`);
      await write(term, `${bytes.slice(cut)}after`);
      expect(seen).toEqual(["/home/me/proj"]);
      term.dispose();
    }
  });

  it("does not show the escape sequence as text", async () => {
    const term = terminalReporting([]);
    await write(term, `A${buildCodeModeSignal("/p")}B`);
    expect(term.buffer.active.getLine(0)?.translateToString(true)).toBe("AB");
    term.dispose();
  });
});
