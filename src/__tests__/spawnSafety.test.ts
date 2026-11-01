import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { dropCwdHits, noCwdLookupEnv } from "../core/spawnSafety";

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
