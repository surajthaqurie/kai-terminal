import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

/**
 * ARCH-06: the app version lives in several files and is edited by hand at release time. The
 * release workflow checks it for a tag, which is late; this fails an ordinary CI run as soon as
 * one of them is left behind.
 */
const root = path.resolve(__dirname, "../..");
const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");

function cargoVersion(): string {
  const m = /^\[package\][\s\S]*?^version\s*=\s*"([^"]+)"/m.exec(read("src-tauri/Cargo.toml"));
  if (!m) throw new Error("no version in src-tauri/Cargo.toml");
  return m[1];
}

function cargoLockVersion(): string | null {
  const m = /\[\[package\]\]\s*\nname = "kai"\s*\nversion = "([^"]+)"/.exec(
    read("src-tauri/Cargo.lock")
  );
  return m ? m[1] : null;
}

describe("the app version is the same everywhere it is written", () => {
  const pkg = JSON.parse(read("package.json")).version as string;

  it("package.json, package-lock.json, tauri.conf.json and Cargo.toml agree", () => {
    const lock = JSON.parse(read("package-lock.json"));
    expect(lock.version).toBe(pkg);
    expect(lock.packages[""].version).toBe(pkg);
    expect(JSON.parse(read("src-tauri/tauri.conf.json")).version).toBe(pkg);
    expect(cargoVersion()).toBe(pkg);
  });

  it("Cargo.lock names the same version for the app's own crate", () => {
    expect(cargoLockVersion()).toBe(pkg);
  });
});
