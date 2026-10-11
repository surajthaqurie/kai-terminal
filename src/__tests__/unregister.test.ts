import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  registerProject,
  getProjectMeta,
  getProjectStorageDir,
  getProjectLockPath,
  deleteProjectData,
  ProjectLock,
} from "../core/registry";
import { indexProject } from "../core/indexer";
import { assembleContext } from "../core/contextAssembler";
import { estimateTokens } from "../core/tokenCounter";
import { runCli } from "../cli/index";

let kaiHome: string;
let savedKaiHome: string | undefined;

function makeTempProject(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-unreg-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

beforeEach(() => {
  savedKaiHome = process.env.KAI_HOME;
  kaiHome = fs.mkdtempSync(path.join(os.tmpdir(), "kai-home-"));
  process.env.KAI_HOME = kaiHome;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  if (savedKaiHome === undefined) delete process.env.KAI_HOME;
  else process.env.KAI_HOME = savedKaiHome;
  fs.rmSync(kaiHome, { recursive: true, force: true });
});

describe("kai unregister command", () => {
  it("deletes index data for a registered project and reports scope", async () => {
    const dir = makeTempProject({ "src/a.ts": "export function a() {}\n" });
    expect(await runCli(["node", "kai", "code", dir])).toBe(0);
    const meta = getProjectMeta(dir)!;
    expect(fs.existsSync(getProjectStorageDir(meta.id))).toBe(true);

    expect(await runCli(["node", "kai", "unregister", dir, "--dry-run"])).toBe(0);
    expect(fs.existsSync(getProjectStorageDir(meta.id))).toBe(true);

    expect(await runCli(["node", "kai", "unregister", dir])).toBe(0);
    expect(fs.existsSync(getProjectStorageDir(meta.id))).toBe(false);
    // Project is gone: status now reports unregistered
    expect(await runCli(["node", "kai", "status", dir])).toBe(1);
  });

  it("accepts a project id as well as a path", async () => {
    const dir = makeTempProject({ "src/a.ts": "export function a() {}\n" });
    expect(await runCli(["node", "kai", "code", dir])).toBe(0);
    const meta = getProjectMeta(dir)!;
    expect(await runCli(["node", "kai", "unregister", meta.id])).toBe(0);
    expect(fs.existsSync(getProjectStorageDir(meta.id))).toBe(false);
  });

  it("requires a target and fails cleanly for unknown projects", async () => {
    expect(await runCli(["node", "kai", "unregister"])).toBe(1);
    expect(await runCli(["node", "kai", "unregister", "--dry-run"])).toBe(1);
    expect(await runCli(["node", "kai", "unregister", "/nonexistent-xyz"])).toBe(1);
  });

  it("never touches the repository itself", async () => {
    const dir = makeTempProject({ "src/a.ts": "export function a() {}\n" });
    await runCli(["node", "kai", "code", dir]);
    await runCli(["node", "kai", "unregister", dir]);
    expect(fs.existsSync(path.join(dir, "src", "a.ts"))).toBe(true);
  });
});

describe("deleteProjectData hardening", () => {
  it("rejects non-id inputs without deleting anything", () => {
    for (const bad of [
      "",
      "..",
      "../..",
      "/",
      "/etc",
      "xyz",
      "ABCDEF1234567890",
      "a".repeat(15),
      "a".repeat(17),
    ]) {
      expect(deleteProjectData(bad).success).toBe(false);
    }
    // Well-formed but absent id reports not-found (no deletion attempted)
    expect(deleteProjectData("0".repeat(16))).toEqual({
      success: false,
      error: "Project data not found",
    });
  });
});

describe("runCli smoke coverage", () => {
  it("handles version, help, unknown commands, and missing args", async () => {
    expect(await runCli(["node", "kai", "--version"])).toBe(0);
    expect(await runCli(["node", "kai", "--help"])).toBe(0);
    expect(await runCli(["node", "kai", "frobnicate"])).toBe(1);
    expect(await runCli(["node", "kai", "query"])).toBe(1);
    expect(await runCli(["node", "kai", "status", "/nonexistent-xyz"])).toBe(1);
    expect(await runCli(["node", "kai", "config", "set", "bogus", "1"])).toBe(1);
  });

  it("runs code/status/query/cost end to end", async () => {
    const dir = makeTempProject({
      "src/hello.ts": "export function helloWorld() { return 42; }\n",
    });
    expect(await runCli(["node", "kai", "code", dir])).toBe(0);
    expect(await runCli(["node", "kai", "status", dir])).toBe(0);
    expect(await runCli(["node", "kai", "query", "explain helloWorld", dir])).toBe(0);
    expect(await runCli(["node", "kai", "cost", dir])).toBe(0);
    expect(await runCli(["node", "kai", "graph", "rebuild", dir])).toBe(0);
  });
});

describe("ProjectLock concurrency", () => {
  it("second acquire fails while the lock is held, succeeds after release", () => {
    const dir = makeTempProject({ "a.txt": "hi\n" });
    const meta = registerProject(dir);
    const first = new ProjectLock(meta.id);
    const second = new ProjectLock(meta.id);
    expect(first.acquire(1000)).toBe(true);
    try {
      expect(second.acquire(200)).toBe(false);
    } finally {
      first.release();
    }
    expect(second.acquire(1000)).toBe(true);
    second.release();
  });

  it("reclaims a stale lock left by a dead process", () => {
    const dir = makeTempProject({ "a.txt": "hi\n" });
    const meta = registerProject(dir);
    const lockPath = getProjectLockPath(meta.id);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 2147483647, time: Date.now() - 60000 }), {
      mode: 0o600,
    });
    const lock = new ProjectLock(meta.id);
    expect(lock.acquire(2000)).toBe(true);
    lock.release();
  });
});

describe("context budget hard enforcement", () => {
  it("keeps the rendered prompt within budget while preserving the task", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 10; i++) {
      files[`src/mod${i}.ts`] =
        `export function target${i}() {\n${"  const x = 1;\n".repeat(60)}}\n`;
    }
    const dir = makeTempProject(files);
    const meta = registerProject(dir);
    const index = await indexProject(meta, { forceRebuild: true });

    const budget = 800;
    const { contextPackage, renderedPrompt } = assembleContext(index, {
      task: "explain how target functions work",
      tokenBudget: budget,
    });
    const measured = estimateTokens(renderedPrompt).estimatedTokens;
    expect(measured).toBeLessThanOrEqual(budget);
    expect(renderedPrompt).toContain("explain how target functions work");
    expect(contextPackage.tokenMetrics.estimatedTokens).toBeLessThanOrEqual(budget);
    expect(contextPackage.omissions.length).toBeGreaterThan(0);
  });

  it("clamps absurd budgets instead of crashing or dumping everything", async () => {
    const dir = makeTempProject({ "src/a.ts": "export function a() {}\n" });
    const meta = registerProject(dir);
    const index = await indexProject(meta, { forceRebuild: true });
    for (const weird of [1, -500, NaN, 1e12]) {
      const { renderedPrompt } = assembleContext(index, { task: "explain a", tokenBudget: weird });
      const measured = estimateTokens(renderedPrompt).estimatedTokens;
      expect(measured).toBeLessThanOrEqual(20000);
      expect(renderedPrompt).toContain("explain a");
    }
  });
});
