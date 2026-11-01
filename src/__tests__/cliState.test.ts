import type { SpawnSyncReturns } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `kai close` really kills processes: the runClose tests must never reach the real tool.
const closeKaiAppMock = vi.hoisted(() => vi.fn());

vi.mock("../cli/desktopApp", async (importOriginal) => {
  const original = await importOriginal<typeof import("../cli/desktopApp")>();
  return { ...original, closeKaiApp: closeKaiAppMock };
});

import { clearActiveProjectState, saveActiveProjectState } from "../cli/activeProject";
import { runClose } from "../cli/commands/desktop";
import { runCli } from "../cli/index";
import { launchKaiApp } from "../cli/desktopApp";

// The module above is mocked; the real implementation is what these tests exercise.
const { closeKaiApp: realCloseKaiApp } =
  await vi.importActual<typeof import("../cli/desktopApp")>("../cli/desktopApp");

let kaiHome: string;
let savedKaiHome: string | undefined;
let logs: string[];
let errors: string[];

beforeEach(() => {
  savedKaiHome = process.env.KAI_HOME;
  kaiHome = fs.mkdtempSync(path.join(os.tmpdir(), "kai-cli-state-"));
  process.env.KAI_HOME = kaiHome;
  logs = [];
  errors = [];
  vi.spyOn(console, "log").mockImplementation((...a) => void logs.push(a.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...a) => void errors.push(a.join(" ")));
});

afterEach(() => {
  vi.restoreAllMocks();
  closeKaiAppMock.mockReset();
  if (savedKaiHome === undefined) delete process.env.KAI_HOME;
  else process.env.KAI_HOME = savedKaiHome;
  fs.rmSync(kaiHome, { recursive: true, force: true });
});

const activeFile = () => path.join(kaiHome, "active_project.json");

describe("saveActiveProjectState", () => {
  it("writes the state atomically and reports success", () => {
    expect(saveActiveProjectState("/repo/app", "app", "0123456789abcdef")).toBe(true);

    const saved = JSON.parse(fs.readFileSync(activeFile(), "utf-8"));
    expect(saved).toMatchObject({
      id: "0123456789abcdef",
      name: "app",
      path: "/repo/app",
      mode: "code",
    });
    expect(typeof saved.timestamp).toBe("number");
    expect(fs.readdirSync(kaiHome).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("keeps the previous state intact when the replacement cannot be written", () => {
    saveActiveProjectState("/repo/old", "old", "1111111111111111");
    const before = fs.readFileSync(activeFile(), "utf-8");
    vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw Object.assign(new Error("denied"), { code: "ENOSPC" });
    });

    expect(saveActiveProjectState("/repo/new", "new", "2222222222222222")).toBe(false);

    vi.restoreAllMocks();
    expect(fs.readFileSync(activeFile(), "utf-8")).toBe(before);
  });

  it("returns false and warns, rather than staying silent, when it cannot save", () => {
    // KAI_HOME is a regular file, so no directory can be made under it.
    const blocker = path.join(kaiHome, "blocker");
    fs.writeFileSync(blocker, "x");
    process.env.KAI_HOME = blocker;

    expect(saveActiveProjectState("/repo/app", "app", "0123456789abcdef")).toBe(false);

    expect(errors.join("\n")).toContain("could not save Code Mode state");
  });
});

describe("clearActiveProjectState", () => {
  it("returns true for absent state, a removed file, or another project's state", () => {
    expect(clearActiveProjectState()).toBe(true);

    saveActiveProjectState("/repo/app", "app", "0123456789abcdef");
    expect(clearActiveProjectState("/repo/other")).toBe(true);
    expect(fs.existsSync(activeFile())).toBe(true);

    expect(clearActiveProjectState("/repo/app")).toBe(true);
    expect(fs.existsSync(activeFile())).toBe(false);
  });

  it("returns false when the state exists but cannot be removed", () => {
    // A non-empty directory in its place cannot be unlinked on any OS.
    fs.mkdirSync(activeFile());
    fs.writeFileSync(path.join(activeFile(), "inside"), "x");

    expect(clearActiveProjectState()).toBe(false);
  });

  it("`kai stop` does not claim success when the state could not be cleared", async () => {
    fs.mkdirSync(activeFile());
    fs.writeFileSync(path.join(activeFile(), "inside"), "x");

    expect(await runCli(["node", "kai", "stop"])).toBe(1);

    expect(errors.join("\n")).toContain("could not clear");
    expect(logs.join("\n")).not.toContain("Code Mode cleared");
  });
});

describe("kai config set", () => {
  it("writes config.json atomically", async () => {
    expect(await runCli(["node", "kai", "config", "set", "defaultTokenBudget", "3000"])).toBe(0);

    const saved = JSON.parse(fs.readFileSync(path.join(kaiHome, "config.json"), "utf-8"));
    expect(saved.defaultTokenBudget).toBe(3000);
    expect(fs.readdirSync(kaiHome).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("never leaves a truncated config when the write fails", async () => {
    await runCli(["node", "kai", "config", "set", "defaultTokenBudget", "3000"]);
    const file = path.join(kaiHome, "config.json");
    const before = fs.readFileSync(file, "utf-8");
    vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw Object.assign(new Error("denied"), { code: "ENOSPC" });
    });

    await runCli(["node", "kai", "config", "set", "defaultTokenBudget", "4000"]).catch(() => 1);

    vi.restoreAllMocks();
    expect(fs.readFileSync(file, "utf-8")).toBe(before);
    expect(JSON.parse(before).defaultTokenBudget).toBe(3000);
  });
});

function spawnResult(
  status: number | null,
  stdout = "",
  stderr = "",
  error?: Error
): SpawnSyncReturns<string> {
  return { status, stdout, stderr, error, pid: 1, output: [], signal: null };
}

describe("closeKaiApp", () => {
  it("on Windows force-kills only the two Kai image names and reads taskkill's exit status", () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const run = vi.fn((cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      return args[2] === "kai.exe"
        ? spawnResult(
            0,
            'SUCCESS: The process "kai.exe" with PID 1 has been terminated.\r\nSUCCESS: x\r\n'
          )
        : spawnResult(
            128,
            "",
            'ERROR: The process "cross-platform-terminal-backend.exe" not found.'
          );
    });

    const results = realCloseKaiApp(run as never, "win32");

    expect(calls).toEqual([
      { cmd: "taskkill", args: ["/F", "/IM", "kai.exe"] },
      { cmd: "taskkill", args: ["/F", "/IM", "cross-platform-terminal-backend.exe"] },
    ]);
    expect(results).toEqual([
      { name: "kai.exe", outcome: "closed", count: 2 },
      { name: "cross-platform-terminal-backend.exe", outcome: "none" },
    ]);
  });

  it("reports taskkill failures with the reason instead of claiming success", () => {
    const run = vi.fn(() => spawnResult(1, "", "ERROR: Access is denied.\r\nmore"));

    const [first] = realCloseKaiApp(run as never, "win32");

    expect(first).toEqual({
      name: "kai.exe",
      outcome: "failed",
      detail: "ERROR: Access is denied.",
    });
  });

  it("reports a tool that cannot be started", () => {
    const run = vi.fn(() => spawnResult(null, "", "", new Error("spawn taskkill ENOENT")));

    expect(realCloseKaiApp(run as never, "win32")[0]).toMatchObject({
      outcome: "failed",
      detail: "spawn taskkill ENOENT",
    });
  });

  it("on POSIX uses exact-name pkill (no -9) and maps exit 0 / 1 / other", () => {
    const statuses: Record<string, number> = {
      kai: 0,
      "cross-platform-terminal-backend": 1,
      "kai-terminal": 2,
    };
    const calls: string[][] = [];
    const run = vi.fn((_cmd: string, args: string[]) => {
      calls.push(args);
      return spawnResult(statuses[args[1]], "", statuses[args[1]] === 2 ? "pkill: bad usage" : "");
    });

    const results = realCloseKaiApp(run as never, "linux");

    expect(calls).toEqual([
      ["-x", "kai"],
      ["-x", "cross-platform-terminal-backend"],
      ["-x", "kai-terminal"],
    ]);
    expect(results.map((r) => r.outcome)).toEqual(["closed", "none", "failed"]);
    expect(results[2].detail).toBe("pkill: bad usage");
  });
});

describe("kai close output", () => {
  it("says what was closed", async () => {
    closeKaiAppMock.mockReturnValue([
      { name: "kai.exe", outcome: "closed", count: 2 },
      { name: "cross-platform-terminal-backend.exe", outcome: "none" },
    ]);

    expect(await runClose()).toBe(0);

    expect(logs.join("\n")).toContain("Closed Kai Terminal (kai.exe x2)");
    expect(logs.join("\n")).not.toContain("instances closed");
  });

  it("says plainly when nothing was running", async () => {
    closeKaiAppMock.mockReturnValue([{ name: "kai.exe", outcome: "none" }]);

    expect(await runClose()).toBe(0);

    expect(logs.join("\n")).toContain("No running Kai Terminal instance found");
  });

  it("fails with the reason when a process could not be closed", async () => {
    closeKaiAppMock.mockReturnValue([
      { name: "kai.exe", outcome: "failed", detail: "Access is denied." },
    ]);

    expect(await runClose()).toBe(1);

    expect(errors.join("\n")).toContain("could not close kai.exe: Access is denied.");
    expect(logs.join("\n")).not.toContain("Closed Kai Terminal");
    expect(logs.join("\n")).not.toContain("No running");
  });
});

describe("launchKaiApp", () => {
  it("reports a binary that cannot be started instead of crashing on the 'error' event", async () => {
    const missing = path.join(kaiHome, "does-not-exist", "kai");

    await expect(launchKaiApp(missing, kaiHome)).resolves.toBe(false);

    expect(errors.join("\n")).toContain(`Could not start ${missing}`);
  });
});
