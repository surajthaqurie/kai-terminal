import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { runExternalAgentCommand } from "../core/codeModeWorkflow";
import {
  findRunProcesses,
  newRunToken,
  RUN_TOKEN_ENV,
  signalRunProcesses,
  sweepSupported,
} from "../core/processSweep";

const TOKEN = "11111111-2222-3333-4444-555555555555";

describe("process sweep: finding what a run left behind", () => {
  it("is available on Linux and macOS only", () => {
    expect(sweepSupported("linux")).toBe(true);
    expect(sweepSupported("darwin")).toBe(true);
    expect(sweepSupported("win32")).toBe(false);
    expect(findRunProcesses(TOKEN, { platform: "win32" })).toEqual([]);
  });

  it("makes a different token every time", () => {
    expect(newRunToken()).not.toBe(newRunToken());
  });

  it("finds Linux processes by the token in their environment, never this process", () => {
    const environ: Record<number, string | null> = {
      1: `PATH=/bin\0HOME=/root\0`,
      42: `PATH=/bin\0${RUN_TOKEN_ENV}=${TOKEN}\0X=1\0`,
      43: `${RUN_TOKEN_ENV}=${TOKEN}extra\0`, // a longer value is not the token
      44: `${RUN_TOKEN_ENV}=other\0`,
      45: null, // unreadable (another user's)
      99: `${RUN_TOKEN_ENV}=${TOKEN}\0`, // this process
    };
    const found = findRunProcesses(TOKEN, {
      platform: "linux",
      selfPid: 99,
      readProcDir: () => ["1", "42", "43", "44", "45", "99", "self", "cpuinfo"],
      readEnviron: (pid) => environ[pid] ?? null,
    });
    expect(found).toEqual([42]);
  });

  it("finds macOS processes in `ps -E` output", () => {
    const ps = [
      `    1 /sbin/launchd`,
      `  500 /usr/bin/python3 server.py PATH=/usr/bin ${RUN_TOKEN_ENV}=${TOKEN} HOME=/Users/x`,
      `  501 /bin/sleep 100 ${RUN_TOKEN_ENV}=${TOKEN}extra`,
      `  502 /bin/sleep 100 NOT_${RUN_TOKEN_ENV}=${TOKEN}`,
      `   77 /usr/bin/node ${RUN_TOKEN_ENV}=${TOKEN}`,
    ].join("\n");
    expect(
      findRunProcesses(TOKEN, { platform: "darwin", selfPid: 77, psWithEnvironment: () => ps })
    ).toEqual([500]);
    expect(findRunProcesses(TOKEN, { platform: "darwin", psWithEnvironment: () => null })).toEqual(
      []
    );
  });

  it("signals what it found and ignores processes that are already gone", () => {
    const sent: Array<[number, string]> = [];
    const signalled = signalRunProcesses(TOKEN, "SIGKILL", {
      platform: "linux",
      selfPid: 1,
      readProcDir: () => ["10", "11"],
      readEnviron: () => `${RUN_TOKEN_ENV}=${TOKEN}\0`,
      kill: (pid, sig) => {
        if (pid === 11) throw new Error("ESRCH");
        sent.push([pid, sig]);
      },
    });
    expect(signalled).toEqual([10]);
    expect(sent).toEqual([[10, "SIGKILL"]]);
  });
});

// The real thing, on the platforms that can do it: a descendant that left the process group is
// stopped when the run times out, and the result says nothing survived.
describe.skipIf(!sweepSupported())("process sweep: a real detached escapee", () => {
  let dir = "";
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-sweep-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("is stopped on timeout, and the run reports that nothing survived", async () => {
    const marker = path.join(dir, "escapee-wrote.txt");
    const grandchild = `setTimeout(()=>require("fs").writeFileSync(${JSON.stringify(marker)},"alive"), 4000);`;
    // setsid-style escape: a detached child leads its own session and group, and its parent exits.
    const parent =
      `const { spawn } = require("child_process");` +
      `const c = spawn(${JSON.stringify(process.execPath)}, ["-e", ${JSON.stringify(grandchild)}], { detached: true, stdio: "ignore" });` +
      `c.unref(); setTimeout(()=>{}, 30000);`;
    const r = await runExternalAgentCommand(process.execPath, ["-e", parent], {
      cwd: dir,
      timeoutMs: 1000,
    });
    expect(r.outcome).toBe("timeout");
    expect(r.treeKillAttempted).toBe(true);
    expect(r.descendantsMaySurvive).toBe(false);
    await new Promise((res) => setTimeout(res, 5000));
    expect(fs.existsSync(marker)).toBe(false);
  }, 30000);

  it("is stopped on timeout even when it ignores SIGTERM", async () => {
    const marker = path.join(dir, "stubborn-wrote.txt");
    const grandchild = `process.on("SIGTERM",()=>{}); setTimeout(()=>require("fs").writeFileSync(${JSON.stringify(marker)},"alive"), 4000);`;
    const parent =
      `const { spawn } = require("child_process");` +
      `spawn(${JSON.stringify(process.execPath)}, ["-e", ${JSON.stringify(grandchild)}], { detached: true, stdio: "ignore" }).unref();` +
      `process.on("SIGTERM", () => process.exit(0)); setTimeout(()=>{}, 30000);`;
    const r = await runExternalAgentCommand(process.execPath, ["-e", parent], {
      cwd: dir,
      timeoutMs: 1000,
    });
    expect(r.treeKillAttempted).toBe(true);
    expect(r.descendantsMaySurvive).toBe(false);
    await new Promise((res) => setTimeout(res, 5000));
    expect(fs.existsSync(marker)).toBe(false);
  }, 30000);

  it("leaves a process that did not come from the run alone", async () => {
    const r = await runExternalAgentCommand(
      process.execPath,
      ["-e", "setTimeout(()=>{}, 30000);"],
      { cwd: dir, timeoutMs: 500 }
    );
    expect(r.descendantsMaySurvive).toBe(false);
    expect(process.kill(process.pid, 0)).toBe(true); // this test process is still here
  });
});

describe("process sweep: Windows keeps the old guarantee", () => {
  it.skipIf(process.platform !== "win32")(
    "still reports that descendants may survive a termination",
    async () => {
      const r = await runExternalAgentCommand(
        process.execPath,
        ["-e", "setTimeout(()=>{}, 30000);"],
        { timeoutMs: 400 }
      );
      expect(r.treeKillAttempted).toBe(true);
      expect(r.descendantsMaySurvive).toBe(true);
    },
    20000
  );
});
