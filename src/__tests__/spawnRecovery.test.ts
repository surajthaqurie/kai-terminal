import { describe, expect, it } from "vitest";
import {
  describeCwdFallback,
  describeParentSubstitution,
  isWorkingDirectoryError,
} from "../services/spawnRecovery";
import { normalizeCwdForCompare } from "../services/projectService";

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

describe("describeParentSubstitution (FUNC-12)", () => {
  const note = (a: string, b: string) => describeParentSubstitution(a, b, normalizeCwdForCompare);

  it("says so when the shell opened in an ancestor of the folder asked for", () => {
    expect(note("/work/app/missing", "/work/app")).toContain('"/work/app/missing" does not exist');
    expect(note("C:\\Users\\me\\gone\\deep", "C:\\Users\\me")).toContain("Opened in");
  });

  it("stays quiet when the shell is where it was asked to be, however the path is written", () => {
    expect(note("/work/app", "/work/app")).toBeNull();
    expect(note("/work/app/", "/work/app")).toBeNull();
    expect(note("C:\\Work\\App", "c:/work/app/")).toBeNull();
    expect(note("\\\\?\\C:\\Work", "C:\\Work")).toBeNull();
  });

  it("does not claim a substitution for an unrelated or deeper folder", () => {
    expect(note("/work/app", "/home/me")).toBeNull(); // the home fallback has its own message
    expect(note("/work/app", "/work/app/sub")).toBeNull();
    expect(note("/work/application", "/work/app")).toBeNull(); // a prefix of the NAME is not an ancestor
    expect(note("", "/work")).toBeNull();
  });
});
