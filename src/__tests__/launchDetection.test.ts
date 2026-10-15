import { describe, it, expect } from "vitest";
import fs from "fs";
import { symlinkOrSkip } from "./helpers/symlink";
import os from "os";
import path from "path";
import { isKaiDesktopProcessLine, isKaiCliShim, findKaiAppBinary } from "../cli/index";

describe("isKaiDesktopProcessLine (cross-OS duplicate-window guard)", () => {
  it("detects the current 'kai' binary name (Linux comm=Kai, macOS, Windows)", () => {
    expect(isKaiDesktopProcessLine("kai")).toBe(true);
    expect(isKaiDesktopProcessLine("43392 kai")).toBe(true);
    expect(isKaiDesktopProcessLine("kai.exe")).toBe(true);
    expect(isKaiDesktopProcessLine("/usr/bin/kai")).toBe(true);
    expect(isKaiDesktopProcessLine("/usr/local/bin/kai")).toBe(true);
    expect(isKaiDesktopProcessLine("C:\\Program Files\\KaiTerminal\\kai.exe")).toBe(true);
  });

  it("detects legacy binary names on all OSes", () => {
    expect(isKaiDesktopProcessLine("cross-platform-terminal-backend")).toBe(true);
    expect(isKaiDesktopProcessLine("cross-platform-")).toBe(true); // truncated comm (15 chars)
    expect(isKaiDesktopProcessLine("kai-terminal")).toBe(true);
    expect(isKaiDesktopProcessLine("/Applications/Kai Terminal.app/Contents/MacOS/kai")).toBe(true);
    expect(
      isKaiDesktopProcessLine(
        "/Applications/Kai Terminal.app/Contents/MacOS/cross-platform-terminal-backend"
      )
    ).toBe(true);
  });

  it("never mistakes the Node CLI / MCP server for the desktop GUI", () => {
    expect(isKaiDesktopProcessLine("node /repo/bin/kai.js mcp .")).toBe(false);
    expect(isKaiDesktopProcessLine("node /repo/dist/cli/index.js code .")).toBe(false);
    expect(isKaiDesktopProcessLine("node bin/kai.js code .")).toBe(false);
  });

  it("never matches unrelated processes containing 'kai' as a substring", () => {
    expect(isKaiDesktopProcessLine("opencode")).toBe(false);
    expect(isKaiDesktopProcessLine("opencode serve --service")).toBe(false);
    expect(isKaiDesktopProcessLine("kaiman")).toBe(false);
    expect(isKaiDesktopProcessLine("ssh kai@host")).toBe(false);
  });
});

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
