import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { handleMcpMessage } from "../core/mcp";
import { registerProject, loadProjectIndex, ProjectLock } from "../core/registry";
import { indexProject } from "../core/indexer";
import {
  isCodeMode,
  understandTask,
  buildPromptOptions,
  createPromptSession,
  resolvePromptSelection,
  getGraphFreshness,
  computeGraphImpact,
  validateGraphCandidate,
  sanitizeChangedFiles,
  markStaleGuarded,
  synchronizeGraphAfterChanges,
} from "../core/codeModeWorkflow";

let tmpHome = "";
let tmpRoot = "";
const prevHome = process.env.KAI_HOME;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "kai-home-"));
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kai-proj-"));
  process.env.KAI_HOME = tmpHome;
  fs.writeFileSync(path.join(tmpRoot, "a.ts"), "export function alpha() { return 1; }\n");
  fs.writeFileSync(path.join(tmpRoot, "b.ts"), "import { alpha } from './a';\n");
});

afterEach(() => {
  process.env.KAI_HOME = prevHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("code mode isolation", () => {
  it("gates workflow to code mode only", () => {
    expect(isCodeMode("code")).toBe(true);
    expect(isCodeMode("terminal")).toBe(false);
    expect(isCodeMode(null)).toBe(false);
    expect(isCodeMode(undefined)).toBe(false);
  });

  it("kai_plan_task preserves other modes without options", async () => {
    const res = await handleMcpMessage(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "kai_plan_task", arguments: { task: "Refactor auth", mode: "terminal" } },
      },
      tmpRoot
    );
    const text = (res?.result as Record<string, unknown[]>).content as Array<{ text: string }>;
    const parsed = JSON.parse(text[0].text);
    expect(parsed.modePreserved).toBe(true);
    expect(parsed.options).toEqual([]);
  });

  it("kai_sync_graph preserves other modes without syncing", async () => {
    const res = await handleMcpMessage(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "kai_sync_graph", arguments: { mode: "terminal", changedFiles: ["a.ts"] } },
      },
      tmpRoot
    );
    const text = (res?.result as Record<string, unknown[]>).content as Array<{ text: string }>;
    const parsed = JSON.parse(text[0].text);
    expect(parsed.modePreserved).toBe(true);
    expect(parsed.synced).toBe(false);
  });
});

describe("prompt selection", () => {
  it("simple tasks produce no options", () => {
    const u = understandTask("Explain what alpha does");
    const opts = buildPromptOptions("Explain what alpha does", u, ["a.ts"]);
    expect(opts).toEqual([]);
  });

  it("complex tasks produce one or two useful options", () => {
    const task = "Refactor the authentication module structure";
    const u = understandTask(task);
    const opts = buildPromptOptions(task, u, ["a.ts"]);
    expect(opts.length).toBeGreaterThanOrEqual(1);
    expect(opts.length).toBeLessThanOrEqual(2);
    expect(opts[0].id).toBe("option1");
  });

  it("explicit selections and custom prompts resolve correctly", () => {
    const u = understandTask("Refactor the authentication module structure");
    const opts = buildPromptOptions("Refactor the authentication module structure", u);
    const session = createPromptSession("Refactor the authentication module structure", opts);
    expect(resolvePromptSelection(session, "use option 2").kind).toBe("option2");
    expect(resolvePromptSelection(session, "use option 1").kind).toBe("option1");
    expect(resolvePromptSelection(session, "yes, go ahead").kind).toBe("default1");
    const custom = resolvePromptSelection(
      session,
      "Actually use my own approach: rewrite auth with JWT middleware and refresh tokens"
    );
    expect(["custom", "reassess"]).toContain(custom.kind);
    expect(custom.prompt).toContain("JWT");
  });

  it("materially changed request is reassessed, not treated as selection", () => {
    const u = understandTask("Refactor the authentication module structure");
    const opts = buildPromptOptions("Refactor the authentication module structure", u);
    const session = createPromptSession("Refactor the authentication module structure", opts);
    const r = resolvePromptSelection(
      session,
      "Now instead deploy a Python data pipeline to BigQuery"
    );
    expect(r.kind).toBe("reassess");
  });
});

describe("graph freshness", () => {
  it("fresh graph does not need rebuild; relevance changes map to scope", async () => {
    const meta = registerProject(tmpRoot);
    const index = await indexProject(meta);
    expect(getGraphFreshness(index)).toBe("fresh");
    expect(computeGraphImpact([]).scope).toBe("none");
    expect(computeGraphImpact(["a.ts"]).scope).toBe("incremental");
    expect(computeGraphImpact(["package.json"]).scope).toBe("full");
    expect(computeGraphImpact(["x.ts"], { uncertain: true }).scope).toBe("full");
  });

  it("modified files mark graph stale", async () => {
    const meta = registerProject(tmpRoot);
    const index = await indexProject(meta);
    expect(getGraphFreshness(index)).toBe("fresh");
    fs.writeFileSync(path.join(tmpRoot, "a.ts"), "export function alpha() { return 2; }\n");
    const loaded = loadProjectIndex(meta.id)!;
    expect(getGraphFreshness(loaded)).toBe("stale");
  });

  it("null graph is unindexed, failed meta is refresh-failed", () => {
    expect(getGraphFreshness(null)).toBe("unindexed");
    const meta = registerProject(tmpRoot);
    expect(
      getGraphFreshness({
        meta: { ...meta, lastIndexedAt: new Date().toISOString(), status: "failed" },
        files: {},
        symbolIndex: {},
        rules: [],
        totalTokensEstimated: 0,
        generatedAt: new Date().toISOString(),
      })
    ).toBe("refresh-failed");
  });
});

describe("graph integrity", () => {
  it("invalid candidate does not replace last-known-good", async () => {
    const meta = registerProject(tmpRoot);
    const good = await indexProject(meta);
    const goodCount = Object.keys(good.files).length;
    const check = validateGraphCandidate({ meta: { id: meta.id }, files: [], symbolIndex: {} });
    expect(check.valid).toBe(false);
    const after = loadProjectIndex(meta.id)!;
    expect(Object.keys(after.files).length).toBe(goodCount);
  });

  it("sync skips when no impact and syncs on small change", async () => {
    const meta = registerProject(tmpRoot);
    await indexProject(meta);
    const skipped = await synchronizeGraphAfterChanges(meta, [], {
      ran: true,
      passed: true,
      detail: "vitest sample passed",
    });
    expect(skipped.graphResult).toBe("skipped");
    fs.writeFileSync(path.join(tmpRoot, "a.ts"), "export function alpha() { return 3; }\n");
    const synced = await synchronizeGraphAfterChanges(meta, ["a.ts"], {
      ran: true,
      passed: true,
      detail: "vitest sample passed",
    });
    expect(synced.graphResult).toBe("synced");
    expect(synced.freshnessAfter).toBe("fresh");
  });

  it("sync failure preserves code outcome separately and marks stale", async () => {
    const meta = registerProject(tmpRoot);
    await indexProject(meta);
    // Hold the index lock so the rebuild cannot proceed: forces the
    // failure path (graph marked stale, code outcome reported separately).
    const lock = new ProjectLock(meta.id);
    expect(lock.acquire(1000)).toBe(true);
    try {
      const report = await synchronizeGraphAfterChanges(meta, ["a.ts"], {
        ran: true,
        passed: false,
        detail: "1 test failed",
      });
      expect(report.codeValidation.passed).toBe(false);
      expect(["failed", "stale-preserved"]).toContain(report.graphResult);
      expect(report.freshnessAfter).toBe("stale");
    } finally {
      lock.release();
    }
  });
});

describe("efficiency and compatibility", () => {
  it("kai_plan_task returns at most 2 options with relevant files only", async () => {
    const res = await handleMcpMessage(
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "kai_plan_task",
          arguments: { task: "Refactor the authentication module structure", mode: "code" },
        },
      },
      tmpRoot
    );
    const text = (res?.result as Record<string, unknown[]>).content as Array<{ text: string }>;
    const parsed = JSON.parse(text[0].text);
    expect(parsed.options.length).toBeLessThanOrEqual(2);
    expect((parsed.relevantFiles as string[]).length).toBeLessThanOrEqual(3);
  });

  it("existing tools still listed", async () => {
    const res = await handleMcpMessage({ jsonrpc: "2.0", id: 4, method: "tools/list" }, tmpRoot);
    const names = (res?.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
    for (const n of [
      "kai_project_info",
      "kai_search_code",
      "kai_find_symbol",
      "kai_get_dependencies",
      "kai_get_context",
      "kai_refresh_index",
    ])
      expect(names).toContain(n);
  });
});

describe("prompt selection precedence (audit)", () => {
  const task = "Refactor the authentication module structure";
  function session() {
    const u = understandTask(task);
    return createPromptSession(task, buildPromptOptions(task, u));
  }

  it("preserves an overlapping user refinement instead of defaulting to option 1", () => {
    const r = resolvePromptSelection(session(), "refactor auth module with tabs");
    expect(r.kind).toBe("custom");
    expect(r.prompt).toBe("refactor auth module with tabs");
  });

  it("preserves affirmations carrying extra instructions", () => {
    for (const msg of ["yes use JWT auth for this", "proceed with tabs please!"]) {
      const r = resolvePromptSelection(session(), msg);
      expect(["custom", "reassess"]).toContain(r.kind);
      expect(r.prompt).toBe(msg);
    }
  });

  it("still defaults pure continuations to option 1", () => {
    for (const msg of ["", "yes", "ok", "go ahead", "yes, go ahead"]) {
      expect(resolvePromptSelection(session(), msg).kind).toBe("default1");
    }
  });

  it("still reassesses materially different requests", () => {
    const r = resolvePromptSelection(
      session(),
      "Now instead deploy a Python data pipeline to BigQuery"
    );
    expect(r.kind).toBe("reassess");
    expect(r.prompt).toContain("BigQuery");
  });
});

describe("truthful validation reporting (audit)", () => {
  it("never defaults an omitted code-validation outcome to passed", async () => {
    const meta = registerProject(tmpRoot);
    await indexProject(meta);
    fs.writeFileSync(path.join(tmpRoot, "a.ts"), "export function alpha() { return 9; }\n");
    const report = await synchronizeGraphAfterChanges(meta, ["a.ts"], {
      ran: false,
      passed: false,
      detail: "no validation detail provided",
    });
    expect(report.codeValidation).toEqual({
      ran: false,
      passed: false,
      detail: "no validation detail provided",
    });
    // Caller-reported outcome is echoed, never upgraded.
    const res = await handleMcpMessage(
      {
        jsonrpc: "2.0",
        id: 11,
        method: "tools/call",
        params: { name: "kai_sync_graph", arguments: { mode: "code", changedFiles: ["a.ts"] } },
      },
      tmpRoot
    );
    const text = (res?.result as Record<string, unknown[]>).content as Array<{ text: string }>;
    const parsed = JSON.parse(text[0].text);
    expect(parsed.codeValidation.ran).toBe(false);
    expect(parsed.codeValidation.passed).toBe(false);
  });
});

describe("graph integrity and rollback (audit)", () => {
  it("rejects malformed candidates (dangling refs, unsafe keys, traversal)", () => {
    const meta = registerProject(tmpRoot);
    const goodBase = {
      meta: { id: meta.id, canonicalPath: tmpRoot },
      files: {
        "a.ts": {
          relativePath: "a.ts",
          sha256: "x",
          symbols: [],
          dependencies: [],
        },
      },
      symbolIndex: {},
    };
    expect(validateGraphCandidate(goodBase).valid).toBe(true);
    // Symbol referencing an unknown file.
    expect(
      validateGraphCandidate({
        ...goodBase,
        symbolIndex: {
          alpha: [{ name: "alpha", filePath: "missing.ts", location: {} }],
        },
      }).valid
    ).toBe(false);
    // Prototype-pollution key (parsed from JSON so it is an own key; an
    // object literal would silently set the prototype instead).
    const protoPolluted = { ...goodBase, symbolIndex: JSON.parse('{ "__proto__": [] }') };
    expect(validateGraphCandidate(protoPolluted).valid).toBe(false);
    // Path traversal in file key.
    expect(
      validateGraphCandidate({
        ...goodBase,
        files: { "../evil": goodBase.files["a.ts"] },
      }).valid
    ).toBe(false);
  });

  it("failed sync preserves graph payload and keeps metadata consistent", async () => {
    const meta = registerProject(tmpRoot);
    await indexProject(meta);
    const { getProjectIndexPath, getProjectMetaPath } = await import("../core/registry");
    const beforeIndex = JSON.parse(fs.readFileSync(getProjectIndexPath(meta.id), "utf-8"));
    const lock = new ProjectLock(meta.id);
    expect(lock.acquire(1000)).toBe(true);
    try {
      const report = await synchronizeGraphAfterChanges(meta, ["a.ts"], {
        ran: true,
        passed: true,
        detail: "vitest",
      });
      expect(report.graphResult).toBe("failed");
      expect(report.freshnessAfter).not.toBe("fresh");
    } finally {
      lock.release();
    }
    // Graph payload (files/symbols/rules) is preserved; only the status
    // copies transition to stale — in both metadata copies consistently.
    const afterRaw = fs.readFileSync(getProjectIndexPath(meta.id), "utf-8");
    const afterIndex = JSON.parse(afterRaw);
    expect(afterIndex.files).toEqual(beforeIndex.files);
    expect(afterIndex.symbolIndex).toEqual(beforeIndex.symbolIndex);
    expect(afterIndex.rules).toEqual(beforeIndex.rules);
    expect(afterIndex.meta.status).toBe("stale");
    // Metadata is consistent: stale status with counts matching the index.
    const metaAfter = JSON.parse(fs.readFileSync(getProjectMetaPath(meta.id), "utf-8"));
    const indexAfter = loadProjectIndex(meta.id)!;
    expect(metaAfter.status).toBe("stale");
    expect(indexAfter.meta.status).toBe("stale");
    expect(metaAfter.fileCount).toBe(Object.keys(indexAfter.files).length);
    expect(validateGraphCandidate(indexAfter).valid).toBe(true);
    expect(getGraphFreshness(indexAfter)).toBe("stale");
  });

  it("releases locks on error paths and recovers on the next sync", async () => {
    const meta = registerProject(tmpRoot);
    await indexProject(meta);
    const lock = new ProjectLock(meta.id);
    expect(lock.acquire(1000)).toBe(true);
    try {
      await synchronizeGraphAfterChanges(meta, ["a.ts"], {
        ran: true,
        passed: true,
        detail: "vitest",
      });
    } finally {
      lock.release();
    }
    // Lock is free again and the stale graph recovers to fresh.
    const relock = new ProjectLock(meta.id);
    expect(relock.acquire(1000)).toBe(true);
    relock.release();
    fs.writeFileSync(path.join(tmpRoot, "a.ts"), "export function alpha() { return 4; }\n");
    const recovered = await synchronizeGraphAfterChanges(meta, ["a.ts"], {
      ran: true,
      passed: true,
      detail: "vitest",
    });
    expect(recovered.graphResult).toBe("synced");
    expect(recovered.freshnessAfter).toBe("fresh");
  });

  it("dry-run candidate builds never touch persisted graph state", async () => {
    const meta = registerProject(tmpRoot);
    await indexProject(meta);
    const { getProjectIndexPath, getProjectMetaPath } = await import("../core/registry");
    const beforeIndex = fs.readFileSync(getProjectIndexPath(meta.id), "utf-8");
    const beforeMeta = fs.readFileSync(getProjectMetaPath(meta.id), "utf-8");
    fs.writeFileSync(path.join(tmpRoot, "c.ts"), "export function gamma() { return 1; }\n");
    const candidate = await indexProject(meta, { dryRun: true });
    expect(candidate.files["c.ts"]).toBeDefined();
    expect(fs.readFileSync(getProjectIndexPath(meta.id), "utf-8")).toBe(beforeIndex);
    expect(fs.readFileSync(getProjectMetaPath(meta.id), "utf-8")).toBe(beforeMeta);
  });

  it("guarded stale-mark never touches a newer concurrent graph", async () => {
    const meta = registerProject(tmpRoot);
    const first = await indexProject(meta);
    const oldGen = first.generatedAt;
    // Simulate a concurrent sync publishing a newer valid graph.
    await new Promise((r) => setTimeout(r, 5));
    await indexProject(meta, { forceRebuild: true });
    const newer = loadProjectIndex(meta.id)!;
    expect(newer.generatedAt).not.toBe(oldGen);
    expect(markStaleGuarded(meta.id, oldGen, "outdated attempt")).toBe(false);
    const untouched = loadProjectIndex(meta.id)!;
    expect(untouched.generatedAt).toBe(newer.generatedAt);
    const { getProjectMetaPath } = await import("../core/registry");
    expect(JSON.parse(fs.readFileSync(getProjectMetaPath(meta.id), "utf-8")).status).toBe("ready");
    // Matching generation still marks stale.
    expect(markStaleGuarded(meta.id, newer.generatedAt, "genuine failure")).toBe(true);
    expect(JSON.parse(fs.readFileSync(getProjectMetaPath(meta.id), "utf-8")).status).toBe("stale");
  });

  it("sanitizes caller-reported changed files", () => {
    expect(sanitizeChangedFiles(["a.ts", 42, "", "  ", null, "b\\c.ts"])).toEqual([
      "a.ts",
      "b/c.ts",
    ]);
    expect(sanitizeChangedFiles("a.ts")).toEqual([]);
    expect(sanitizeChangedFiles(Array(60).fill("x.ts")).length).toBe(50);
  });

  it("failed source changes are never reverted by a failed sync", async () => {
    const meta = registerProject(tmpRoot);
    await indexProject(meta);
    const changed = "export function alpha() { return 42; }\n";
    fs.writeFileSync(path.join(tmpRoot, "a.ts"), changed);
    const lock = new ProjectLock(meta.id);
    expect(lock.acquire(1000)).toBe(true);
    try {
      await synchronizeGraphAfterChanges(meta, ["a.ts"], {
        ran: true,
        passed: true,
        detail: "vitest",
      });
    } finally {
      lock.release();
    }
    expect(fs.readFileSync(path.join(tmpRoot, "a.ts"), "utf-8")).toBe(changed);
  });
});
