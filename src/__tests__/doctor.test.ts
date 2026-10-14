import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { parseDesktopEntry, resolveExecTarget, auditDesktopFile } from "../cli/index";

describe("parseDesktopEntry", () => {
  it("parses the Desktop Entry section with lowercased keys", () => {
    const parsed = parseDesktopEntry(
      "[Desktop Entry]\nName=Kai Terminal\nExec=/usr/bin/kai-terminal %F\nIcon=kai\nType=Application\n"
    );
    expect(parsed["name"]).toBe("Kai Terminal");
    expect(parsed["exec"]).toBe("/usr/bin/kai-terminal %F");
    expect(parsed["icon"]).toBe("kai");
  });

  it("ignores other sections, comments, and blanks", () => {
    const parsed = parseDesktopEntry(
      "# comment\n[Other]\nName=Nope\n\n[Desktop Entry]\nName=Yep\n"
    );
    expect(parsed["name"]).toBe("Yep");
  });
});

describe("resolveExecTarget", () => {
  it("resolves absolute paths that exist", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kai-doctor-"));
    const exe = path.join(tmp, "fakebin");
    fs.writeFileSync(exe, "x");
    try {
      expect(resolveExecTarget(`"${exe}" %F`)).toBe(exe);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("returns null for missing targets and bare field codes", () => {
    expect(resolveExecTarget("/non_existent_xyz_12345/app")).toBeNull();
    expect(resolveExecTarget("%f")).toBeNull();
    expect(resolveExecTarget("")).toBeNull();
  });
});

describe("auditDesktopFile", () => {
  it("audits Name/Exec/Icon and flags a missing Exec target", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kai-doctor-"));
    const file = path.join(tmp, "kai.desktop");
    fs.writeFileSync(
      file,
      "[Desktop Entry]\nName=kai\nExec=/non_existent_xyz_12345/kai %F\nIcon=kai-no-such-icon-xyz\nType=Application\n"
    );
    try {
      const audit = auditDesktopFile(file);
      expect(audit?.name).toBe("kai");
      expect(audit?.execFound).toBe(false);
      expect(audit?.execTarget).toBeNull();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("returns null for unreadable files", () => {
    expect(auditDesktopFile(path.join(os.tmpdir(), "kai-no-such-file-xyz.desktop"))).toBeNull();
  });
});

describe("kai doctor command", () => {
  let savedKaiHome: string | undefined;
  let tmpBase: string;

  beforeEach(() => {
    savedKaiHome = process.env.KAI_HOME;
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "kai-doctor-home-"));
    process.env.KAI_HOME = path.join(tmpBase, "kai_home");
  });

  afterEach(() => {
    if (savedKaiHome === undefined) delete process.env.KAI_HOME;
    else process.env.KAI_HOME = savedKaiHome;
    fs.rmSync(tmpBase, { recursive: true, force: true });
  });

  it("exits 0 and prints the diagnostics report", async () => {
    const { runCli } = await import("../cli/index");
    const lines: string[] = [];
    const origLog = console.log;
    console.log = (...a: unknown[]) => {
      lines.push(a.map(String).join(" "));
    };
    try {
      expect(await runCli(["node", "kai", "doctor"])).toBe(0);
    } finally {
      console.log = origLog;
    }
    expect(lines.some((l) => l.includes("Doctor"))).toBe(true);
    expect(lines.some((l) => l.includes("Platform:"))).toBe(true);
  });
});
