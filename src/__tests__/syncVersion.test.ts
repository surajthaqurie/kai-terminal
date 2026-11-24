import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * ARCH-06: `npm run version:sync` copies package.json's version to every file that repeats it.
 * Run on a copy of the real files, so a change in any of their layouts breaks this test, not a
 * release.
 */
const root = path.resolve(__dirname, "../..");
const FILES = [
  "package.json",
  "package-lock.json",
  "src-tauri/tauri.conf.json",
  "src-tauri/Cargo.toml",
  "src-tauri/Cargo.lock",
  "kai-website/package.json",
  "kai-website/package-lock.json",
  "README.md",
  "INSTALL.md",
  "scripts/sync-version.mjs",
];

let dir = "";
afterEach(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  dir = "";
});

function copyRepo(): (rel: string) => string {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-version-"));
  for (const rel of FILES) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.copyFileSync(path.join(root, rel), path.join(dir, rel));
  }
  return (rel) => fs.readFileSync(path.join(dir, rel), "utf8");
}

const run = (...args: string[]) =>
  execFileSync(process.execPath, [path.join(dir, "scripts/sync-version.mjs"), ...args], {
    encoding: "utf8",
    stdio: "pipe",
  });

describe("version:sync (ARCH-06)", () => {
  it("writes the package.json version to every other file, and nothing else", () => {
    const read = copyRepo();
    const old = JSON.parse(read("package.json")).version as string;
    const pkg = read("package.json").replace(`"version": "${old}"`, `"version": "9.8.7"`);
    fs.writeFileSync(path.join(dir, "package.json"), pkg);
    const lockBefore = read("package-lock.json");

    expect(() => run("--check")).toThrow();
    run();
    expect(() => run("--check")).not.toThrow();

    const lock = JSON.parse(read("package-lock.json"));
    expect(lock.version).toBe("9.8.7");
    expect(lock.packages[""].version).toBe("9.8.7");
    expect(JSON.parse(read("src-tauri/tauri.conf.json")).version).toBe("9.8.7");
    expect(read("src-tauri/Cargo.toml")).toMatch(/^\[package\][\s\S]*?^version = "9\.8\.7"/m);
    expect(read("src-tauri/Cargo.lock")).toContain('name = "kai"\nversion = "9.8.7"');
    expect(JSON.parse(read("kai-website/package.json")).version).toBe("9.8.7");
    expect(read("README.md")).toContain("kai_9.8.7_x64-setup.exe");
    expect(read("README.md")).not.toContain(`kai_${old}_`);
    expect(read("INSTALL.md")).toContain("kai-9.8.7-1.x86_64.rpm");

    // Only the two root version lines of the lock file changed: no dependency was touched.
    const after = read("package-lock.json").split("\n");
    expect(lockBefore.split("\n").filter((line, i) => line !== after[i])).toHaveLength(2);
  });

  it("refuses a version that is not x.y.z", () => {
    const read = copyRepo();
    const old = JSON.parse(read("package.json")).version as string;
    fs.writeFileSync(
      path.join(dir, "package.json"),
      read("package.json").replace(`"version": "${old}"`, `"version": "next"`)
    );
    expect(() => run()).toThrow();
    expect(JSON.parse(read("src-tauri/tauri.conf.json")).version).toBe(old);
  });
});
