import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync, spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  dropCwdHits,
  hardenExecutableLookup,
  noCwdLookupEnv,
  systemToolPath,
} from "../core/spawnSafety";

const onWindows = process.platform === "win32";

describe("noCwdLookupEnv", () => {
  it("keeps the caller's variables and never mutates the base environment", () => {
    const base = { FOO: "1" } as NodeJS.ProcessEnv;
    const env = noCwdLookupEnv(base);
    expect(env.FOO).toBe("1");
    expect(base.NoDefaultCurrentDirectoryInExePath).toBeUndefined();
  });

  it.runIf(onWindows)("turns off the current-directory command lookup on Windows", () => {
    expect(noCwdLookupEnv({}).NoDefaultCurrentDirectoryInExePath).toBe("1");
  });

  it.runIf(!onWindows)("is a no-op where the cwd is never searched", () => {
    const base = { FOO: "1" } as NodeJS.ProcessEnv;
    expect(noCwdLookupEnv(base)).toBe(base);
  });
});

describe.runIf(onWindows)("dropCwdHits (where.exe lists the cwd first)", () => {
  const cwd = "C:\\Users\\me\\cloned-repo";
  const real = "C:\\Tools\\kai.exe";

  it("drops a planted binary in the working directory", () => {
    const hits = [`${cwd}\\kai.exe`, real];
    expect(dropCwdHits(hits, cwd, { PATH: "C:\\Tools" })).toEqual([real]);
  });

  it("matches case-insensitively and ignores a trailing separator", () => {
    const planted = ["c:\\users\\ME\\cloned-repo\\kai.exe"];
    expect(dropCwdHits(planted, `${cwd}\\`, { PATH: "" })).toEqual([]);
  });

  it("keeps it when the user really has that directory on PATH", () => {
    const hits = [`${cwd}\\kai.exe`];
    expect(dropCwdHits(hits, cwd, { PATH: `C:\\Tools;${cwd}` })).toEqual(hits);
  });
});

describe.runIf(onWindows)("a planted command in the project folder is not run", () => {
  it("runs a same-named .cmd from the cwd without the flag, but not with it", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-planted-"));
    try {
      fs.writeFileSync(path.join(dir, "kaiplanted.cmd"), "@echo PLANTED-RAN\r\n");
      const run = (env: NodeJS.ProcessEnv) => {
        try {
          return execSync("kaiplanted --version", {
            cwd: dir,
            env,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
          });
        } catch {
          return "";
        }
      };
      // Windows environment names are case-insensitive but a copied object is not.
      const base = Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) => key.toLowerCase() !== "nodefaultcurrentdirectoryinexepath"
        )
      );
      // Documents the hazard (and guards the premise of the fix)...
      expect(run(base)).toContain("PLANTED-RAN");
      // ...and the fix.
      expect(run(noCwdLookupEnv(base))).not.toContain("PLANTED-RAN");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("hardenExecutableLookup", () => {
  it("sets the flag in the given environment on Windows only", () => {
    const winEnv = {} as NodeJS.ProcessEnv;
    expect(hardenExecutableLookup(winEnv, "win32")).toBe(true);
    expect(winEnv.NoDefaultCurrentDirectoryInExePath).toBe("1");
    expect(hardenExecutableLookup(winEnv, "win32")).toBe(false); // idempotent

    const posixEnv = {} as NodeJS.ProcessEnv;
    expect(hardenExecutableLookup(posixEnv, "linux")).toBe(false);
    expect(posixEnv.NoDefaultCurrentDirectoryInExePath).toBeUndefined();
  });
});

describe("systemToolPath", () => {
  it("returns an absolute System32 path on Windows, independent of PATH and cwd", () => {
    const env = { SystemRoot: "C:\\Windows\\" } as NodeJS.ProcessEnv;
    expect(systemToolPath("taskkill.exe", "win32", env)).toBe(
      "C:\\Windows\\System32\\taskkill.exe"
    );
    expect(systemToolPath("cmd", "win32", env)).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(systemToolPath("PowerShell.exe", "win32", env)).toBe(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\PowerShell.exe"
    );
  });

  it("falls back to %windir% and then the default Windows directory", () => {
    expect(systemToolPath("where.exe", "win32", { windir: "D:\\WIN" } as never)).toBe(
      "D:\\WIN\\System32\\where.exe"
    );
    expect(systemToolPath("where.exe", "win32", {} as never)).toBe(
      "C:\\Windows\\System32\\where.exe"
    );
  });

  it("leaves the bare name alone elsewhere", () => {
    expect(systemToolPath("taskkill.exe", "linux")).toBe("taskkill.exe");
  });
});

/**
 * The real hazard: libuv resolves `spawn("git")` / `spawn("cmd.exe")` in the
 * PARENT, in the working directory first. The child-env flag does not help;
 * the flag must be in this process's own environment.
 */
describe.runIf(onWindows)("a planted executable in the cwd is never spawned", () => {
  const savedCwd = process.cwd();
  const savedFlag = process.env.NoDefaultCurrentDirectoryInExePath;
  let dir = "";

  afterEach(() => {
    process.chdir(savedCwd);
    if (savedFlag === undefined) delete process.env.NoDefaultCurrentDirectoryInExePath;
    else process.env.NoDefaultCurrentDirectoryInExePath = savedFlag;
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = "";
  });

  it("spawns the system tool, not a same-named exe planted in the working directory", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-plant-"));
    const system32 = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32");
    // A harmless stand-in: hostname.exe prints the host name and rejects the arguments below.
    for (const name of ["cmd.exe", "powershell.exe", "git.exe"]) {
      fs.copyFileSync(path.join(system32, "hostname.exe"), path.join(dir, name));
    }
    process.chdir(dir);
    delete process.env.NoDefaultCurrentDirectoryInExePath;

    const real = () =>
      spawnSync("cmd.exe", ["/d", "/c", "echo", "REAL-CMD"], { encoding: "utf8" }).stdout ?? "";
    const realViaGit = () => spawnSync("git", ["--version"], { encoding: "utf8" });

    // Premise: without the flag in this process the planted exe wins (the bug).
    expect(real()).not.toContain("REAL-CMD");

    expect(hardenExecutableLookup()).toBe(true);
    expect(real()).toContain("REAL-CMD");
    const git = realViaGit();
    if (!git.error) expect(git.stdout).toMatch(/^git version/);
    // And the absolute-path form never depended on the working directory at all.
    delete process.env.NoDefaultCurrentDirectoryInExePath;
    const abs = spawnSync(systemToolPath("cmd.exe"), ["/d", "/c", "echo", "ABS-CMD"], {
      encoding: "utf8",
    });
    expect(abs.stdout).toContain("ABS-CMD");
  });
});
