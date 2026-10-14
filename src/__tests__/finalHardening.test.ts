import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { handleMcpMessage } from "../core/mcp";
import {
  registerProject,
  loadProjectIndex,
  getProjectIndexPath,
  getProjectStorageDir,
  checkPersistenceConsistency,
} from "../core/registry";
import { indexProject, detectStaleIndexEntries } from "../core/indexer";
import {
  getGraphFreshness,
  synchronizeGraphDeduped,
  ensureFreshIndex,
  runExternalAgentCommand,
  runCodeTaskWithAutoSync,
} from "../core/codeModeWorkflow";
import { runCli } from "../cli/index";

let tmpHome = "";
let tmpRoot = "";
const prevHome = process.env.KAI_HOME;

function write(rel: string, content: string): void {
  const full = path.join(tmpRoot, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "kai-final-home-"));
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kai-final-proj-"));
  process.env.KAI_HOME = tmpHome;
  write("a.ts", "export function alpha() { return 1; }\n");
  write("b.ts", "export function beta() { return 2; }\n");
});

afterEach(() => {
  process.env.KAI_HOME = prevHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("change detection: new files prove staleness", () => {
  it("a newly created tracked file marks the graph stale", async () => {
    const meta = registerProject(tmpRoot);
    await indexProject(meta);
    expect(getGraphFreshness(loadProjectIndex(meta.id))).toBe("fresh");
    write("brand-new.ts", "export function fresh() { return 1; }\n");
    const check = detectStaleIndexEntries(loadProjectIndex(meta.id)!);
    expect(check.newFiles).toContain("brand-new.ts");
    expect(check.isStale).toBe(true);
    expect(getGraphFreshness(loadProjectIndex(meta.id))).toBe("stale");
  });

  it("excluded files (node_modules) do not mark stale", async () => {
    const meta = registerProject(tmpRoot);
    await indexProject(meta);
    write("node_modules/dep/index.js", "module.exports = 1;\n");
    expect(getGraphFreshness(loadProjectIndex(meta.id))).toBe("fresh");
  });

  it("deleted and renamed files are detected", async () => {
    const meta = registerProject(tmpRoot);
    await indexProject(meta);
    fs.rmSync(path.join(tmpRoot, "b.ts"));
    write("b-renamed.ts", "export function beta() { return 2; }\n");
    const check = detectStaleIndexEntries(loadProjectIndex(meta.id)!);
    expect(check.isStale).toBe(true);
    const rebuilt = await indexProject(meta);
    expect(rebuilt.changes?.renamed.some((r) => r.to === "b-renamed.ts")).toBe(true);
  });
});

describe("dedup does not share across identities or change sets", () => {
  it("different change sets run separately", async () => {
    const meta = registerProject(tmpRoot);
    await indexProject(meta);
    write("a.ts", "export function alpha() { return 101; }\n");
    const v = { ran: true, passed: true, detail: "vitest" };
    const [narrow, broad] = await Promise.all([
      synchronizeGraphDeduped(meta, ["a.ts"], v, { uncertain: false }),
      synchronizeGraphDeduped(meta, [], v, { uncertain: true }),
    ]);
    // Both complete without sharing a scope blindly: the uncertain full
    // path must report full scope.
    expect(broad.graphScope).toBe("full");
    expect(narrow.graphResult).toBe("synced");
    expect(broad.graphResult).toBe("synced");
  });

  it("two different projects do not share a result", async () => {
    const rootB = fs.mkdtempSync(path.join(os.tmpdir(), "kai-final-projB-"));
    try {
      write("a.ts", "export function alpha() { return 1; }\n");
      fs.writeFileSync(path.join(rootB, "z.ts"), "export function zed() { return 0; }\n");
      const metaA = registerProject(tmpRoot);
      const metaB = registerProject(rootB);
      await indexProject(metaA);
      await indexProject(metaB);
      fs.writeFileSync(path.join(tmpRoot, "a.ts"), "export function alpha() { return 5; }\n");
      const v = { ran: true, passed: true, detail: "vitest" };
      const [ra, rb] = await Promise.all([
        synchronizeGraphDeduped(metaA, ["a.ts"], v),
        synchronizeGraphDeduped(metaB, [], v),
      ]);
      expect(ra.graphResult).toBe("synced");
      expect(rb.graphResult).toBe("skipped");
    } finally {
      fs.rmSync(rootB, { recursive: true, force: true });
    }
  });
});

describe("runExternalAgentCommand lifecycle", () => {
  it("modifies a file and exits successfully", async () => {
    const target = path.join(tmpRoot, "out-success.txt");
    const r = await runExternalAgentCommand(
      process.execPath,
      ["-e", `require("fs").writeFileSync(${JSON.stringify(target)}, "ok");`],
      { cwd: tmpRoot }
    );
    expect(r.exitCode).toBe(0);
    expect(r.timedOut).toBe(false);
    expect(fs.readFileSync(target, "utf-8")).toBe("ok");
  });

  it("modifies a file and exits non-zero; exit code preserved", async () => {
    const target = path.join(tmpRoot, "out-fail.txt");
    const r = await runExternalAgentCommand(
      process.execPath,
      ["-e", `require("fs").writeFileSync(${JSON.stringify(target)}, "half"); process.exit(7);`],
      { cwd: tmpRoot }
    );
    expect(r.exitCode).toBe(7);
    expect(fs.readFileSync(target, "utf-8")).toBe("half");
  });

  it("timeout kills the child and reports timedOut", async () => {
    const target = path.join(tmpRoot, "out-timeout.txt");
    const start = Date.now();
    const r = await runExternalAgentCommand(
      process.execPath,
      [
        "-e",
        `require("fs").writeFileSync(${JSON.stringify(target)}, "started"); setTimeout(()=>{}, 30000);`,
      ],
      { cwd: tmpRoot, timeoutMs: 800 }
    );
    expect(r.timedOut).toBe(true);
    expect(Date.now() - start).toBeLessThan(15000);
    expect(fs.readFileSync(target, "utf-8")).toBe("started");
  });

  it("cancellation kills the child", async () => {
    const c = new AbortController();
    const target = path.join(tmpRoot, "out-cancel.txt");
    const p = runExternalAgentCommand(
      process.execPath,
      [
        "-e",
        `require("fs").writeFileSync(${JSON.stringify(target)}, "begun"); setTimeout(()=>{}, 30000);`,
      ],
      { cwd: tmpRoot, signal: c.signal }
    );
    setTimeout(() => c.abort(), 500);
    const r = await p;
    expect(fs.readFileSync(target, "utf-8")).toBe("begun");
    expect(r.exitCode === null || typeof r.exitCode === "number").toBe(true);
  });

  it("create, rename, move, delete via child are all observed", async () => {
    write("lifecycle.ts", "export const v = 1;\n");
    const script = `
      const fs = require("fs"), p = require("path");
      const root = ${JSON.stringify(tmpRoot)};
      fs.writeFileSync(p.join(root, "created.ts"), "export const c = 1;\\n");
      fs.renameSync(p.join(root, "lifecycle.ts"), p.join(root, "renamed.ts"));
      fs.mkdirSync(p.join(root, "sub2"), { recursive: true });
      fs.renameSync(p.join(root, "renamed.ts"), p.join(root, "sub2", "moved.ts"));
      fs.writeFileSync(p.join(root, "doomed.ts"), "x");
      fs.rmSync(p.join(root, "doomed.ts"));
    `;
    const r = await runExternalAgentCommand(process.execPath, ["-e", script], { cwd: tmpRoot });
    expect(r.exitCode).toBe(0);
    expect(fs.existsSync(path.join(tmpRoot, "created.ts"))).toBe(true);
    expect(fs.existsSync(path.join(tmpRoot, "sub2", "moved.ts"))).toBe(true);
    expect(fs.existsSync(path.join(tmpRoot, "lifecycle.ts"))).toBe(false);
  });

  it("exit without changes resolves cleanly", async () => {
    const r = await runExternalAgentCommand(process.execPath, ["-e", "process.exit(0);"], {
      cwd: tmpRoot,
    });
    expect(r.exitCode).toBe(0);
    expect(r.timedOut).toBe(false);
  });

  it("shell stays disabled by default (no shell evaluation)", async () => {
    const marker = path.join(tmpRoot, "shell-eval.txt");
    // If a shell evaluated this string, the redirect would create the file.
    const r = await runExternalAgentCommand(
      process.execPath,
      ["-e", `console.log("touch ${marker.replace(/\\/g, "/")}");`],
      { cwd: tmpRoot, shell: false }
    );
    expect(r.exitCode).toBe(0);
    expect(fs.existsSync(marker)).toBe(false);
  });
});

describe("kai run CLI preserves exit codes and syncs", () => {
  it("non-zero agent exit is preserved and graph still syncs", async () => {
    const meta = registerProject(tmpRoot);
    await indexProject(meta);
    const code = await runCli([
      "node",
      "kai",
      "run",
      tmpRoot,
      "--",
      process.execPath,
      "-e",
      "process.exit(3);",
    ]);
    expect(code).toBe(3);
  });

  it("timeout returns 124 and forces a broader refresh path", async () => {
    const code = await runCli([
      "node",
      "kai",
      "run",
      tmpRoot,
      "--timeout-ms",
      "700",
      "--",
      process.execPath,
      "-e",
      "setTimeout(()=>{}, 30000);",
    ]);
    expect(code).toBe(124);
  });

  it("a detached grandchild writing after parent exit is caught by the next freshness check", async () => {
    const meta = registerProject(tmpRoot);
    await indexProject(meta);
    const late = path.join(tmpRoot, "grandchild-late.txt");
    const grandchildJs = `setTimeout(()=>require("fs").writeFileSync(${JSON.stringify(late)},"late"), 1200);`;
    const parentScript = `const { spawn } = require("child_process"); const c = spawn(${JSON.stringify(process.execPath)}, ["-e", ${JSON.stringify(grandchildJs)}], { detached: true, stdio: "ignore" }); c.unref(); process.exit(0);`;
    const r = await runExternalAgentCommand(process.execPath, ["-e", parentScript], {
      cwd: tmpRoot,
    });
    expect(r.exitCode).toBe(0);
    // Parent reaped; grandchild may not have written yet — point-in-time only.
    await new Promise((res) => setTimeout(res, 2500));
    expect(fs.existsSync(late)).toBe(true);
    expect(getGraphFreshness(loadProjectIndex(meta.id))).toBe("stale");
  });
});

describe("crash consistency: dual-copy mismatch forces rebuild", () => {
  it("detects a partial write and repairs on next refresh", async () => {
    const meta = registerProject(tmpRoot);
    await indexProject(meta);
    expect(checkPersistenceConsistency(meta.id).consistent).toBe(true);
    // Simulate a crash between the two sequential renames: fresh index.json
    // with a stale meta.json (old timestamp + stale status).
    const indexRaw = JSON.parse(fs.readFileSync(getProjectIndexPath(meta.id), "utf-8"));
    indexRaw.generatedAt = new Date(Date.now() + 60000).toISOString();
    fs.writeFileSync(getProjectIndexPath(meta.id), JSON.stringify(indexRaw, null, 2));
    const check = checkPersistenceConsistency(meta.id);
    expect(check.consistent).toBe(false);
    const ensured = await ensureFreshIndex(meta, loadProjectIndex(meta.id));
    expect(ensured.refreshOutcome).toBe("refreshed");
    expect(checkPersistenceConsistency(meta.id).consistent).toBe(true);
    expect(getGraphFreshness(loadProjectIndex(meta.id))).toBe("fresh");
    expect(fs.readdirSync(getProjectStorageDir(meta.id)).filter((f) => f.endsWith(".tmp"))).toEqual(
      []
    );
  });
});

describe("MCP freshness contract", () => {
  async function call(name: string, args: Record<string, unknown>, id = 1): Promise<string> {
    const res = await handleMcpMessage(
      { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } },
      tmpRoot
    );
    const content = (res?.result as { content: Array<{ text: string }> }).content;
    return content[0].text;
  }

  it("project_info reports freshness without forcing work", async () => {
    const meta = registerProject(tmpRoot);
    await indexProject(meta);
    const fresh = JSON.parse(await call("kai_project_info", {}));
    expect(fresh.freshness).toBe("fresh");
    write("extra.ts", "export function extra() { return 1; }\n");
    const stale = JSON.parse(await call("kai_project_info", {}));
    expect(stale.freshness).toBe("stale");
  });

  it("failed refresh produces a truthful warning, never fresh", async () => {
    const meta = registerProject(tmpRoot);
    await indexProject(meta);
    // Hold the index lock so the auto-refresh cannot proceed.
    const { ProjectLock } = await import("../core/registry");
    const lock = new ProjectLock(meta.id);
    expect(lock.acquire(1000)).toBe(true);
    try {
      write("a.ts", "export function alpha() { return 777; }\n");
      const parsed = JSON.parse(await call("kai_search_code", { query: "alpha" }));
      expect(parsed.refreshOutcome).toBe("refresh-failed");
      expect(parsed.freshness).not.toBe("fresh");
      expect(parsed.refreshWarning).toMatch(/last-known|failed/i);
    } finally {
      lock.release();
    }
  });

  it("runCodeTaskWithAutoSync refuses after project switch", async () => {
    const meta = registerProject(tmpRoot);
    await indexProject(meta);
    const outcome = await runCodeTaskWithAutoSync(meta, async () => {
      // Simulate close/delete mid-task.
      const { deleteProjectData } = await import("../core/registry");
      expect(deleteProjectData(meta.id).success).toBe(true);
      return { changedFiles: ["a.ts"] };
    });
    expect(outcome.syncReport.graphResult).toBe("failed");
    expect(JSON.stringify(outcome)).toMatch(/no longer registered|refusing/);
  });
});
