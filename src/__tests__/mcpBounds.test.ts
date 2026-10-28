import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { MCP_TOOLS, handleMcpMessage } from "../core/mcp";
import {
  registerProject,
  loadProjectIndexShared,
  getIndexCacheStats,
  getProjectIndexPath,
  getProjectMetaPath,
  checkPersistenceConsistency,
  resolveCanonicalPath,
} from "../core/registry";
import { getMaxResponseBytes, MIN_MAX_RESPONSE_BYTES } from "../core/mcpResponse";
import { estimateTokens } from "../core/tokenCounter";
import { callTool } from "./helpers/mcpCall";

const CEILING = 16 * 1024;
const prev = {
  home: process.env.KAI_HOME,
  ceiling: process.env.KAI_MCP_MAX_RESPONSE_BYTES,
};

function write(root: string, rel: string, content: string): void {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function useTempKai(): { home: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "kai-bounds-home-"));
  process.env.KAI_HOME = home;
  process.env.KAI_MCP_MAX_RESPONSE_BYTES = String(CEILING);
  return { home };
}

afterAll(() => {
  if (prev.home === undefined) delete process.env.KAI_HOME;
  else process.env.KAI_HOME = prev.home;
  if (prev.ceiling === undefined) delete process.env.KAI_MCP_MAX_RESPONSE_BYTES;
  else process.env.KAI_MCP_MAX_RESPONSE_BYTES = prev.ceiling;
});

// ---------------------------------------------------------------------------

// Builds a ~1,000-file project and calls every tool; the suite runs dozens of files in
// parallel, so these get a generous timeout instead of the 30 s default.
describe("every MCP tool is bounded on a large project", { timeout: 180_000 }, () => {
  let home = "";
  let root = "";
  const PROCESS_FILES = 220;
  const BARREL_IMPORTS = 700;
  const EXTRA_FILES = 120;

  beforeAll(() => {
    ({ home } = useTempKai());
    root = fs.mkdtempSync(path.join(os.tmpdir(), "kai-bounds-proj-"));
    for (let i = 0; i < PROCESS_FILES; i++) {
      write(
        root,
        `src/handlers/h${i}.ts`,
        [
          "export function process(",
          "  input: string,",
          "  flags: number,",
          "): string {",
          "  const trimmed = input.trim();",
          `  return trimmed + "tag-${i}" + flags;`,
          "}",
          "",
        ].join("\n")
      );
    }
    const imports: string[] = [];
    for (let i = 0; i < BARREL_IMPORTS; i++)
      imports.push(`import { item${i} } from "pkg-${i}/entry";`);
    write(root, "src/barrel.ts", imports.join("\n") + "\nexport const BARREL = 1;\n");
    for (let i = 0; i < EXTRA_FILES; i++) {
      write(root, `src/extra/e${i}.ts`, `export const E${i} = ${i};\n`);
    }
  });

  afterAll(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("keeps all ten tools' serialized responses within the ceiling and valid JSON", async () => {
    const manyFiles = Array.from({ length: 60 }, (_, i) => `src/extra/e${i}.ts`);
    const calls: Array<[string, Record<string, unknown>]> = [
      ["kai_project_info", { includeChanges: true, limit: 200 }],
      ["kai_search_code", { query: "process", limit: 20 }],
      ["kai_search_code", { query: "process", limit: 20, includeSource: true }],
      ["kai_find_symbol", { name: "process", limit: 100 }],
      ["kai_get_dependencies", { filePath: "src/barrel.ts", limit: 200, includeDependents: true }],
      ["kai_read_range", { filePath: "src/barrel.ts", startLine: 1, endLine: 400, maxLines: 400 }],
      ["kai_get_context", { task: "explain how the process handlers work", tokenBudget: 20000 }],
      ["kai_refresh_index", { includeChanges: true, limit: 200 }],
      ["kai_plan_task", { task: "refactor the process handlers", selectedFiles: manyFiles }],
      ["kai_sync_graph", { changedFiles: manyFiles, codeValidationDetail: "x".repeat(2000) }],
      ["kai_get_lsp_status", {}],
    ];
    for (const [name, args] of calls) {
      const r = await callTool(root, name, args);
      expect(r.bytes, `${name} bytes`).toBeLessThanOrEqual(CEILING);
      if (name !== "kai_get_context") {
        expect(r.error, `${name} error`).toBeUndefined();
        expect(r.json, `${name} json`).not.toBeNull();
      }
      // The line itself must be valid JSON-RPC.
      expect(JSON.parse(JSON.stringify(r.res)).jsonrpc).toBe("2.0");
    }
  });

  it("paginates hundreds of symbol matches with correct counts and no gaps or repeats", async () => {
    const seen: string[] = [];
    let offset = 0;
    let pages = 0;
    let sawTruncation = false;
    for (;;) {
      const r = await callTool(root, "kai_find_symbol", { name: "process", limit: 100, offset });
      const j = r.json!;
      expect(r.bytes).toBeLessThanOrEqual(CEILING);
      expect(j.foundCount).toBe(PROCESS_FILES);
      expect(j.total).toBe(PROCESS_FILES);
      expect(j.returned).toBe(j.symbols.length);
      expect(j.offset).toBe(offset);
      if (j.truncated) {
        sawTruncation = true;
        expect(j.outputLimit.maxBytes).toBe(CEILING);
      }
      for (const s of j.symbols) seen.push(s.filePath);
      pages++;
      if (!j.hasMore) {
        expect(j.nextOffset).toBeUndefined();
        break;
      }
      // Truncation by the byte ceiling still resumes exactly where it stopped.
      expect(j.nextOffset).toBe(offset + j.returned);
      offset = j.nextOffset;
      expect(pages).toBeLessThan(200);
    }
    // 100 compact symbols exceed 16 KiB, so the shaper had to cut at least one page.
    expect(sawTruncation).toBe(true);
    expect(seen).toHaveLength(PROCESS_FILES);
    expect(new Set(seen).size).toBe(PROCESS_FILES);
  });

  it("bounds a very large dependency list and enumerates it by nextOffset", async () => {
    const collected = new Set<string>();
    let offset = 0;
    let first: Record<string, any> | null = null;
    for (let guard = 0; guard < 100; guard++) {
      const r = await callTool(root, "kai_get_dependencies", {
        filePath: "src/barrel.ts",
        limit: 200,
        offset,
      });
      const j = r.json!;
      first ??= j;
      expect(r.bytes).toBeLessThanOrEqual(CEILING);
      for (const d of j.dependencies) collected.add(d.targetSpecifier);
      if (!j.hasMore) break;
      offset = j.nextOffset;
    }
    expect(first!.dependenciesCount).toBe(BARREL_IMPORTS);
    expect(first!.total).toBe(BARREL_IMPORTS);
    expect(first!.resolutionSummary.packageOrAlias).toBe(BARREL_IMPORTS);
    expect(collected.size).toBe(BARREL_IMPORTS);
  });

  it("replaces full change lists with counts, and pages the details on request", async () => {
    const info = await callTool(root, "kai_project_info", {});
    const j = info.json!;
    expect(typeof j.changes.added).toBe("number");
    expect(j.changes.added).toBeGreaterThan(PROCESS_FILES);
    expect(j.changeDetails).toBeUndefined();
    // No per-file path list leaks into the default response.
    expect(info.text).not.toContain("src/extra/e1.ts");
    expect(info.bytes).toBeLessThan(2500);
    expect(j.languageBreakdown.typescript).toBeGreaterThan(0);

    const page1 = await callTool(root, "kai_project_info", { includeChanges: true, limit: 50 });
    const p = page1.json!;
    expect(p.total).toBe(
      j.changes.added + j.changes.modified + j.changes.renamed + j.changes.deleted
    );
    expect(p.changeDetails.length).toBeLessThanOrEqual(50);
    expect(p.hasMore).toBe(true);
    expect(page1.bytes).toBeLessThanOrEqual(CEILING);
  });

  it("returns explicit truncation metadata and keeps required fields when the ceiling bites", async () => {
    process.env.KAI_MCP_MAX_RESPONSE_BYTES = String(MIN_MAX_RESPONSE_BYTES);
    let r: Awaited<ReturnType<typeof callTool>>;
    try {
      r = await callTool(root, "kai_search_code", {
        query: "process",
        limit: 20,
        includeSource: true,
      });
    } finally {
      process.env.KAI_MCP_MAX_RESPONSE_BYTES = String(CEILING);
    }
    const j = r.json!;
    expect(r.bytes).toBeLessThanOrEqual(MIN_MAX_RESPONSE_BYTES);
    // Required fields survive any shortening.
    for (const key of [
      "query",
      "freshness",
      "refreshOutcome",
      "total",
      "returned",
      "hasMore",
      "files",
    ]) {
      expect(j, key).toHaveProperty(key);
    }
    expect(j.total).toBe(PROCESS_FILES);
    expect(j.truncated).toBe(true);
    expect(j.outputLimit.maxBytes).toBe(MIN_MAX_RESPONSE_BYTES);
    expect(j.returned).toBe(j.files.length);
    expect(j.matchesCount).toBe(j.files.length);
    expect(j.hasMore).toBe(true);
    expect(j.nextOffset).toBe(j.returned);
  });

  it("rejects an oversized JSON-RPC id and clips echoed names so errors stay small", async () => {
    const huge = "i".repeat(5000);
    const bad = await handleMcpMessage(
      { jsonrpc: "2.0", id: huge, method: "tools/call", params: { name: "kai_get_lsp_status" } },
      root
    );
    expect(bad?.error?.code).toBe(-32600);
    expect(bad?.id).toBeNull();

    const unknown = await handleMcpMessage(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "x".repeat(50000) } },
      root
    );
    expect(unknown?.error?.code).toBe(-32601);
    expect(Buffer.byteLength(JSON.stringify(unknown), "utf8")).toBeLessThan(1000);

    const method = await handleMcpMessage(
      { jsonrpc: "2.0", id: 2, method: "m".repeat(50000) },
      root
    );
    expect(Buffer.byteLength(JSON.stringify(method), "utf8")).toBeLessThan(1000);
  });

  it("validates pagination arguments", async () => {
    const bad1 = await callTool(root, "kai_find_symbol", { name: "process", limit: 0 });
    expect(bad1.error?.code).toBe(-32602);
    const bad2 = await callTool(root, "kai_find_symbol", { name: "process", offset: -1 });
    expect(bad2.error?.code).toBe(-32602);
    const beyond = await callTool(root, "kai_find_symbol", { name: "process", offset: 100000 });
    expect(beyond.json).toMatchObject({ returned: 0, hasMore: false, total: PROCESS_FILES });
  });
});

// ---------------------------------------------------------------------------

describe("dependents paging", () => {
  let home = "";
  let root = "";

  beforeAll(() => {
    ({ home } = useTempKai());
    root = fs.mkdtempSync(path.join(os.tmpdir(), "kai-dependents-proj-"));
    write(root, "src/hub.ts", ["export const HUB = 1;", ""].join("\n"));
    for (let i = 0; i < 30; i++) {
      const lines = ['import { HUB } from "../hub";', `export const U${i} = HUB;`, ""];
      write(root, `src/users/u${i}.ts`, lines.join("\n"));
    }
  });

  afterAll(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("walks every dependent with offset instead of repeating the first page", async () => {
    const seen = new Set<string>();
    let offset = 0;
    for (let guard = 0; guard < 10; guard++) {
      const j = (
        await callTool(root, "kai_get_dependencies", {
          filePath: "src/hub.ts",
          includeDependents: true,
          limit: 12,
          offset,
        })
      ).json!;
      expect(j.dependentsCount).toBe(30);
      for (const d of j.dependents) seen.add(d);
      if (!j.dependentsHasMore) break;
      offset = j.dependentsNextOffset;
    }
    expect(seen.size).toBe(30);
  });
});

describe("ceiling arithmetic counts escaping and multibyte text", () => {
  let home = "";
  let root = "";
  beforeAll(() => {
    ({ home } = useTempKai());
    process.env.KAI_MCP_MAX_RESPONSE_BYTES = String(MIN_MAX_RESPONSE_BYTES); // 8 KiB
    root = fs.mkdtempSync(path.join(os.tmpdir(), "kai-bounds-uni-"));
    // Snippets full of quotes, backslashes, newlines and 4-byte emoji inflate when JSON is
    // embedded in the tool-result text (each quote becomes \" on the wire).
    const body = Array.from(
      { length: 40 },
      (_, i) => `  const s${i} = "quote \\" back\\\\slash 😀 ünï ${i}";`
    ).join("\n");
    for (let i = 0; i < 12; i++) {
      write(
        root,
        `src/u${i}.ts`,
        `export function render${i}(): string {\n${body}\n  return s0;\n}\n`
      );
    }
  });
  afterAll(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("stays within a small ceiling for source-heavy results", async () => {
    expect(getMaxResponseBytes()).toBe(MIN_MAX_RESPONSE_BYTES);
    for (const args of [{ query: "render" }, { query: "render", limit: 20 }]) {
      const r = await callTool(root, "kai_search_code", args);
      expect(r.bytes).toBeLessThanOrEqual(MIN_MAX_RESPONSE_BYTES);
      expect(r.json).not.toBeNull();
      expect(r.json!.total).toBe(12);
    }
    const ctx = await callTool(root, "kai_get_context", {
      task: "explain render",
      tokenBudget: 20000,
    });
    expect(ctx.bytes).toBeLessThanOrEqual(MIN_MAX_RESPONSE_BYTES);
    expect(ctx.text).toContain("explain render");
    const range = await callTool(root, "kai_read_range", {
      filePath: "src/u0.ts",
      startLine: 1,
      endLine: 42,
    });
    expect(range.bytes).toBeLessThanOrEqual(MIN_MAX_RESPONSE_BYTES);
    expect(range.json!.status).toBe("ok");
    expect(range.json!.source).toContain("😀");
  });
});

// ---------------------------------------------------------------------------

describe("metadata-first search", () => {
  let home = "";
  let root = "";
  beforeAll(() => {
    ({ home } = useTempKai());
    process.env.KAI_MCP_MAX_RESPONSE_BYTES = String(256 * 1024);
    root = fs.mkdtempSync(path.join(os.tmpdir(), "kai-bounds-meta-"));
    const body = Array.from({ length: 90 }, (_, i) => `  total += values[${i % 5}] * ${i};`);
    write(
      root,
      "src/token_utils.ts",
      [
        "const rawTokens = 4;", // 1
        "", // 2
        "export function countWords(text: string): number {", // 3
        "  return text.split(/\\s+/).length;", // 4
        "}", // 5
        "", // 6
        "export function estimateTokens(", // 7
        "  values: number[],", // 8
        "  scale: number,", // 9
        "): number {", // 10
        "  let total = rawTokens;", // 11
        ...body, // 12..101
        "  return total * scale;", // 102
        "}", // 103
      ].join("\n")
    );
  });
  afterAll(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("returns paths, accurate ranges, symbols, reason, hash and estimates without source", async () => {
    const r = await callTool(root, "kai_search_code", {
      query: "estimateTokens",
      includeSource: false,
    });
    const j = r.json!;
    expect(j.includeSource).toBe(false);
    expect(j.tokenEstimate).toBe("bytes/4");
    const hit = j.files[0];
    expect(hit.relativePath).toBe("src/token_utils.ts");
    expect(hit.snippet).toBeUndefined();
    expect(JSON.stringify(hit)).not.toContain("total +=");
    expect(hit.symbols[0]).toMatchObject({
      name: "estimateTokens",
      kind: "function",
      startLine: 7,
      endLine: 103,
    });
    expect(hit.reason).toContain("estimateTokens");
    expect(hit.contentHash).toMatch(/^[0-9a-f]{16}$/);
    expect(hit.estimatedSourceTokens).toBeGreaterThan(0);
    // The range is the declaration (plus a little leading context), capped in size.
    expect(hit.startLine).toBe(4);
    expect(hit.endLine - hit.startLine + 1).toBeLessThanOrEqual(60);
    // Absolute paths never appear.
    expect(r.text).not.toContain(root);
  });

  it("omits source by default: no snippet, no file text anywhere in the response", async () => {
    const r = await callTool(root, "kai_search_code", { query: "estimateTokens" });
    const j = r.json!;
    expect(j.includeSource).toBe(false);
    for (const f of j.files) {
      expect(f.snippet).toBeUndefined();
      expect(f.sourceOmitted).toBeUndefined();
    }
    expect(r.text).not.toContain("total +=");
    // Same answer as the explicit opt-out: the default is the metadata mode.
    const explicit = await callTool(root, "kai_search_code", {
      query: "estimateTokens",
      includeSource: false,
    });
    expect(explicit.json).toEqual(j);
  });

  it("includeSource:true restores snippets, with a range that matches the text", async () => {
    const r = await callTool(root, "kai_search_code", {
      query: "estimateTokens",
      includeSource: true,
    });
    const hit = r.json!.files[0];
    expect(r.json!.includeSource).toBe(true);
    expect(hit.snippet).toContain("export function estimateTokens(");
    const fileLines = fs.readFileSync(path.join(root, "src/token_utils.ts"), "utf8").split("\n");
    const snippetLines = hit.snippet.split("\n");
    expect(snippetLines[0]).toBe(fileLines[hit.startLine - 1]);
    expect(snippetLines[snippetLines.length - 1]).toBe(fileLines[hit.endLine - 1]);
  });

  it("is much smaller than the source-inclusive response for the same query", async () => {
    const meta = await callTool(root, "kai_search_code", {
      query: "estimateTokens",
      includeSource: false,
    });
    const full = await callTool(root, "kai_search_code", {
      query: "estimateTokens",
      includeSource: true,
    });
    expect(meta.bytes).toBeLessThan(full.bytes / 2);
  });

  it("validates includeSource", async () => {
    const r = await callTool(root, "kai_search_code", { query: "x", includeSource: "no" });
    expect(r.error?.code).toBe(-32602);
  });

  it("advertises concise schemas including kai_read_range", () => {
    const names = MCP_TOOLS.map((t) => t.name);
    expect(names).toContain("kai_read_range");
    expect(names).toHaveLength(10);
    expect(Buffer.byteLength(JSON.stringify(MCP_TOOLS), "utf8")).toBeLessThan(9000);
    const search = MCP_TOOLS.find((t) => t.name === "kai_search_code")!;
    expect(Object.keys(search.inputSchema.properties)).toEqual(
      expect.arrayContaining(["query", "limit", "offset", "includeSource"])
    );
  });
});

// ---------------------------------------------------------------------------

describe("index cache and redundant work", () => {
  let home = "";
  let root = "";
  beforeEach(() => {
    ({ home } = useTempKai());
    process.env.KAI_MCP_MAX_RESPONSE_BYTES = String(256 * 1024);
    root = fs.mkdtempSync(path.join(os.tmpdir(), "kai-cache-proj-"));
    write(root, "src/a.ts", "export function alpha() { return 1; }\n");
    write(
      root,
      "src/b.ts",
      "import { alpha } from './a';\nexport function beta() { return alpha(); }\n"
    );
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("serves repeated reads from the cache and never rewrites meta.json or index.json", async () => {
    await callTool(root, "kai_find_symbol", { name: "alpha" }); // builds the index
    const meta = registerProject(root);
    const snap = () => ({
      meta: fs.statSync(getProjectMetaPath(meta.id)).mtimeMs,
      index: fs.statSync(getProjectIndexPath(meta.id)).mtimeMs,
    });
    await callTool(root, "kai_find_symbol", { name: "alpha" }); // first shared load (miss)
    const before = snap();
    const stats0 = getIndexCacheStats();
    for (let i = 0; i < 4; i++) {
      const r = await callTool(root, "kai_find_symbol", { name: "alpha" });
      expect(r.json!.refreshOutcome).toBe("not-required");
    }
    const stats1 = getIndexCacheStats();
    expect(stats1.hits - stats0.hits).toBe(4);
    expect(stats1.misses).toBe(stats0.misses);
    expect(snap()).toEqual(before);
  });

  it("invalidates on edits: the next read sees the new content, not a cached copy", async () => {
    await callTool(root, "kai_find_symbol", { name: "alpha" });
    await callTool(root, "kai_find_symbol", { name: "alpha" });
    write(root, "src/a.ts", "export function gamma() { return 2; }\n");
    const r = await callTool(root, "kai_find_symbol", { name: "gamma" });
    expect(r.json!.refreshOutcome).toBe("refreshed");
    expect(r.json!.foundCount).toBe(1);
    const gone = await callTool(root, "kai_find_symbol", { name: "alpha" });
    expect(gone.json!.foundCount).toBe(0);
    // And deletions / additions.
    fs.rmSync(path.join(root, "src/b.ts"));
    write(root, "src/c.ts", "export function delta() {}\n");
    expect((await callTool(root, "kai_find_symbol", { name: "beta" })).json!.foundCount).toBe(0);
    expect((await callTool(root, "kai_find_symbol", { name: "delta" })).json!.foundCount).toBe(1);
  });

  it("misses when another writer replaces index.json, and still detects torn snapshots", async () => {
    await callTool(root, "kai_find_symbol", { name: "alpha" });
    const meta = registerProject(root);
    const first = loadProjectIndexShared(meta.id);
    expect(first.index).not.toBeNull();
    expect(loadProjectIndexShared(meta.id).cache).toBe("hit");

    // Simulate another process rewriting index.json with different content.
    const rewritten = JSON.parse(JSON.stringify(first.index));
    rewritten.symbolIndex = { renamedElsewhere: rewritten.symbolIndex.alpha };
    fs.writeFileSync(getProjectIndexPath(meta.id), JSON.stringify(rewritten, null, 1));
    const second = loadProjectIndexShared(meta.id);
    expect(second.cache).toBe("miss");
    expect(Object.keys(second.index!.symbolIndex)).toEqual(["renamedElsewhere"]);

    // A torn pairing (meta.json moved on, index.json did not) is caught even on a cache hit.
    expect(loadProjectIndexShared(meta.id).cache).toBe("hit");
    expect(checkPersistenceConsistency(meta.id).consistent).toBe(true);
    const metaPath = getProjectMetaPath(meta.id);
    const m = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    m.snapshotId = "some-other-generation";
    fs.writeFileSync(metaPath, JSON.stringify(m));
    expect(loadProjectIndexShared(meta.id).cache).toBe("hit");
    expect(checkPersistenceConsistency(meta.id).consistent).toBe(false);
  });

  it("hands out frozen objects so callers cannot corrupt the shared copy", async () => {
    await callTool(root, "kai_find_symbol", { name: "alpha" });
    const meta = registerProject(root);
    const { index } = loadProjectIndexShared(meta.id);
    expect(Object.isFrozen(index)).toBe(true);
    expect(Object.isFrozen(index!.files)).toBe(true);
    expect(() => {
      (index!.files as Record<string, unknown>)["injected.ts"] = {};
    }).toThrow(TypeError);
    expect(() => {
      index!.symbolIndex.alpha[0].name = "hacked";
    }).toThrow(TypeError);
  });

  it("never lets one project's data appear in another's results", async () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "kai-cache-other-"));
    try {
      write(other, "src/a.ts", "export function alpha() { return 'other project'; }\n// x\n// y\n");
      const args = { query: "alpha", includeSource: true };
      const mine = await callTool(root, "kai_search_code", args);
      const theirs = await callTool(other, "kai_search_code", args);
      const mineAgain = await callTool(root, "kai_search_code", args);
      expect(mine.text).not.toContain("other project");
      expect(theirs.text).toContain("other project");
      expect(mineAgain.text).not.toContain("other project");
      expect(mineAgain.json!.files[0].contentHash).toBe(mine.json!.files[0].contentHash);
      expect(mineAgain.json!.files[0].contentHash).not.toBe(theirs.json!.files[0].contentHash);
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  it("scans the tree for drift once per graph read, not once per layer", async () => {
    await callTool(root, "kai_get_context", { task: "explain alpha" }); // build + settle
    await callTool(root, "kai_get_context", { task: "explain alpha" });
    const canonical = path.resolve(resolveCanonicalPath(root));
    const spy = vi.spyOn(fs, "readdirSync");
    await callTool(root, "kai_get_context", { task: "explain alpha beta" });
    const rootReads = spy.mock.calls.filter(
      (c) => typeof c[0] === "string" && path.resolve(c[0]) === canonical
    ).length;
    // One drift pass (the freshness gate); the old flow scanned in the handler,
    // again in the gate, and again while assembling the context.
    expect(rootReads).toBe(1);
  });
});

// ---------------------------------------------------------------------------

describe("token accounting is honest", () => {
  let home = "";
  let root = "";
  beforeAll(() => {
    ({ home } = useTempKai());
    process.env.KAI_MCP_MAX_RESPONSE_BYTES = String(64 * 1024);
    root = fs.mkdtempSync(path.join(os.tmpdir(), "kai-tokens-proj-"));
    write(root, "src/a.ts", "export function alpha() { return 1; }\n");
  });
  afterAll(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  });

  function metrics(): Array<Record<string, any>> {
    const p = path.join(home, "metrics.jsonl");
    if (!fs.existsSync(p)) return [];
    return fs
      .readFileSync(p, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  }

  it("records the measured size of the response, flagged as an estimate, not placeholder numbers", async () => {
    for (const [name, args] of [
      ["kai_project_info", {}],
      ["kai_plan_task", { task: "refactor the alpha module and rename helpers" }],
      ["kai_search_code", { query: "alpha" }],
    ] as Array<[string, Record<string, unknown>]>) {
      const before = metrics().length;
      const r = await callTool(root, name, args);
      const rec = metrics()
        .slice(before)
        .find((m) => m.tool === name)!;
      expect(rec, name).toBeDefined();
      expect(rec.tokensAreEstimate).toBe(true);
      expect(rec.tokensEstimated).toBe(estimateTokens(r.text).estimatedTokens);
      expect(rec.responseBytes).toBe(r.bytes);
      expect(rec).not.toHaveProperty("model");
      // Never source, prompts or paths.
      expect(JSON.stringify(rec)).not.toContain("alpha");
      expect(JSON.stringify(rec)).not.toContain(root);
    }
    expect(metrics().some((m) => m.tokensEstimated === 100 || m.tokensEstimated === 200)).toBe(
      false
    );
  });

  it("labels the context metrics as a heuristic estimate, never a cl100k count", async () => {
    const r = await callTool(root, "kai_get_context", { task: "explain alpha" });
    expect(r.text).toContain("Estimate (character heuristic, not a model tokenizer)");
    expect(r.text).not.toContain("cl100k");
    expect(r.text).not.toContain("AST");
    const search = await callTool(root, "kai_search_code", {
      query: "alpha",
      includeSource: false,
    });
    expect(JSON.stringify(search.json)).not.toContain("cl100k");
  });

  it("enforces the byte ceiling on the final serialized prompt and keeps the task verbatim", async () => {
    process.env.KAI_MCP_MAX_RESPONSE_BYTES = String(MIN_MAX_RESPONSE_BYTES);
    try {
      const big = path.join(root, "src", "big.ts");
      const body = Array.from(
        { length: 300 },
        (_, i) => `export const big_value_${i} = "${"x".repeat(60)}";`
      );
      fs.writeFileSync(big, body.join("\n"));
      const task = 'explain big_value with "quotes" and \\ slashes 😀';
      const r = await callTool(root, "kai_get_context", { task, tokenBudget: 20000 });
      expect(r.bytes).toBeLessThanOrEqual(MIN_MAX_RESPONSE_BYTES);
      expect(r.text).toContain(task);
      expect(r.text).toMatch(/budget|limit/i);
    } finally {
      process.env.KAI_MCP_MAX_RESPONSE_BYTES = String(64 * 1024);
    }
  });
});
