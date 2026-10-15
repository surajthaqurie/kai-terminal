import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";
import { handleMcpMessage } from "../core/mcp";
import {
  registerProject,
  getProjectMeta,
  loadProjectIndex,
  deleteProjectData,
  getProjectMetaPath,
  getProjectIndexPath,
  getProjectStorageDir,
  checkPersistenceConsistency,
  ProjectLock,
} from "../core/registry";
import { indexProject } from "../core/indexer";
import {
  getGraphFreshness,
  getValidatedFreshness,
  synchronizeGraphDeduped,
  ensureFreshIndex,
  runExternalAgentCommand,
  runCodeTaskWithAutoSync,
  needsShellForCommand,
  resolveSpawnTarget,
} from "../core/codeModeWorkflow";

let tmpHome = "";
let tmpRoot = "";
const prevHome = process.env.KAI_HOME;

function write(rel: string, content: string, root: string = tmpRoot): void {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function readJson(p: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(p, "utf-8")) as Record<string, unknown>;
}

function writeJson(p: string, data: unknown): void {
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
}

async function mcpText(
  name: string,
  args: Record<string, unknown>,
  root: string = tmpRoot
): Promise<string> {
  const res = await handleMcpMessage(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
    root
  );
  const content = (res?.result as { content: Array<{ text: string }> }).content;
  return content[0].text;
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "kai-rel-home-"));
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kai-rel-proj-"));
  process.env.KAI_HOME = tmpHome;
  write("a.ts", "export function alpha() { return 1; }\n");
  write("b.ts", "export function beta() { return 2; }\n");
});

afterEach(() => {
  process.env.KAI_HOME = prevHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("project incarnation identity", () => {
  it("re-registration after delete mints a new incarnation for the same path", async () => {
    const first = registerProject(tmpRoot);
    expect(typeof first.incarnation).toBe("string");
    const second = registerProject(tmpRoot);
    expect(second.incarnation).toBe(first.incarnation);
    expect(deleteProjectData(first.id).success).toBe(true);
    const third = registerProject(tmpRoot);
    expect(third.id).toBe(first.id);
    expect(typeof third.incarnation).toBe("string");
    expect(third.incarnation).not.toBe(first.incarnation);
  });

  it("a stale task cannot publish after delete + re-register at the same path", async () => {
    const stale = registerProject(tmpRoot);
    await indexProject(stale);
    write("stale-marker.ts", "export const stale = 1;\n");
    // Task begins under the first registration, then the project is
    // deleted and re-registered at the identical path.
    expect(deleteProjectData(stale.id).success).toBe(true);
    const current = registerProject(tmpRoot);
    write("fresh-marker.ts", "export const current = 1;\n");
    await indexProject(current);
    expect(getValidatedFreshness(current.id, loadProjectIndex(current.id))).toBe("fresh");

    const report = await synchronizeGraphDeduped(
      stale,
      ["stale-marker.ts"],
      { ran: false, passed: false, detail: "stale task" },
      { forceFull: true }
    );
    expect(report.graphResult).toBe("failed");
    expect(report.message).toMatch(/incarnation/);
    // The new project's index is uncorrupted: the fresh file is indexed,
    // the stale task published nothing, and freshness is intact.
    const after = loadProjectIndex(current.id)!;
    expect(after.files["fresh-marker.ts"]).toBeTruthy();
    expect(getValidatedFreshness(current.id, loadProjectIndex(current.id))).toBe("fresh");
  });

  it("switch away and back: live project still syncs, re-registered one rejects", async () => {
    const rootB = fs.mkdtempSync(path.join(os.tmpdir(), "kai-rel-projB-"));
    try {
      write("b-only.ts", "export const b = 1;\n", rootB);
      const metaA = registerProject(tmpRoot);
      const metaB = registerProject(rootB);
      await indexProject(metaA);
      await indexProject(metaB);
      // Switch away (B is active) and back: A was never deleted, so a task
      // captured under A's live incarnation still synchronizes.
      write("a.ts", "export function alpha() { return 11; }\n");
      const live = await synchronizeGraphDeduped(
        metaA,
        ["a.ts"],
        { ran: true, passed: true, detail: "vitest" },
        { forceFull: true }
      );
      expect(live.graphResult).toBe("synced");
      expect(metaB.id).not.toBe(metaA.id);

      // Now delete A and re-register the same path: the old capture is stale.
      expect(deleteProjectData(metaA.id).success).toBe(true);
      const metaA2 = registerProject(tmpRoot);
      await indexProject(metaA2);
      const stale = await synchronizeGraphDeduped(
        metaA,
        ["a.ts"],
        { ran: true, passed: true, detail: "vitest" },
        { forceFull: true }
      );
      expect(stale.graphResult).toBe("failed");
      expect(stale.message).toMatch(/incarnation/);
      // The current task for the newly registered project still syncs.
      write("a.ts", "export function alpha() { return 12; }\n");
      const fresh = await runCodeTaskWithAutoSync(metaA2, async () => ({
        changedFiles: ["a.ts"],
        codeValidation: { ran: true, passed: true, detail: "vitest" },
      }));
      expect(fresh.taskOutcome).toBe("completed");
      expect(fresh.syncReport.graphResult).toBe("synced");
    } finally {
      fs.rmSync(rootB, { recursive: true, force: true });
    }
  });

  it("two projects with the same display name but different roots stay distinct", async () => {
    const parentA = fs.mkdtempSync(path.join(os.tmpdir(), "kai-rel-pa-"));
    const parentB = fs.mkdtempSync(path.join(os.tmpdir(), "kai-rel-pb-"));
    try {
      const rootA = path.join(parentA, "same");
      const rootB = path.join(parentB, "same");
      fs.mkdirSync(rootA, { recursive: true });
      fs.mkdirSync(rootB, { recursive: true });
      write("only-a.ts", "export const a = 1;\n", rootA);
      write("only-b.ts", "export const b = 1;\n", rootB);
      const metaA = registerProject(rootA);
      const metaB = registerProject(rootB);
      expect(metaA.name).toBe(metaB.name);
      expect(metaA.id).not.toBe(metaB.id);
      expect(metaA.incarnation).not.toBe(metaB.incarnation);
      await indexProject(metaA);
      await indexProject(metaB);
      const genB = loadProjectIndex(metaB.id)!.generatedAt;
      write("only-a.ts", "export const a = 2;\n", rootA);
      const report = await synchronizeGraphDeduped(
        metaA,
        ["only-a.ts"],
        { ran: true, passed: true, detail: "vitest" },
        { forceFull: true }
      );
      expect(report.graphResult).toBe("synced");
      expect(loadProjectIndex(metaB.id)!.generatedAt).toBe(genB);
      expect(loadProjectIndex(metaB.id)!.files["only-a.ts"]).toBeUndefined();
    } finally {
      fs.rmSync(parentA, { recursive: true, force: true });
      fs.rmSync(parentB, { recursive: true, force: true });
    }
  });

  it("deleting the project mid-task refuses to publish and preserves sources", async () => {
    const meta = registerProject(tmpRoot);
    await indexProject(meta);
    const outcome = await runCodeTaskWithAutoSync(meta, async () => {
      write("a.ts", "export function alpha() { return 99; }\n");
      expect(deleteProjectData(meta.id).success).toBe(true);
      return { changedFiles: ["a.ts"] };
    });
    expect(outcome.taskOutcome).toBe("completed");
    expect(outcome.syncReport.graphResult).toBe("failed");
    expect(outcome.syncReport.message).toMatch(/no longer registered|incarnation|refusing/);
    // Source changes are never erased by a refused sync.
    expect(fs.readFileSync(path.join(tmpRoot, "a.ts"), "utf-8")).toContain("return 99");
  });

  it("legacy metadata upgrades without adopting a stale task", async () => {
    const meta = registerProject(tmpRoot);
    await indexProject(meta);
    // Strip the new additive fields to simulate pre-upgrade persistence.
    const metaJson = readJson(getProjectMetaPath(meta.id));
    const indexJson = readJson(getProjectIndexPath(meta.id));
    delete metaJson.incarnation;
    delete metaJson.snapshotId;
    const embedded = indexJson.meta as Record<string, unknown>;
    delete embedded.incarnation;
    delete embedded.snapshotId;
    delete indexJson.snapshotId;
    writeJson(getProjectMetaPath(meta.id), metaJson);
    writeJson(getProjectIndexPath(meta.id), indexJson);

    // Legacy snapshots stay loadable and consistent via fallback checks.
    expect(checkPersistenceConsistency(meta.id).consistent).toBe(true);
    const legacyMeta = getProjectMeta(meta.id)!;
    expect(legacyMeta.incarnation ?? null).toBeNull();

    // Re-registration upgrades the persisted copy with a fresh token...
    const upgraded = registerProject(tmpRoot);
    expect(typeof upgraded.incarnation).toBe("string");

    // ...but the pre-upgrade capture (no token) is rejected, never adopted.
    write("a.ts", "export function alpha() { return 13; }\n");
    const report = await synchronizeGraphDeduped(
      legacyMeta,
      ["a.ts"],
      { ran: true, passed: true, detail: "vitest" },
      { forceFull: true }
    );
    expect(report.graphResult).toBe("failed");
    expect(report.message).toMatch(/incarnation/);
  });
});

describe("external-agent process lifecycle outcomes", () => {
  it("an already-aborted signal resolves without spawning", async () => {
    const controller = new AbortController();
    controller.abort();
    const start = Date.now();
    const r = await runExternalAgentCommand(
      process.execPath,
      ["-e", "setTimeout(()=>{}, 30000);"],
      { cwd: tmpRoot, signal: controller.signal }
    );
    expect(r.outcome).toBe("aborted");
    expect(r.aborted).toBe(true);
    expect(r.spawnFailed).toBe(false);
    expect(r.treeKillAttempted).toBe(false);
    expect(r.descendantsMaySurvive).toBe(false);
    expect(Date.now() - start).toBeLessThan(5000);
  });

  it("spawn failure is distinct from timeout/abort/exit", async () => {
    const r = await runExternalAgentCommand("__kai_nonexistent_binary_xyz__", ["--version"], {
      cwd: tmpRoot,
      timeoutMs: 5000,
    });
    expect(r.outcome).toBe("spawn-error");
    expect(r.spawnFailed).toBe(true);
    expect(r.exitCode).toBeNull();
    expect(r.timedOut).toBe(false);
    expect(r.aborted).toBe(false);
    expect(typeof r.spawnError).toBe("string");
  });

  it("a child that ignores SIGTERM is escalated to SIGKILL", async () => {
    const start = Date.now();
    const r = await runExternalAgentCommand(
      process.execPath,
      ["-e", "process.on('SIGTERM', ()=>{}); setTimeout(()=>{}, 30000);"],
      { cwd: tmpRoot, timeoutMs: 700 }
    );
    expect(r.outcome).toBe("timeout");
    expect(r.timedOut).toBe(true);
    expect(r.treeKillAttempted).toBe(true);
    expect(r.descendantsMaySurvive).toBe(true);
    if (process.platform === "win32") {
      // Windows has no POSIX signals: taskkill /T /F reaps the child
      // without a signal code in the `close` event, and it kills
      // immediately (no SIGTERM-ignore grace period to escalate past).
      expect(r.signal).toBeNull();
      expect(r.exitCode).not.toBeNull();
    } else {
      expect(r.signal).toBe("SIGKILL");
    }
    const elapsed = Date.now() - start;
    // POSIX waits out the 2000ms SIGTERM->SIGKILL escalation; Windows
    // taskkill lands right after the 700ms timeout.
    expect(elapsed).toBeGreaterThanOrEqual(process.platform === "win32" ? 500 : 2000);
    expect(elapsed).toBeLessThan(20000);
  });

  it("a direct descendant in the same process group is terminated on timeout", async () => {
    const marker = path.join(tmpRoot, "group-child-alive.txt");
    const grandchild = `setTimeout(()=>require("fs").writeFileSync(${JSON.stringify(marker)},"alive"), 5000);`;
    const parent = `const { spawn } = require("child_process"); spawn(${JSON.stringify(process.execPath)}, ["-e", ${JSON.stringify(grandchild)}], { stdio: "ignore" }); setTimeout(()=>{}, 30000);`;
    const r = await runExternalAgentCommand(process.execPath, ["-e", parent], {
      cwd: tmpRoot,
      timeoutMs: 700,
    });
    expect(r.outcome).toBe("timeout");
    expect(r.treeKillAttempted).toBe(true);
    await new Promise((res) => setTimeout(res, 6000));
    // Group termination reaped the descendant: it never got to write.
    expect(fs.existsSync(marker)).toBe(false);
  }, 20000);

  it("a detached escapee is documented as point-in-time, not a guarantee", async () => {
    const meta = registerProject(tmpRoot);
    await indexProject(meta);
    const late = path.join(tmpRoot, "detached-late.txt");
    const grandchildJs = `setTimeout(()=>require("fs").writeFileSync(${JSON.stringify(late)},"late"), 1000);`;
    const parentScript = `const { spawn } = require("child_process"); const c = spawn(${JSON.stringify(process.execPath)}, ["-e", ${JSON.stringify(grandchildJs)}], { detached: true, stdio: "ignore" }); c.unref(); process.exit(0);`;
    const r = await runExternalAgentCommand(process.execPath, ["-e", parentScript], {
      cwd: tmpRoot,
    });
    // Normal exit: no termination was attempted, so the flags stay false —
    // yet the detached writer can still land a late write. Freshness is
    // therefore always point-in-time; the next check must catch the drift.
    expect(r.outcome).toBe("exited");
    expect(r.exitCode).toBe(0);
    expect(r.treeKillAttempted).toBe(false);
    for (let i = 0; i < 100 && !fs.existsSync(late); i++) {
      await new Promise((res) => setTimeout(res, 100));
    }
    expect(fs.existsSync(late)).toBe(true);
    expect(getValidatedFreshness(meta.id, loadProjectIndex(meta.id))).toBe("stale");
  });

  it("racing timeout and abort settles exactly once with cleaned-up timers", async () => {
    const controller = new AbortController();
    const pending: Array<Promise<unknown>> = [];
    const p = runExternalAgentCommand(process.execPath, ["-e", "setTimeout(()=>{}, 30000);"], {
      cwd: tmpRoot,
      timeoutMs: 400,
      signal: controller.signal,
    });
    pending.push(p);
    setTimeout(() => controller.abort(), 400);
    setTimeout(() => controller.abort(), 450);
    const start = Date.now();
    const r = await p;
    expect(pending.length).toBe(1);
    expect(["timeout", "aborted"]).toContain(r.outcome);
    expect(r.treeKillAttempted).toBe(true);
    expect(r.descendantsMaySurvive).toBe(true);
    expect(Date.now() - start).toBeLessThan(15000);
  });

  it("needsShellForCommand restricts shells to Windows batch files", () => {
    expect(needsShellForCommand("build.cmd", "win32")).toBe(true);
    expect(needsShellForCommand("build.BAT", "win32")).toBe(true);
    expect(needsShellForCommand("build.cmd", "linux")).toBe(false);
    expect(needsShellForCommand("build.cmd", "darwin")).toBe(false);
    expect(needsShellForCommand("script.ps1", "win32")).toBe(false);
    expect(needsShellForCommand("node", "win32")).toBe(false);
    expect(needsShellForCommand("claude", "linux")).toBe(false);
  });

  it("resolveSpawnTarget runs Windows .ps1 via powershell -File, never a shell or policy bypass", () => {
    const ps = resolveSpawnTarget("C:\\tools\\run me.ps1", ["--flag", "a b; calc"], "win32");
    expect(ps.command).toBe("powershell.exe");
    expect(ps.shell).toBe(false);
    expect(ps.args).toEqual([
      "-NoProfile",
      "-File",
      "C:\\tools\\run me.ps1",
      "--flag",
      "a b; calc",
    ]);
    expect(ps.args.join(" ")).not.toMatch(/ExecutionPolicy|Bypass/i);
    expect(resolveSpawnTarget("X.PS1", [], "win32").command).toBe("powershell.exe");
    // Other platforms and targets are untouched.
    expect(resolveSpawnTarget("script.ps1", ["x"], "linux")).toEqual({
      command: "script.ps1",
      args: ["x"],
      shell: false,
    });
    expect(resolveSpawnTarget("build.cmd", ["x"], "win32")).toEqual({
      command: "build.cmd",
      args: ["x"],
      shell: true,
    });
    expect(resolveSpawnTarget("node", ["-v"], "win32")).toEqual({
      command: "node",
      args: ["-v"],
      shell: false,
    });
  });
});

describe("persistence consistency boundaries", () => {
  it("crash after the first rename is detected and repaired", async () => {
    const meta = registerProject(tmpRoot);
    await indexProject(meta);
    expect(checkPersistenceConsistency(meta.id).consistent).toBe(true);
    // Simulate a crash between the index.json and meta.json renames: the
    // index copy moves to a new snapshot while meta.json stays behind.
    const indexJson = readJson(getProjectIndexPath(meta.id));
    const freshSnap = crypto.randomUUID();
    indexJson.snapshotId = freshSnap;
    (indexJson.meta as Record<string, unknown>).snapshotId = freshSnap;
    (indexJson as Record<string, unknown>).generatedAt = new Date(Date.now() + 60000).toISOString();
    writeJson(getProjectIndexPath(meta.id), indexJson);
    const check = checkPersistenceConsistency(meta.id);
    expect(check.consistent).toBe(false);
    expect(check.reason).toMatch(/snapshot|generation|timestamp/);
    // No reader may report fresh for the torn snapshot.
    expect(getValidatedFreshness(meta.id, loadProjectIndex(meta.id))).toBe("stale");
    const ensured = await ensureFreshIndex(meta, loadProjectIndex(meta.id));
    expect(ensured.refreshOutcome).toBe("refreshed");
    expect(checkPersistenceConsistency(meta.id).consistent).toBe(true);
    expect(getValidatedFreshness(meta.id, loadProjectIndex(meta.id))).toBe("fresh");
  });

  it("missing metadata or index files are handled without false freshness", async () => {
    const meta = registerProject(tmpRoot);
    await indexProject(meta);
    expect(checkPersistenceConsistency(meta.id).consistent).toBe(true);
    fs.rmSync(getProjectMetaPath(meta.id));
    expect(checkPersistenceConsistency(meta.id).consistent).toBe(true);
    await indexProject(registerProject(tmpRoot));
    fs.rmSync(getProjectIndexPath(meta.id));
    expect(checkPersistenceConsistency(meta.id).consistent).toBe(true);
    expect(getValidatedFreshness(meta.id, loadProjectIndex(meta.id))).toBe("unindexed");
  });

  it("truncated or malformed JSON never reads as fresh", async () => {
    const meta = registerProject(tmpRoot);
    await indexProject(meta);
    fs.writeFileSync(getProjectMetaPath(meta.id), '{"id": "truncated');
    expect(checkPersistenceConsistency(meta.id).consistent).toBe(false);
    expect(getValidatedFreshness(meta.id, loadProjectIndex(meta.id))).toBe("stale");
    // Repair the meta copy, then corrupt the index copy instead.
    await indexProject(registerProject(tmpRoot));
    fs.writeFileSync(getProjectIndexPath(meta.id), "not json at all{{{");
    expect(checkPersistenceConsistency(meta.id).consistent).toBe(false);
    // Persistence readers fail closed: the corrupt index is not loadable.
    expect(loadProjectIndex(meta.id)).toBeNull();
  });

  it("schema mismatch is detected and recovery converges", async () => {
    const meta = registerProject(tmpRoot);
    await indexProject(meta);
    const metaJson = readJson(getProjectMetaPath(meta.id));
    metaJson.schemaVersion = 999;
    writeJson(getProjectMetaPath(meta.id), metaJson);
    expect(checkPersistenceConsistency(meta.id).consistent).toBe(false);
    expect(getValidatedFreshness(meta.id, loadProjectIndex(meta.id))).toBe("stale");
    const ensured = await ensureFreshIndex(meta, loadProjectIndex(meta.id));
    expect(ensured.refreshOutcome).toBe("refreshed");
    expect(checkPersistenceConsistency(meta.id).consistent).toBe(true);
  });

  it("incarnation mismatch between copies is inconsistent", async () => {
    const meta = registerProject(tmpRoot);
    await indexProject(meta);
    const indexJson = readJson(getProjectIndexPath(meta.id));
    (indexJson.meta as Record<string, unknown>).incarnation = crypto.randomUUID();
    writeJson(getProjectIndexPath(meta.id), indexJson);
    const check = checkPersistenceConsistency(meta.id);
    expect(check.consistent).toBe(false);
    expect(check.reason).toMatch(/incarnation/);
    expect(getValidatedFreshness(meta.id, loadProjectIndex(meta.id))).toBe("stale");
  });

  it("valid legacy snapshots without snapshot ids stay consistent", async () => {
    const meta = registerProject(tmpRoot);
    await indexProject(meta);
    const metaJson = readJson(getProjectMetaPath(meta.id));
    const indexJson = readJson(getProjectIndexPath(meta.id));
    delete metaJson.snapshotId;
    delete (indexJson.meta as Record<string, unknown>).snapshotId;
    delete indexJson.snapshotId;
    writeJson(getProjectMetaPath(meta.id), metaJson);
    writeJson(getProjectIndexPath(meta.id), indexJson);
    expect(checkPersistenceConsistency(meta.id).consistent).toBe(true);
    expect(getValidatedFreshness(meta.id, loadProjectIndex(meta.id))).toBe("fresh");
  });

  it("failed recovery preserves the last-known-good graph", async () => {
    const meta = registerProject(tmpRoot);
    await indexProject(meta);
    const before = loadProjectIndex(meta.id)!;
    const lock = new ProjectLock(meta.id);
    expect(lock.acquire(1000)).toBe(true);
    try {
      write("a.ts", "export function alpha() { return 4242; }\n");
      const report = await synchronizeGraphDeduped(
        meta,
        ["a.ts"],
        { ran: true, passed: true, detail: "vitest" },
        { forceFull: true }
      );
      expect(report.graphResult).toBe("failed");
      expect(report.freshnessAfter).not.toBe("fresh");
      // Last-known-good data is untouched: same generation, same files.
      const preserved = loadProjectIndex(meta.id)!;
      expect(preserved.generatedAt).toBe(before.generatedAt);
      expect(preserved.files["a.ts"].sha256).toBe(before.files["a.ts"].sha256);
      // Source changes are preserved on disk for the next attempt.
      expect(fs.readFileSync(path.join(tmpRoot, "a.ts"), "utf-8")).toContain("4242");
    } finally {
      lock.release();
    }
  });

  it("MCP reads during inconsistency never report fresh", async () => {
    const meta = registerProject(tmpRoot);
    await indexProject(meta);
    const indexJson = readJson(getProjectIndexPath(meta.id));
    const freshSnap = crypto.randomUUID();
    indexJson.snapshotId = freshSnap;
    (indexJson.meta as Record<string, unknown>).snapshotId = freshSnap;
    writeJson(getProjectIndexPath(meta.id), indexJson);
    expect(checkPersistenceConsistency(meta.id).consistent).toBe(false);
    // project_info only reports: it must surface stale, never fresh.
    const info = JSON.parse(await mcpText("kai_project_info", {}));
    expect(info.freshness).not.toBe("fresh");
    // Graph-dependent reads with a blocked refresh fall back truthfully.
    const lock = new ProjectLock(meta.id);
    expect(lock.acquire(1000)).toBe(true);
    try {
      const found = JSON.parse(await mcpText("kai_search_code", { query: "alpha" }));
      expect(found.freshness).not.toBe("fresh");
      expect(found.refreshOutcome).toBe("refresh-failed");
    } finally {
      lock.release();
    }
    expect(meta.id).toBeTruthy();
  });

  it("abandoned temp files are cleaned up without touching live data", async () => {
    const meta = registerProject(tmpRoot);
    await indexProject(meta);
    const dir = getProjectStorageDir(meta.id);
    const staleTmp = path.join(dir, "index.json.12345.stale.tmp");
    fs.writeFileSync(staleTmp, "{}");
    const past = new Date(Date.now() - 10 * 60 * 1000);
    fs.utimesSync(staleTmp, past, past);
    const freshTmp = path.join(dir, "index.json.99999.live.tmp");
    fs.writeFileSync(freshTmp, "{}");
    registerProject(tmpRoot);
    expect(fs.existsSync(staleTmp)).toBe(false);
    // A concurrent writer's fresh temp file is left alone.
    expect(fs.existsSync(freshTmp)).toBe(true);
    fs.rmSync(freshTmp, { force: true });
    expect(getGraphFreshness(loadProjectIndex(meta.id))).toBe("fresh");
  });

  it("case-only rename handling does not crash and stays truthful", async () => {
    const meta = registerProject(tmpRoot);
    write("CaseFile.ts", "export const cased = 1;\n");
    await indexProject(meta);
    // Uppercase-then-lowercase over the same bytes exercises the realpath
    // basename check; on case-sensitive filesystems this is a delete+add.
    fs.renameSync(path.join(tmpRoot, "CaseFile.ts"), path.join(tmpRoot, "CaseFile-tmp.ts"));
    fs.renameSync(path.join(tmpRoot, "CaseFile-tmp.ts"), path.join(tmpRoot, "casefile.ts"));
    const rebuilt = await indexProject(meta);
    const keys = Object.keys(rebuilt.files);
    expect(keys.some((k) => k.toLowerCase() === "casefile.ts")).toBe(true);
    expect(getValidatedFreshness(meta.id, loadProjectIndex(meta.id))).toBe("fresh");
  });
});
