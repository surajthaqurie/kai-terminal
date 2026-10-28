import { describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { symlinkOrSkip } from "./helpers/symlink";

// A skip here would hide exactly the coverage the helper exists to provide, so
// these use a context whose skip() fails the test instead of skipping it.
const noSkip = {
  skip: () => {
    throw new Error("symlinkOrSkip skipped where it must not");
  },
};

describe("symlinkOrSkip", () => {
  it("links a directory on every OS (junction on Windows) without skipping", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-symhelper-"));
    try {
      const target = path.join(dir, "real");
      fs.mkdirSync(target);
      fs.writeFileSync(path.join(target, "a.txt"), "a");
      const link = path.join(dir, "link");

      symlinkOrSkip(noSkip, target, link);

      expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
      expect(fs.realpathSync(link)).toBe(fs.realpathSync(target));
      expect(fs.readFileSync(path.join(link, "a.txt"), "utf8")).toBe("a");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // Registered only off Windows (not skipIf) so Windows runs report no extra skip.
  if (process.platform !== "win32") {
    it("links a file without skipping on Linux and macOS", () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-symhelper-"));
      try {
        const target = path.join(dir, "real.txt");
        fs.writeFileSync(target, "x");
        const link = path.join(dir, "link.txt");

        symlinkOrSkip(noSkip, target, link);

        expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
        expect(fs.readFileSync(link, "utf8")).toBe("x");
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});
