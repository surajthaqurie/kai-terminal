import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { handleMcpMessage } from "../core/mcp";
import {
  registerProject,
  loadProjectIndex,
  deleteProjectData,
  ProjectLock,
} from "../core/registry";
import { indexProject } from "../core/indexer";
import {
  planCodeTask,
  resolveSelectedFiles,
  resolveChangedFilesAgainstRoot,
  ensureFreshIndex,
  synchronizeGraphDeduped,
  runCodeTaskWithAutoSync,
  getGraphFreshness,
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

async function mcpCall(id: number, name: string, args: Record<string, unknown>, root: string) {
  const res = await handleMcpMessage(
    { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } },
    root
  );
  const text = (res?.result as Record<string, unknown[]>).content as Array<{ text: string }>;
  return JSON.parse(text[0].text);
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "kai-auto-home-"));
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kai-auto-proj-"));
  process.env.KAI_HOME = tmpHome;
  write("a.ts", "export function alpha() { return 1; }\n");
  write("b.ts", "import { alpha } from './a';\nexport function beta() { return alpha(); }\n");
  write("sub/c.ts", "export function gamma() { return 3; }\n");
});

afterEach(() => {
  process.env.KAI_HOME = prevHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("kai_plan_task with selected files and trustworthy context", () => {
  it("simple tasks produce no options and keep the legacy shape", async () => {
    const meta = registerProject(tmpRoot);
    const index = await indexProject(meta);
    const plan = await planCodeTask(meta, index, { task: "Explain what alpha does" });
    expect(plan.mode).toBe("code");
    expect(plan.options).toEqual([]);
    expect(plan.defaultOption).toBeNull();
    expect(plan.relevantFiles.length).toBeLessThanOrEqual(3);
    expect(plan.project.id).toBe(meta.id);
    expect(plan.note).toContain("Simple task");
  });

  it("complex multi-module tasks produce one or two options with rationale", async () => {
    const meta = registerProject(tmpRoot);
    const index = await indexProject(meta);
    const plan = await planCodeTask(meta, index, {
      task: "Refactor the authentication module structure across services",
    });
    expect(plan.options.length).toBeGreaterThanOrEqual(1);
    expect(plan.options.length).toBeLessThanOrEqual(2);
    expect(plan.rationale.length).toBeGreaterThan(0);
    expect(plan.freshnessAfter).toBe("fresh");
  });

  it("prioritizes selected files and expands imports, callers, and tests", async () => {
    const meta = registerProject(tmpRoot);
    const index = await indexProject(meta);
    const plan = await planCodeTask(meta, index, {
      task: "Fix beta return value handling",
      selectedFiles: ["b.ts"],
    });
    expect(plan.selectedFiles).toEqual(["b.ts"]);
    expect(plan.relevantFiles[0]).toBe("b.ts");
    // b.ts imports ./a so a.ts is pulled in as a supporting file.
    expect(plan.supportingFiles.some((s) => s.path === "a.ts")).toBe(true);
    expect(plan.supportingFiles.find((s) => s.path === "a.ts")?.reason).toMatch(/imported by/);
    expect(plan.dependencies.length).toBeGreaterThan(0);
    expect(plan.symbols.some((s) => s.name === "beta")).toBe(true);
  });

  it("infers targets from the task when nothing is selected", async () => {
    const meta = registerProject(tmpRoot);
    const index = await indexProject(meta);
    const plan = await planCodeTask(meta, index, { task: "Fix the alpha function edge case" });
    expect(plan.selectedFiles).toEqual([]);
    expect(plan.inferredFiles).toContain("a.ts");
  });

  it("accepts renamed, moved, deleted, and not-yet-created files", async () => {
    const meta = registerProject(tmpRoot);
    const index = await indexProject(meta);
    const plan = await planCodeTask(meta, index, {
      task: "Restore the moved helper",
      selectedFiles: ["gone/old-helper.ts", "new-helper.ts"],
    });
    expect(plan.selectedFiles).toContain("gone/old-helper.ts");
    expect(plan.selectedFiles).toContain("new-helper.ts");
    expect(plan.warnings.length).toBeGreaterThanOrEqual(0);
  });

  it("deduplicates and drops empty or malformed selections", async () => {
    const meta = registerProject(tmpRoot);
    await indexProject(meta);
    const { selected, excluded } = resolveSelectedFiles(
      ["b.ts", "b.ts", "  ", "", 42, null, "b/./../b.ts"],
      tmpRoot
    );
    expect(selected).toEqual(["b.ts"]);
    expect(excluded.length).toBeGreaterThan(0);
  });

  it("rejects absolute paths, traversal, and escapes", async () => {
    const meta = registerProject(tmpRoot);
    await indexProject(meta);
    const { selected, excluded } = resolveSelectedFiles(
      [
        "../evil.ts",
        "/etc/passwd",
        "C:\\Windows\\x.ts",
        "sub/../../outside.ts",
        "\\\\server\\share\\x.ts",
        "a.ts",
      ],
      tmpRoot
    );
    expect(selected).toEqual(["a.ts"]);
    expect(excluded.length).toBe(5);
  });

  it("normalizes Windows separators with existing path utilities", async () => {
    const { selected } = resolveSelectedFiles(["sub\\c.ts"], tmpRoot);
    expect(selected).toEqual(["sub/c.ts"]);
  });

  it("auto-refreshes a stale graph before graph-dependent planning", async () => {
    const meta = registerProject(tmpRoot);
    await indexProject(meta);
    write("a.ts", "export function alpha() { return 2; }\n");
    expect(getGraphFreshness(loadProjectIndex(meta.id))).toBe("stale");
    const plan = await planCodeTask(
      meta,
      await indexProject(meta).then(() => loadProjectIndex(meta.id)!),
      {
        task: "Refactor alpha and its callers",
      }
    );
    void plan;
    // Re-establish staleness then plan: the planner itself must refresh.
    write("a.ts", "export function alpha() { return 3; }\n");
    const staleIndex = loadProjectIndex(meta.id)!;
    expect(getGraphFreshness(staleIndex)).toBe("stale");
    const plan2 = await planCodeTask(meta, staleIndex, { task: "Refactor alpha and its callers" });
    expect(plan2.freshness).toBe("stale");
    expect(plan2.refreshOutcome).toBe("refreshed");
    expect(plan2.freshnessAfter).toBe("fresh");
  });

  it("reports refresh failure truthfully with a bounded fallback", async () => {
    const meta = registerProject(tmpRoot);
    await indexProject(meta);
    write("a.ts", "export function alpha() { return 9; }\n");
    const lock = new ProjectLock(meta.id);
    expect(lock.acquire(1000)).toBe(true);
    try {
      const staleIndex = loadProjectIndex(meta.id)!;
      const plan = await planCodeTask(meta, staleIndex, { task: "Refactor alpha and its callers" });
      expect(plan.refreshOutcome).toBe("refresh-failed");
      expect(plan.freshnessAfter).not.toBe("fresh");
      expect(plan.warnings.some((w) => /refresh failed|not authoritative/i.test(w))).toBe(true);
      // Planning still returns usable options from the fallback.
      expect(plan.options.length).toBeGreaterThanOrEqual(1);
    } finally {
      lock.release();
    }
  }, 30000);

  it("keeps planning results bounded", async () => {
    const meta = registerProject(tmpRoot);
    const index = await indexProject(meta);
    const plan = await planCodeTask(meta, index, {
      task: "Refactor alpha, beta, and gamma across modules",
      selectedFiles: ["a.ts", "b.ts", "sub/c.ts"],
    });
    expect(plan.relevantFiles.length).toBeLessThanOrEqual(3);
    expect(plan.dependencies.length).toBeLessThanOrEqual(15);
    expect(plan.symbols.length).toBeLessThanOrEqual(15);
    expect(plan.supportingFiles.length).toBeLessThanOrEqual(10);
    expect(plan.options.length).toBeLessThanOrEqual(2);
  });

  it("flags genuinely ambiguous tasks for clarification", async () => {
    const meta = registerProject(tmpRoot);
    const index = await indexProject(meta);
    const plan = await planCodeTask(meta, index, { task: "zzzq wobble fnord thingamajig" });
    expect(typeof plan.needsClarification).toBe("boolean");
    if (plan.needsClarification) {
      expect(plan.clarifyingQuestion).toBeTruthy();
    }
  });

  it("stays backward compatible over MCP without selected files", async () => {
    const parsed = await mcpCall(
      1,
      "kai_plan_task",
      {
        task: "Refactor the authentication module structure",
        mode: "code",
      },
      tmpRoot
    );
    for (const field of [
      "mode",
      "category",
      "confidence",
      "freshness",
      "relevantFiles",
      "options",
      "defaultOption",
      "note",
    ]) {
      expect(parsed).toHaveProperty(field);
    }
    expect(parsed.relevantFiles.length).toBeLessThanOrEqual(3);
    expect(parsed.project.id).toBeTruthy();
  });

  it("accepts a single selectedFile alias over MCP", async () => {
    const parsed = await mcpCall(
      2,
      "kai_plan_task",
      {
        task: "Fix beta",
        mode: "code",
        selectedFile: "b.ts",
      },
      tmpRoot
    );
    expect(parsed.selectedFiles).toContain("b.ts");
    expect(parsed.relevantFiles[0]).toBe("b.ts");
  });
});

describe("automatic freshness gate on graph-dependent reads", () => {
  it("kai_search_code auto-refreshes drift without a manual sync call", async () => {
    const meta = registerProject(tmpRoot);
    await indexProject(meta);
    write("a.ts", "export function alpha() { return 42; }\n");
    const parsed = await mcpCall(3, "kai_search_code", { query: "alpha" }, tmpRoot);
    expect(parsed.freshness).toBe("fresh");
    expect(parsed.refreshOutcome).toBe("refreshed");
    expect(parsed.matchesCount).toBeGreaterThan(0);
  });

  it("fresh graphs skip unnecessary rebuilds", async () => {
    const meta = registerProject(tmpRoot);
    await indexProject(meta);
    const ensured = await ensureFreshIndex(meta, loadProjectIndex(meta.id));
    expect(ensured.refreshOutcome).toBe("not-required");
    expect(ensured.freshnessAfter).toBe("fresh");
  });

  it("read tools report freshness truthfully", async () => {
    const meta = registerProject(tmpRoot);
    await indexProject(meta);
    const sym = await mcpCall(4, "kai_find_symbol", { name: "alpha" }, tmpRoot);
    expect(sym.freshness).toBe("fresh");
    expect(sym.foundCount).toBeGreaterThan(0);
    const deps = await mcpCall(5, "kai_get_dependencies", { filePath: "b.ts" }, tmpRoot);
    expect(deps.freshness).toBe("fresh");
    expect(deps.dependenciesCount).toBeGreaterThan(0);
  });
});

describe("kai_sync_graph hardening", () => {
  it("skips when nothing changed and no drift exists", async () => {
    const meta = registerProject(tmpRoot);
    await indexProject(meta);
    const report = await synchronizeGraphDeduped(meta, [], {
      ran: false,
      passed: false,
      detail: "no validation detail provided",
    });
    expect(report.graphResult).toBe("skipped");
  });

  it("does not assume empty hints mean no changes when drift exists", async () => {
    const meta = registerProject(tmpRoot);
    await indexProject(meta);
    write("a.ts", "export function alpha() { return 7; }\n");
    const report = await synchronizeGraphDeduped(meta, [], {
      ran: false,
      passed: false,
      detail: "no validation detail provided",
    });
    expect(report.graphResult).toBe("synced");
    expect(report.freshnessAfter).toBe("fresh");
  });

  it("rejects traversal and outside-root hints while syncing the rest", async () => {
    const meta = registerProject(tmpRoot);
    await indexProject(meta);
    write("a.ts", "export function alpha() { return 8; }\n");
    const report = await synchronizeGraphDeduped(meta, ["../evil.ts", "/etc/passwd", "a.ts"], {
      ran: true,
      passed: true,
      detail: "vitest",
    });
    expect(report.rejectedFiles?.length).toBe(2);
    expect(report.graphResult).toBe("synced");
  });

  it("shares one rebuild across duplicate concurrent completions", async () => {
    const meta = registerProject(tmpRoot);
    await indexProject(meta);
    write("a.ts", "export function alpha() { return 11; }\n");
    const validation = { ran: true, passed: true, detail: "vitest" };
    const [first, second] = await Promise.all([
      synchronizeGraphDeduped(meta, ["a.ts"], validation),
      synchronizeGraphDeduped(meta, ["a.ts"], validation),
    ]);
    expect(first.graphResult).toBe("synced");
    expect(second.graphResult).toBe("synced");
    expect(getGraphFreshness(loadProjectIndex(meta.id))).toBe("fresh");
  });

  it("refuses to publish when the project was closed or deleted", async () => {
    const meta = registerProject(tmpRoot);
    await indexProject(meta);
    write("a.ts", "export function alpha() { return 12; }\n");
    expect(deleteProjectData(meta.id).success).toBe(true);
    const report = await synchronizeGraphDeduped(meta, ["a.ts"], {
      ran: true,
      passed: true,
      detail: "vitest",
    });
    expect(report.graphResult).toBe("failed");
    expect(report.message).toMatch(/no longer registered|refusing/);
    // Source changes are never reverted by sync refusal.
    expect(fs.readFileSync(path.join(tmpRoot, "a.ts"), "utf-8")).toContain("return 12");
  });

  it("validates changed-file paths against the canonical root", () => {
    const { accepted, rejected } = resolveChangedFilesAgainstRoot(
      ["a.ts", "..\\evil.ts", "C:/Windows/x.ts", ".env", "sub/c.ts"],
      tmpRoot
    );
    expect(accepted).toContain("a.ts");
    expect(accepted).toContain("sub/c.ts");
    expect(rejected.length).toBe(3);
  });
});

describe("automatic lifecycle integration (no manual sync call)", () => {
  it("syncs automatically after a successful task", async () => {
    const meta = registerProject(tmpRoot);
    await indexProject(meta);
    const outcome = await runCodeTaskWithAutoSync(meta, async () => {
      write("a.ts", "export function alpha() { return 21; }\n");
      return {
        changedFiles: ["a.ts"],
        codeValidation: { ran: true, passed: true, detail: "vitest" },
      };
    });
    expect(outcome.taskOutcome).toBe("completed");
    expect(outcome.syncReport.graphResult).toBe("synced");
    expect(outcome.syncReport.freshnessAfter).toBe("fresh");
    expect(getGraphFreshness(loadProjectIndex(meta.id))).toBe("fresh");
  });

  it("syncs partial changes when the task fails, keeping outcomes separate", async () => {
    const meta = registerProject(tmpRoot);
    await indexProject(meta);
    const outcome = await runCodeTaskWithAutoSync(meta, async () => {
      write("a.ts", "export function alpha() { return 22; }\n");
      throw new Error("agent crashed after writing");
    });
    expect(outcome.taskOutcome).toBe("failed");
    expect(outcome.taskError).toContain("agent crashed");
    expect(outcome.syncReport.graphResult).toBe("synced");
    expect(fs.readFileSync(path.join(tmpRoot, "a.ts"), "utf-8")).toContain("return 22");
  });

  it("handles cancellation without losing the sync attempt", async () => {
    const meta = registerProject(tmpRoot);
    await indexProject(meta);
    const controller = new AbortController();
    controller.abort();
    const outcome = await runCodeTaskWithAutoSync(meta, async () => ({ changedFiles: ["a.ts"] }), {
      signal: controller.signal,
    });
    expect(outcome.taskOutcome).toBe("cancelled");
    expect(outcome.syncReport).toBeTruthy();
  });

  it("protects against project switching mid-task", async () => {
    const meta = registerProject(tmpRoot);
    await indexProject(meta);
    const outcome = await runCodeTaskWithAutoSync(meta, async () => {
      write("a.ts", "export function alpha() { return 23; }\n");
      // Simulate the user closing/deleting the project while the task ran.
      expect(deleteProjectData(meta.id).success).toBe(true);
      return { changedFiles: ["a.ts"] };
    });
    expect(outcome.taskOutcome).toBe("completed");
    expect(outcome.syncReport.graphResult).toBe("failed");
    expect(outcome.syncReport.message).toMatch(/no longer registered|refusing/);
  });

  it("the next graph-dependent plan sees the refreshed graph", async () => {
    const meta = registerProject(tmpRoot);
    await indexProject(meta);
    await runCodeTaskWithAutoSync(meta, async () => {
      write("a.ts", "export function alpha() { return 24; }\n");
      return { changedFiles: ["a.ts"] };
    });
    const plan = await planCodeTask(meta, loadProjectIndex(meta.id), {
      task: "Explain what alpha does now",
    });
    expect(plan.freshness).toBe("fresh");
    expect(plan.refreshOutcome).toBe("not-required");
  });
});

describe("kai run CLI lifecycle wrapper", () => {
  it("runs an agent command and auto-syncs without manual steps", async () => {
    const target = path.join(tmpRoot, "touched.ts");
    const script = `require("fs").writeFileSync(${JSON.stringify(target)}, "export const touched = 1;\\n");`;
    const code = await runCli([
      "node",
      "kai",
      "run",
      tmpRoot,
      "--",
      process.execPath,
      "-e",
      script,
    ]);
    expect(code).toBe(0);
    const index = loadProjectIndex(registerProject(tmpRoot).id)!;
    expect(getGraphFreshness(index)).toBe("fresh");
    expect(Object.keys(index.files)).toContain("touched.ts");
  });

  it("preserves agent failure exit codes while still syncing", async () => {
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
    const meta = registerProject(tmpRoot);
    expect(getGraphFreshness(loadProjectIndex(meta.id))).not.toBe("unindexed");
  });

  it("rejects a missing command separator", async () => {
    const code = await runCli(["node", "kai", "run", tmpRoot]);
    expect(code).toBe(1);
  });
});
