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
import { runCli, buildAgentSetup } from "../cli/index";

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

describe("kai remove / unregister command", () => {
  it("deletes index data for a registered project with -i and reports scope", async () => {
    const dir = makeTempProject({ "src/a.ts": "export function a() {}\n" });
    expect(await runCli(["node", "kai", "graph", "init", dir])).toBe(0);
    const meta = getProjectMeta(dir)!;
    expect(fs.existsSync(getProjectStorageDir(meta.id))).toBe(true);

    expect(await runCli(["node", "kai", "remove", "-i", dir, "--dry-run"])).toBe(0);
    expect(fs.existsSync(getProjectStorageDir(meta.id))).toBe(true);

    expect(await runCli(["node", "kai", "remove", "-i", dir])).toBe(0);
    expect(fs.existsSync(getProjectStorageDir(meta.id))).toBe(false);
    expect(getProjectMeta(dir)).toBeNull();
  });

  it("accepts a project id as well as a path with -i / --index", async () => {
    const dir = makeTempProject({ "src/a.ts": "export function a() {}\n" });
    expect(await runCli(["node", "kai", "graph", "init", dir])).toBe(0);
    const meta = getProjectMeta(dir)!;
    expect(await runCli(["node", "kai", "remove", "--index", meta.id])).toBe(0);
    expect(fs.existsSync(getProjectStorageDir(meta.id))).toBe(false);
  });

  it("unregisters orphaned project storage by ID with -i even if meta.json is missing", async () => {
    const orphanId = "1234567890abcdef";
    const storageDir = getProjectStorageDir(orphanId);
    fs.mkdirSync(storageDir, { recursive: true });
    fs.writeFileSync(path.join(storageDir, "index.json"), "{}");
    expect(fs.existsSync(storageDir)).toBe(true);

    expect(await runCli(["node", "kai", "remove", "-i", orphanId])).toBe(0);
    expect(fs.existsSync(storageDir)).toBe(false);
  });

  it("requires a flag and fails cleanly for unknown projects", async () => {
    expect(await runCli(["node", "kai", "remove"])).toBe(1);
    expect(await runCli(["node", "kai", "remove", "--dry-run"])).toBe(1);
    expect(await runCli(["node", "kai", "remove", "/nonexistent-xyz"])).toBe(1);
    expect(await runCli(["node", "kai", "remove", "-i", "/nonexistent-xyz"])).toBe(1);
    expect(await runCli(["node", "kai", "remove", "-a", "nonexistent-agent"])).toBe(1);
  });

  it("never touches the repository itself", async () => {
    const dir = makeTempProject({ "src/a.ts": "export function a() {}\n" });
    await runCli(["node", "kai", "graph", "init", dir]);
    await runCli(["node", "kai", "remove", "-i", dir]);
    expect(fs.existsSync(path.join(dir, "src", "a.ts"))).toBe(true);
  });

  it("supports session removal with -s", async () => {
    expect(await runCli(["node", "kai", "remove", "-s", "--dry-run"])).toBe(0);
    expect(await runCli(["node", "kai", "remove", "-s"])).toBe(0);
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
    expect(await runCli(["node", "kai", "remove"])).toBe(1);
    expect(await runCli(["node", "kai", "status", "/nonexistent-xyz"])).toBe(1);
    expect(await runCli(["node", "kai", "config", "get", "defaultTokenBudget"])).toBe(0);
    expect(await runCli(["node", "kai", "config", "get", "bogusKey"])).toBe(1);
    expect(await runCli(["node", "kai", "config", "set", "bogus", "1"])).toBe(1);
  });

  it("runs graph init/status/update end to end and checks health", async () => {
    const dir = makeTempProject({
      "src/hello.ts": "export function helloWorld() { return 42; }\n",
    });
    expect(await runCli(["node", "kai", "graph", "init", dir])).toBe(0);
    expect(await runCli(["node", "kai", "graph", "status", dir])).toBe(0);
    expect(await runCli(["node", "kai", "health"])).toBe(0);
    expect(await runCli(["node", "kai", "graph", "update", dir])).toBe(0);
  });

  it("config set works on a fresh KAI_HOME with no directories yet", async () => {
    // Point KAI_HOME at a path that does not exist at all (first run on a
    // fresh machine). Previously this threw ENOENT instead of initializing.
    const freshHome = path.join(kaiHome, "nested", "home");
    process.env.KAI_HOME = freshHome;
    expect(fs.existsSync(freshHome)).toBe(false);
    expect(await runCli(["node", "kai", "config", "set", "defaultTokenBudget", "3000"])).toBe(0);
    const saved = JSON.parse(fs.readFileSync(path.join(freshHome, "config.json"), "utf-8"));
    expect(saved.defaultTokenBudget).toBe(3000);
  });

  it("emits valid JSON for Windows-style install paths", () => {
    // Regression: interpolating `C:\tools\...` raw produced invalid JSON
    // (`\t` bad escape), breaking copy-paste MCP setup on Windows.
    // Snippets carry trailing prose, so extract the leading JSON object
    // with a brace scan (no braces appear inside the string values).
    const extractJson = (snippet: string): any => {
      const start = snippet.indexOf("{");
      let depth = 0;
      let inStr = false;
      let esc = false;
      for (let i = start; i < snippet.length; i++) {
        const ch = snippet[i];
        if (inStr) {
          if (esc) esc = false;
          else if (ch === "\\") esc = true;
          else if (ch === '"') inStr = false;
          continue;
        }
        if (ch === '"') inStr = true;
        else if (ch === "{") depth++;
        else if (ch === "}") {
          depth--;
          if (depth === 0) return JSON.parse(snippet.slice(start, i + 1));
        }
      }
      throw new Error("no balanced JSON object found");
    };
    const winBin = "C:\\tools\\kai space\\bin\\kai.js";
    for (const agent of ["claude", "codex"]) {
      const snippet = buildAgentSetup(agent, winBin)!;
      expect(snippet).toBeTruthy();
      const parsed = extractJson(snippet);
      const args = agent === "claude" ? parsed.mcpServers.kai.args : parsed.mcp_servers[0].args;
      expect(args[0]).toBe(winBin);
    }

    const cursor = buildAgentSetup("cursor", winBin)!;
    expect(cursor).toContain("${workspaceFolder}");
    expect(cursor).toContain("C:\\\\tools\\\\kai space\\\\bin\\\\kai.js");

    const posix = buildAgentSetup("claude", "/usr/local/bin/kai.js")!;
    expect(extractJson(posix).mcpServers.kai.args[0]).toBe("/usr/local/bin/kai.js");

    expect(buildAgentSetup("unknown-agent", winBin)).toBeNull();
  });

  it("supports every documented agent with valid JSON", () => {
    const extractJson = (snippet: string): any => {
      const start = snippet.indexOf("{");
      let depth = 0;
      let inStr = false;
      let esc = false;
      for (let i = start; i < snippet.length; i++) {
        const ch = snippet[i];
        if (inStr) {
          if (esc) esc = false;
          else if (ch === "\\") esc = true;
          else if (ch === '"') inStr = false;
          continue;
        }
        if (ch === '"') inStr = true;
        else if (ch === "{") depth++;
        else if (ch === "}") {
          depth--;
          if (depth === 0) return JSON.parse(snippet.slice(start, i + 1));
        }
      }
      throw new Error("no balanced JSON object found");
    };
    const winBin = "C:\\tools\\kai space\\bin\\kai.js";
    // Every supported agent must emit parseable JSON containing the kai bin.
    for (const agent of ["gemini", "copilot", "windsurf", "cline"]) {
      const snippet = buildAgentSetup(agent, winBin)!;
      expect(snippet).toBeTruthy();
      expect(extractJson(snippet)).toBeTruthy();
      expect(snippet).toContain("kai");
    }
    // Case-insensitive + aliases.
    expect(buildAgentSetup("Claude", winBin)).toBeTruthy();
    expect(buildAgentSetup("vscode", winBin)).toBeTruthy();
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

  it("renders a metrics footer with measured (non-zero) values", async () => {
    const dir = makeTempProject({ "src/a.ts": "export function alpha() { return 1; }\n" });
    const meta = registerProject(dir);
    const index = await indexProject(meta, { forceRebuild: true });
    const { contextPackage, renderedPrompt } = assembleContext(index, {
      task: "explain alpha",
      tokenBudget: 4000,
    });
    const measured = estimateTokens(renderedPrompt);
    expect(measured.estimatedTokens).toBeGreaterThan(0);
    expect(contextPackage.tokenMetrics.estimatedTokens).toBe(measured.estimatedTokens);
    // The footer is self-referential (the counts include their own digits),
    // so it lags the final string by the width of the footer line itself —
    // but it must be a live measurement, never the initial zeros.
    const footerChars = Number(renderedPrompt.match(/Chars: (\d+)/)?.[1] ?? NaN);
    expect(Number.isFinite(footerChars)).toBe(true);
    expect(footerChars).toBeGreaterThan(0);
    expect(Math.abs(footerChars - measured.characterCount)).toBeLessThanOrEqual(20);
  });
});
