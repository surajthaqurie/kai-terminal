// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { installedFontStack, isMonospaceBy, filterMonospace } from "../services/systemFonts";

// Fake text measurer: every glyph is 10px in "Mono", "i" is narrow in anything else.
const measure = (font: string, text: string) => {
  const mono = font.includes('"Mono"');
  return [...text].reduce((w, ch) => w + (mono || ch !== "i" ? 10 : 4), 0);
};

describe("installed font list", () => {
  it("keeps fixed-pitch families and drops proportional or missing ones", () => {
    expect(isMonospaceBy(measure, "Mono")).toBe(true);
    expect(isMonospaceBy(measure, "Arial")).toBe(false);
  });

  it("rejects names that could break out of the CSS font string", () => {
    expect(isMonospaceBy(measure, 'Mono", evil')).toBe(false);
    expect(isMonospaceBy(measure, "")).toBe(false);
  });

  it("builds a quoted font stack with a monospace fallback", () => {
    expect(installedFontStack("Cascadia Code")).toBe('"Cascadia Code", monospace');
  });
});

describe("font list helpers", () => {
  it("reads the first family of a CSS stack", async () => {
    const { primaryFamily } = await import("../services/systemFonts");
    expect(primaryFamily('"Fira Code", monospace')).toBe("Fira Code");
    expect(primaryFamily("Consolas, 'Lucida Console', monospace")).toBe("Consolas");
    expect(primaryFamily("ui-monospace, Menlo")).toBe("ui-monospace");
  });
});

describe("filterMonospace curation", () => {
  it("keeps clean coding fonts first and drops symbol, CJK and Courier faces", () => {
    // Every face is fixed-pitch here, so only the curation rules decide.
    const ctx = { font: "", measureText: () => ({ width: 100 }) };
    vi.spyOn(document, "createElement").mockReturnValue({
      getContext: () => ctx,
    } as unknown as HTMLCanvasElement);
    const kept = filterMonospace([
      "Lucida Console",
      "Ubuntu Sans Mono",
      "Marlett",
      "Wingdings 2",
      "Segoe MDL2 Assets",
      "Segoe Fluent Icons",
      "MS Gothic",
      "NSimSun",
      "SimSun",
      "SimSun-ExtB",
      "MS Outlook",
      "MT Extra",
      "OCR A Extended",
      "Courier New",
      "Consolas",
      "Cascadia Mono",
      "Cascadia Code",
    ]);
    vi.restoreAllMocks();
    expect(kept).toEqual([
      "Cascadia Code",
      "Cascadia Mono",
      "Consolas",
      "Ubuntu Sans Mono",
      "Lucida Console",
    ]);
  });
});
