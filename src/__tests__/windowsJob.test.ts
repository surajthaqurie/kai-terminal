import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runExternalAgentCommand } from "../core/codeModeWorkflow";
import {
  JOB_HELPER_PROTOCOL,
  killJob,
  probeJobHelper,
  quoteWindowsArg,
  windowsCommandLine,
} from "../core/windowsJob";

describe("Windows command-line quoting", () => {
  it("leaves plain arguments alone and quotes the rest like libuv", () => {
    expect(quoteWindowsArg("plain")).toBe("plain");
    expect(quoteWindowsArg("")).toBe('""');
    expect(quoteWindowsArg("a b")).toBe('"a b"');
    expect(quoteWindowsArg('q"uote')).toBe('"q\\"uote"');
    expect(quoteWindowsArg("trail\\ ing\\")).toBe('"trail\\ ing\\\\"');
    expect(quoteWindowsArg('x\\"y z')).toBe('"x\\\\\\"y z"');
    expect(quoteWindowsArg("C:\\path\\no-space")).toBe("C:\\path\\no-space");
  });

  it("joins verbatim args untouched but always quotes the program", () => {
    expect(windowsCommandLine("C:\\A B\\x.exe", ["a b", "c"])).toBe('"C:\\A B\\x.exe" "a b" c');
    expect(windowsCommandLine("C:\\A B\\cmd.exe", ["/d", "/s", "/c", '""x" ^"y^""'], true)).toBe(
      '"C:\\A B\\cmd.exe" /d /s /c ""x" ^"y^""'
    );
  });
});

describe("job helper protocol", () => {
  it("accepts only a binary that answers the exact protocol line", () => {
    const answer = (status: number, stdout: string) =>
      (() => ({ status, stdout })) as unknown as typeof import("node:child_process").spawnSync;
    expect(probeJobHelper("x", { run: answer(0, `${JOB_HELPER_PROTOCOL}\r\n`) })).toBe(true);
    expect(probeJobHelper("x", { run: answer(0, "kai-job 2") })).toBe(false);
    // An older desktop binary prints its CLI pointer instead.
    expect(probeJobHelper("x", { run: answer(1, "Use the kai CLI") })).toBe(false);
  });

  it("maps the kill helper's exit codes", () => {
    const exit = (status: number | null) =>
      (() => ({ status })) as unknown as typeof import("node:child_process").spawnSync;
    expect(killJob("x", "kai-run-1", { run: exit(0) })).toBe("stopped");
    expect(killJob("x", "kai-run-1", { run: exit(2) })).toBe("no-such-job");
    expect(killJob("x", "kai-run-1", { run: exit(3) })).toBe("still-running");
    expect(killJob("x", "kai-run-1", { run: exit(null) })).toBe("failed");
  });
});

// End to end on Windows against a real helper. Build one with
//   cargo build --no-default-features --bin kai   (in src-tauri)
// and point KAI_TEST_JOB_HELPER at the kai.exe it produced.
const helper = process.env.KAI_TEST_JOB_HELPER ?? "";
const e2e = process.platform === "win32" && helper !== "" && fs.existsSync(helper);

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(file: string, ms = 10000): Promise<string> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fs.existsSync(file) && fs.readFileSync(file, "utf8").trim()) {
      return fs.readFileSync(file, "utf8").trim();
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${file}`);
}

/**
 * A command whose launcher child starts a DETACHED grandchild, records its pid
 * and exits, so the grandchild has no living parent link back to the command
 * (out of reach of `taskkill /T`). The command then waits, or exits itself.
 */
function detachingScript(pidFile: string, thenExit: boolean): string {
  const launcher = [
    "const { spawn } = require('child_process');",
    "const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'],",
    "  { detached: true, stdio: 'ignore', windowsHide: true });",
    "g.unref();",
    `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(g.pid));`,
    "process.exit(0);",
  ].join("\n");
  return [
    "const { spawnSync } = require('child_process');",
    `spawnSync(process.execPath, ['-e', ${JSON.stringify(launcher)}], { stdio: 'ignore', windowsHide: true });`,
    thenExit ? "process.exit(0);" : "setInterval(() => {}, 1000);",
  ].join("\n");
}

describe.skipIf(!e2e)("kai run inside a Windows Job Object (real helper)", () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "kai-job-"));

  it("the helper answers the probe", () => {
    expect(probeJobHelper(helper)).toBe(true);
  });

  it("passes arguments through exactly and returns the exit code", async () => {
    const dir = tmp();
    const out = path.join(dir, "argv.json");
    const script = `require('fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.argv.slice(1))); process.exit(7);`;
    const args = ["-e", script, "a b", 'q"uote', "trail\\", ""];
    const r = await runExternalAgentCommand(process.execPath, args, { jobHelper: helper });
    expect(r.exitCode).toBe(7);
    expect(JSON.parse(fs.readFileSync(out, "utf8"))).toEqual(["a b", 'q"uote', "trail\\", ""]);
  }, 20000);

  it("a timeout stops a detached grandchild too", async () => {
    const dir = tmp();
    const pidFile = path.join(dir, "pid");
    const run = runExternalAgentCommand(process.execPath, ["-e", detachingScript(pidFile, false)], {
      jobHelper: helper,
      timeoutMs: 1500,
    });
    const grandchild = Number(await waitFor(pidFile));
    expect(alive(grandchild)).toBe(true);
    const r = await run;
    expect(r.outcome).toBe("timeout");
    expect(r.descendantsMaySurvive).toBe(false);
    expect(alive(grandchild)).toBe(false);
  }, 30000);

  it("a command that exits normally keeps the background process it started", async () => {
    const dir = tmp();
    const pidFile = path.join(dir, "pid");
    const r = await runExternalAgentCommand(
      process.execPath,
      ["-e", detachingScript(pidFile, true)],
      {
        jobHelper: helper,
      }
    );
    const grandchild = Number(await waitFor(pidFile));
    try {
      expect(r.outcome).toBe("exited");
      expect(alive(grandchild)).toBe(true);
    } finally {
      try {
        process.kill(grandchild);
      } catch {
        // already gone
      }
    }
  }, 30000);

  it("without the helper the detached grandchild survives (why the job is needed)", async () => {
    const dir = tmp();
    const pidFile = path.join(dir, "pid");
    const run = runExternalAgentCommand(process.execPath, ["-e", detachingScript(pidFile, false)], {
      timeoutMs: 1500,
    });
    const grandchild = Number(await waitFor(pidFile));
    const r = await run;
    try {
      expect(r.descendantsMaySurvive).toBe(true);
      expect(alive(grandchild)).toBe(true);
    } finally {
      try {
        process.kill(grandchild);
      } catch {
        // already gone
      }
    }
  }, 30000);
});
