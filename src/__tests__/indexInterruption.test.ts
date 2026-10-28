import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  registerProject,
  loadProjectIndexShared,
  getIndexCacheStats,
  getProjectIndexPath,
  getProjectStorageDir,
  invalidateIndexCache,
} from "../core/registry";
import { callTool } from "./helpers/mcpCall";

const prev = { home: process.env.KAI_HOME, ceiling: process.env.KAI_MCP_MAX_RESPONSE_BYTES };

let home = "";
let root = "";

function write(rel: string, content: string): void {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

async function found(name: string): Promise<number> {
  const r = await callTool(root, "kai_find_symbol", { name });
  expect(r.error, r.text).toBeUndefined();
  return r.json!.foundCount as number;
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "kai-interrupt-home-"));
  root = fs.mkdtempSync(path.join(os.tmpdir(), "kai-interrupt-proj-"));
  process.env.KAI_HOME = home;
  process.env.KAI_MCP_MAX_RESPONSE_BYTES = String(256 * 1024);
  invalidateIndexCache();
  write("src/a.ts", "export function alpha(): number {\n  return 1;\n}\n");
});

afterEach(() => {
  vi.restoreAllMocks();
  invalidateIndexCache();
  if (prev.home === undefined) delete process.env.KAI_HOME;
  else process.env.KAI_HOME = prev.home;
  if (prev.ceiling === undefined) delete process.env.KAI_MCP_MAX_RESPONSE_BYTES;
  else process.env.KAI_MCP_MAX_RESPONSE_BYTES = prev.ceiling;
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
});

describe("interrupted and failed index writes", { timeout: 60_000 }, () => {
  it("never reads a half-written temp file left by an interrupted save", async () => {
    expect(await found("alpha")).toBe(1);
    const meta = registerProject(root);
    const dir = getProjectStorageDir(meta.id);
    // What an interrupted atomicWriteJson leaves behind: a truncated temp copy.
    const partial = path.join(dir, `index.json.${Date.now()}.abc123.tmp`);
    fs.writeFileSync(partial, '{"meta":{"id":"');
    const before = fs.readFileSync(getProjectIndexPath(meta.id), "utf-8");

    expect(await found("alpha")).toBe(1);
    expect(loadProjectIndexShared(meta.id).index).not.toBeNull();
    expect(fs.readFileSync(getProjectIndexPath(meta.id), "utf-8")).toBe(before);
  });

  it("keeps serving the last complete snapshot when a save fails, and leaves no temp file", async () => {
    expect(await found("alpha")).toBe(1);
    const meta = registerProject(root);
    const indexPath = getProjectIndexPath(meta.id);
    const before = fs.readFileSync(indexPath, "utf-8");

    write("src/b.ts", "export function beta(): number {\n  return 2;\n}\n");
    const realRename = fs.renameSync;
    const spy = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(to).endsWith("index.json")) {
        throw Object.assign(new Error("EIO: simulated write failure"), { code: "EIO" });
      }
      return realRename(from, to);
    });

    // The refresh cannot be saved. The request must not crash the server and must
    // not claim the new file is indexed.
    const during = await callTool(root, "kai_find_symbol", { name: "beta" });
    expect(during.res).toBeDefined();
    expect(during.json?.foundCount ?? 0).toBe(0);
    // The injected failure really fired (the save was attempted and refused).
    expect(spy.mock.calls.some(([, to]) => String(to).endsWith("index.json"))).toBe(true);
    expect(fs.readFileSync(indexPath, "utf-8")).toBe(before); // old snapshot intact
    expect(fs.readdirSync(getProjectStorageDir(meta.id)).filter((f) => f.endsWith(".tmp"))).toEqual(
      []
    );
    // Whatever the cache holds is still the complete old snapshot, never a mix.
    const cached = loadProjectIndexShared(meta.id).index;
    expect(cached && Object.keys(cached.symbolIndex)).toEqual(["alpha"]);

    spy.mockRestore();
    // Once writes work again the next request refreshes and sees the file.
    expect(await found("beta")).toBe(1);
    expect(await found("alpha")).toBe(1);
  });

  it("does not serve a project from the cache after its storage is removed", async () => {
    expect(await found("alpha")).toBe(1);
    const meta = registerProject(root);
    loadProjectIndexShared(meta.id); // populate
    expect(loadProjectIndexShared(meta.id).cache).toBe("hit");
    const entriesBefore = getIndexCacheStats().entries;

    fs.rmSync(getProjectStorageDir(meta.id), { recursive: true, force: true });

    expect(loadProjectIndexShared(meta.id)).toEqual({ index: null, cache: "miss" });
    expect(getIndexCacheStats().entries).toBe(entriesBefore - 1);
  });
});
