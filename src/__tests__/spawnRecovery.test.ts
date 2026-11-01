import { describe, expect, it } from "vitest";
import { describeCwdFallback, isWorkingDirectoryError } from "../services/spawnRecovery";

describe("isWorkingDirectoryError", () => {
  it("recognises every message the backend raises for a bad folder", () => {
    for (const msg of [
      "Invalid working directory: Working directory 'Z:\\gone' does not exist",
      "Invalid working directory: Working directory path exceeds 4096 bytes",
      "invalid working directory: x",
      "Error: Invalid working directory: path 'C:\\f.txt' is a file, not a directory",
    ]) {
      expect(isWorkingDirectoryError(msg), msg).toBe(true);
    }
  });

  it("does not treat other spawn failures as a folder problem (they must reach the error UI)", () => {
    for (const msg of [
      "Shell executable not found: C:\\nope\\pwsh.exe",
      "PTY creation failed: Unable to determine Windows version",
      "Lock failure: poisoned",
      "",
    ]) {
      expect(isWorkingDirectoryError(msg), msg).toBe(false);
    }
  });
});

describe("describeCwdFallback", () => {
  it("names the folder that was not available", () => {
    expect(describeCwdFallback("Z:\\gone")).toContain("Z:\\gone");
    expect(describeCwdFallback("Z:\\gone")).toMatch(/home folder/i);
  });
});
