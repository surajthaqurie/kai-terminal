import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  registerProject,
  loadProjectIndexShared,
  getIndexCacheStats,
  getProjectIndexPath,
  invalidateIndexCache,
  markProjectGraphStatus,
} from "../core/registry";
import { callTool } from "./helpers/mcpCall";

const prev = { home: process.env.KAI_HOME, ceiling: process.env.KAI_MCP_MAX_RESPONSE_BYTES };

function write(root: string, rel: string, content: string): void {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

let home = "";
const roots: string[] = [];

/** A small project whose only function is `name`, with a body line unique to the project. */
function makeProject(name: string, marker = `BODY_MARKER_${name}`): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `kai-cache-safety-${name}-`));
  roots.push(root);
  write(
    root,
    "src/a.ts",
    `export function ${name}(): number {\n  const note = "${marker}";\n  return note.length;\n}\n`
  );
  return root;
}

async function symbolCount(root: string, name: string): Promise<number> {
  const r = await callTool(root, "kai_find_symbol", { name });
  expect(r.error, r.text).toBeUndefined();
  return r.json!.foundCount as number;
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "kai-cache-safety-home-"));
  process.env.KAI_HOME = home;
  process.env.KAI_MCP_MAX_RESPONSE_BYTES = String(256 * 1024);
  invalidateIndexCache();
});

afterEach(() => {
  invalidateIndexCache();
  fs.rmSync(home, { recursive: true, force: true });
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

describe("index cache: memory is bounded", { timeout: 120_000 }, () => {
  it("never holds more than three projects, keeps the most recent, and evicted ones reload correctly", async () => {
    const names = ["pa", "pb", "pc", "pd", "pe"];
    const projects = names.map((n) => makeProject(n));
    for (let i = 0; i < projects.length; i++) {
      expect(await symbolCount(projects[i], names[i])).toBe(1); // builds, then loads
      expect(await symbolCount(projects[i], names[i])).toBe(1); // shared load
      expect(getIndexCacheStats().entries).toBeLessThanOrEqual(3);
    }
    expect(getIndexCacheStats().entries).toBe(3);

    const before = getIndexCacheStats();
    // The newest project is still cached; the oldest was evicted and must re-parse.
    expect(await symbolCount(projects[4], "pe")).toBe(1);
    expect(getIndexCacheStats().hits - before.hits).toBe(1);
    expect(getIndexCacheStats().misses).toBe(before.misses);
    expect(await symbolCount(projects[0], "pa")).toBe(1);
    expect(getIndexCacheStats().misses - before.misses).toBe(1);
    expect(getIndexCacheStats().entries).toBeLessThanOrEqual(3);
  });
});

describe("index cache: concurrent access", { timeout: 120_000 }, () => {
  it("serves many simultaneous reads of one project from one consistent snapshot", async () => {
    const root = makeProject("alpha");
    await symbolCount(root, "alpha");
    await symbolCount(root, "alpha");
    const meta = registerProject(root);
    const mtime = () => fs.statSync(getProjectIndexPath(meta.id)).mtimeMs;
    const before = mtime();

    const calls = Array.from({ length: 24 }, (_, i) => {
      switch (i % 4) {
        case 0:
          return callTool(root, "kai_find_symbol", { name: "alpha" });
        case 1:
          return callTool(root, "kai_search_code", { query: "alpha" });
        case 2:
          return callTool(root, "kai_get_dependencies", { filePath: "src/a.ts" });
        default:
          return callTool(root, "kai_project_info", {});
      }
    });
    const results = await Promise.all(calls);
    for (const r of results) {
      expect(r.error, r.text).toBeUndefined();
      expect(r.json!.freshness).toBe("fresh");
      expect(r.json!.refreshOutcome ?? "not-required").toBe("not-required");
    }
    expect(results.filter((_, i) => i % 4 === 0).every((r) => r.json!.foundCount === 1)).toBe(true);
    expect(mtime()).toBe(before); // nobody rewrote the index
  });

  it("never mixes two projects when their reads interleave", async () => {
    const a = makeProject("alpha", "MARK_A");
    const b = makeProject("alpha", "MARK_B"); // same symbol name, different content
    await symbolCount(a, "alpha");
    await symbolCount(b, "alpha");

    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        callTool(i % 2 === 0 ? a : b, "kai_search_code", { query: "alpha", includeSource: true })
      )
    );
    const hashesA = new Set<string>();
    const hashesB = new Set<string>();
    results.forEach((r, i) => {
      expect(r.error, r.text).toBeUndefined();
      expect(r.text).toContain(i % 2 === 0 ? "MARK_A" : "MARK_B");
      expect(r.text).not.toContain(i % 2 === 0 ? "MARK_B" : "MARK_A");
      (i % 2 === 0 ? hashesA : hashesB).add(r.json!.files[0].contentHash);
    });
    expect(hashesA.size).toBe(1);
    expect(hashesB.size).toBe(1);
    expect([...hashesA][0]).not.toBe([...hashesB][0]);
  });

  it("returns only the old or the new snapshot while a writer changes the project", async () => {
    const root = makeProject("alpha");
    await symbolCount(root, "alpha");
    await symbolCount(root, "alpha");
    write(root, "src/b.ts", "export function gamma(): number {\n  return 2;\n}\n");

    const results = await Promise.all(
      Array.from({ length: 12 }, () => callTool(root, "kai_find_symbol", { name: "gamma" }))
    );
    for (const r of results) {
      expect(r.error, r.text).toBeUndefined();
      expect([0, 1]).toContain(r.json!.foundCount);
      expect(["fresh", "stale"]).toContain(r.json!.freshness);
    }
    // Once the dust settles every reader sees the new snapshot.
    expect(await symbolCount(root, "gamma")).toBe(1);
    expect(await symbolCount(root, "alpha")).toBe(1);
  });
});

describe("index cache: failures and invalidation", { timeout: 120_000 }, () => {
  it("drops the entry when index.json is corrupted, never reuses it, and recovers on the next read", async () => {
    const root = makeProject("alpha");
    await symbolCount(root, "alpha");
    await symbolCount(root, "alpha");
    const meta = registerProject(root);
    expect(getIndexCacheStats().entries).toBe(1);

    fs.writeFileSync(getProjectIndexPath(meta.id), "{ this is not json");
    const broken = loadProjectIndexShared(meta.id);
    expect(broken.index).toBeNull();
    expect(broken.cache).toBe("miss");
    expect(getIndexCacheStats().entries).toBe(0);

    // The tool layer rebuilds instead of serving a stale or empty answer.
    expect(await symbolCount(root, "alpha")).toBe(1);
    expect(loadProjectIndexShared(meta.id).index).not.toBeNull();
  });

  it("returns nothing, and caches nothing, when index.json is deleted", async () => {
    const root = makeProject("alpha");
    await symbolCount(root, "alpha");
    await symbolCount(root, "alpha");
    const meta = registerProject(root);
    fs.rmSync(getProjectIndexPath(meta.id));
    expect(loadProjectIndexShared(meta.id)).toEqual({ index: null, cache: "miss" });
    expect(getIndexCacheStats().entries).toBe(0);
    expect(await symbolCount(root, "alpha")).toBe(1); // rebuilt on demand
  });

  it("misses after a status change so a stale marker is never hidden by a cached 'ready'", async () => {
    const root = makeProject("alpha");
    await symbolCount(root, "alpha");
    await symbolCount(root, "alpha");
    const meta = registerProject(root);
    expect(loadProjectIndexShared(meta.id).cache).toBe("hit");
    markProjectGraphStatus(meta.id, "stale", "test");
    const after = loadProjectIndexShared(meta.id);
    expect(after.cache).toBe("miss");
    expect(after.index!.meta.status).toBe("stale");
  });

  it("sees a renamed file at its new path only", async () => {
    const root = makeProject("alpha");
    await symbolCount(root, "alpha");
    await symbolCount(root, "alpha");
    fs.renameSync(path.join(root, "src/a.ts"), path.join(root, "src/z.ts"));
    const r = await callTool(root, "kai_find_symbol", { name: "alpha" });
    expect(r.json!.foundCount).toBe(1);
    expect(r.text).toContain("src/z.ts");
    expect(r.text).not.toContain("src/a.ts");
  });

  it("picks up a changed project rules file", async () => {
    const root = makeProject("alpha");
    await symbolCount(root, "alpha");
    await symbolCount(root, "alpha");
    expect((await callTool(root, "kai_project_info", {})).json!.rulesCount).toBe(0);
    write(root, "AGENTS.md", "Always write tests.\n");
    await callTool(root, "kai_search_code", { query: "alpha" }); // graph read: freshness gate
    expect((await callTool(root, "kai_project_info", {})).json!.rulesCount).toBe(1);
  });
});

describe("index cache: isolation and content", { timeout: 120_000 }, () => {
  it("keeps projects apart while the active project switches back and forth", async () => {
    const a = makeProject("alpha", "MARK_A");
    const b = makeProject("beta", "MARK_B");
    // The first read of a project builds its index (which invalidates); the second is the first cached load.
    for (const [root, name] of [
      [a, "alpha"],
      [b, "beta"],
    ]) {
      await symbolCount(root, name);
      await symbolCount(root, name);
    }
    const before = getIndexCacheStats();
    for (let i = 0; i < 3; i++) {
      expect(await symbolCount(a, "alpha")).toBe(1);
      expect(await symbolCount(a, "beta")).toBe(0);
      expect(await symbolCount(b, "beta")).toBe(1);
      expect(await symbolCount(b, "alpha")).toBe(0);
    }
    const after = getIndexCacheStats();
    expect(after.entries).toBe(2);
    expect(after.misses).toBe(before.misses); // switching never forces a re-parse
    expect(after.hits - before.hits).toBe(12);
  });

  it("does not leave one project stale when another is rebuilt", async () => {
    const a = makeProject("alpha", "MARK_A");
    const b = makeProject("beta", "MARK_B");
    await symbolCount(a, "alpha");
    await symbolCount(a, "alpha"); // A is now cached
    await symbolCount(b, "beta");
    write(b, "src/c.ts", "export function delta(): number {\n  return 4;\n}\n");
    expect(await symbolCount(b, "delta")).toBe(1);
    const metaA = registerProject(a);
    const before = getIndexCacheStats();
    expect(loadProjectIndexShared(metaA.id).cache).toBe("hit"); // A's entry survived B's rebuild
    expect(getIndexCacheStats().hits - before.hits).toBe(1);
  });

  it("caches parsed metadata only: function bodies are not in the cached index", async () => {
    const root = makeProject("alpha", "UNIQUE_BODY_TEXT_9731");
    await symbolCount(root, "alpha");
    await symbolCount(root, "alpha");
    const meta = registerProject(root);
    const cached = loadProjectIndexShared(meta.id).index!;
    expect(JSON.stringify(cached)).not.toContain("UNIQUE_BODY_TEXT_9731");
  });
});

afterAll(() => {
  if (prev.home === undefined) delete process.env.KAI_HOME;
  else process.env.KAI_HOME = prev.home;
  if (prev.ceiling === undefined) delete process.env.KAI_MCP_MAX_RESPONSE_BYTES;
  else process.env.KAI_MCP_MAX_RESPONSE_BYTES = prev.ceiling;
});
