import { describe, it, expect } from "vitest";
import fs from "fs";
import { symlinkOrSkip } from "./helpers/symlink";
import os from "os";
import path from "path";
import { isKaiCliShim, findKaiAppBinary } from "../cli/index";

describe("isKaiCliShim (CLI/desktop PATH collision guard, all OS)", () => {
  it("detects symlink shims pointing at bin/kai.js", (ctx) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-shim-"));
    const target = path.join(dir, "kai.js");
    fs.writeFileSync(target, "cli");
    const link = path.join(dir, "kai");
    symlinkOrSkip(ctx, target, link);
    expect(isKaiCliShim(link)).toBe(true);
  });

  it("detects shell-shim text launchers (setup:cli fallback)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-shim-"));
    const shim = path.join(dir, "kai");
    fs.writeFileSync(shim, '#!/bin/sh\nexec "/usr/bin/node" "/repo/bin/kai.js" "$@"\n');
    expect(isKaiCliShim(shim)).toBe(true);
  });

  it("does not flag ELF-sized desktop binaries as shims", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-bin-"));
    const bin = path.join(dir, "kai");
    // >8KB without kai.js markers → treated as desktop GUI, never a shim.
    fs.writeFileSync(bin, Buffer.alloc(9000, 0x7f));
    expect(isKaiCliShim(bin)).toBe(false);
  });

  it("findKaiAppBinary never returns a CLI shim", () => {
    // The live environment may or may not have a GUI installed; the
    // invariant is: whatever is returned must not be a shim.
    const found = findKaiAppBinary();
    if (found) expect(isKaiCliShim(found)).toBe(false);
  });
});
