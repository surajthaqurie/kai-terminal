import { describe, expect, it } from "vitest";
import { preparePasteText } from "../services/terminalModes";

describe("preparePasteText", () => {
  it("drops trailing newlines so a paste never auto-submits", () => {
    expect(preparePasteText("ls -la\n", false)).toBe("ls -la");
    expect(preparePasteText("ls -la\r\n\r\n", false)).toBe("ls -la");
  });

  it("keeps embedded newlines as Enter (\r) without bracketed paste", () => {
    expect(preparePasteText("a\nb\n", false)).toBe("a\rb");
  });

  it("wraps in bracketed-paste markers when the shell enabled it", () => {
    expect(preparePasteText("ls\n", true)).toBe("\x1b[200~ls\r\x1b[201~");
  });

  it("does not let clipboard text close the bracketed paste early", () => {
    expect(preparePasteText("a\x1b[201~rm -rf x", true)).toBe("\x1b[200~arm -rf x\x1b[201~");
  });
});
