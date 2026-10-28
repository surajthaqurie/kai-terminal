import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { shouldOpenGuiFromBareLaunch } from "../cli/index";
import { auditDesktopFile } from "../cli/index";

/**
 * Regression tests for the "app-drawer click does nothing" bug.
 *
 * Linux .desktop entries ship `Exec=kai`; on machines where the Node CLI
 * shim (~/.local/bin/kai) shadows the GUI binary on PATH, a drawer click ran
 * the CLI with no arguments and no TTY, printed help into nowhere, and
 * exited. The CLI now opens the GUI on that path (see shouldOpenGuiFromBare
 * Launch) and the doctor flags shim-resolving Exec lines.
 */
describe("shouldOpenGuiFromBareLaunch", () => {
  it("is false in test environments (CI smoke probes keep help behavior)", () => {
    // Vitest sets VITEST globally, so a bare runCli stays on the help path.
    expect(shouldOpenGuiFromBareLaunch()).toBe(false);
  });
});

describe("doctor: .desktop Exec resolving to the CLI shim", () => {
  let base: string;
  let savedPath: string | undefined;

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "kai-desktop-shim-"));
    savedPath = process.env.PATH;
  });

  afterEach(() => {
    if (savedPath !== undefined) process.env.PATH = savedPath;
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("flags a shim-resolving Exec and keeps a real binary unflagged", () => {
    // A probe that mimics the CLI: a symlink whose realpath is kai.js.
    const kaiJs = path.join(base, "kai.js");
    fs.writeFileSync(kaiJs, "#!/usr/bin/env node\n// cli bundle bootstrap\n");
    fs.mkdirSync(path.join(base, "bin"));
    fs.symlinkSync(kaiJs, path.join(base, "bin", "kai3"));
    process.env.PATH = path.join(base, "bin");

    const shimEntry = auditDesktopFile(writeDesktop(base, "Exec=kai3\n"));
    expect(shimEntry!.execFound).toBe(true);
    expect(shimEntry!.execIsCliShim).toBe(true);

    // A real ELF-ish binary (large, no shim markers) is not flagged.
    const big = path.join(base, "bin", "kai4");
    fs.writeFileSync(big, Buffer.alloc(9000, 0x7f)); // > 8192 sniff cap
    const realEntry = auditDesktopFile(writeDesktop(base, "Exec=kai4\n"));
    expect(realEntry!.execFound).toBe(true);
    expect(realEntry!.execIsCliShim).toBe(false);
  });

  it("flags a text-shim Exec too (setup:cli fallback writes shell shims)", () => {
    fs.mkdirSync(path.join(base, "bin"));
    fs.writeFileSync(
      path.join(base, "bin", "kai2"),
      '#!/bin/sh\nexec node "/somewhere/kai.js" "$@"\n'
    );
    process.env.PATH = path.join(base, "bin");
    const audit = auditDesktopFile(writeDesktop(base, "Exec=kai2\n"));
    expect(audit!.execFound).toBe(true);
    expect(audit!.execIsCliShim).toBe(true);
  });
});

function writeDesktop(base: string, exec: string): string {
  const file = path.join(base, "kai.desktop");
  fs.writeFileSync(file, `[Desktop Entry]\nName=kai\n${exec}Icon=kai\nType=Application\n`);
  return file;
}
