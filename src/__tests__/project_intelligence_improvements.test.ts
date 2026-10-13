import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import {
  registerProject,
  getProjectMeta,
  getProjectIndexPath,
  getProjectMetaPath,
  getProjectLockPath,
  loadProjectIndex,
  ProjectLock,
  computeProjectId,
  normalizePathForIdentity,
  isWithinProjectBoundary,
} from "../core/registry";
import {
  indexProject,
  detectStaleIndexEntries,
  matchesIgnorePattern,
  loadIgnorePatterns,
  isBinaryFile,
  extractSymbolsAndDeps,
} from "../core/indexer";
import { retrieveContext } from "../core/retrieval";
import { assembleContext } from "../core/contextAssembler";
import { queryLspCrossFileReferences } from "../core/lspBridge";
import { handleMcpMessage } from "../core/mcp";

describe("Project Intelligence Comprehensive Improvements", () => {
  let tmpDir: string;
  let savedKaiHome: string | undefined;

  beforeEach(() => {
    savedKaiHome = process.env.KAI_HOME;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-intel-test-"));
    process.env.KAI_HOME = path.join(tmpDir, "kai_home");
  });

  afterEach(() => {
    if (savedKaiHome === undefined) delete process.env.KAI_HOME;
    else process.env.KAI_HOME = savedKaiHome;
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  function makeProject(files: Record<string, string>): string {
    const projDir = path.join(tmpDir, "repo_" + Math.random().toString(36).slice(2));
    fs.mkdirSync(projDir, { recursive: true });
    for (const [relPath, content] of Object.entries(files)) {
      const full = path.join(projDir, relPath);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content, "utf-8");
    }
    return projDir;
  }

  describe("1. Incremental updates and determinism", () => {
    it("detects added and modified files while preserving unchanged cached files", async () => {
      const repo = makeProject({
        "src/a.ts": "export function funcA() { return 'A'; }",
        "src/b.ts": "export function funcB() { return 'B'; }",
      });
      const meta = registerProject(repo);
      const index1 = await indexProject(meta);

      expect(index1.changes?.added.sort()).toEqual(["src/a.ts", "src/b.ts"]);
      expect(index1.changes?.modified).toEqual([]);
      expect(index1.changes?.deleted).toEqual([]);

      // Modify a.ts and add c.ts
      fs.appendFileSync(path.join(repo, "src", "a.ts"), "\nexport const extra = 1;");
      fs.writeFileSync(path.join(repo, "src", "c.ts"), "export const c = 3;");

      const index2 = await indexProject(meta);
      expect(index2.changes?.added).toEqual(["src/c.ts"]);
      expect(index2.changes?.modified).toEqual(["src/a.ts"]);
      expect(index2.changes?.deleted).toEqual([]);

      // File b.ts should be reused deterministically from cache
      expect(index2.files["src/b.ts"].sha256).toBe(index1.files["src/b.ts"].sha256);
      expect(index2.files["src/b.ts"].mtimeMs).toBe(index1.files["src/b.ts"].mtimeMs);
    });
  });

  describe("2. Deletions and Renames", () => {
    it("detects deleted files and removes them from the index and symbols", async () => {
      const repo = makeProject({
        "src/x.ts": "export function funcX() { return 'X'; }",
        "src/y.ts": "export function funcY() { return 'Y'; }",
      });
      const meta = registerProject(repo);
      await indexProject(meta);

      // Delete x.ts
      fs.unlinkSync(path.join(repo, "src", "x.ts"));

      const index2 = await indexProject(meta);
      expect(index2.changes?.deleted).toEqual(["src/x.ts"]);
      expect(index2.files["src/x.ts"]).toBeUndefined();
      expect(index2.symbolIndex["funcX"]).toBeUndefined();
      expect(index2.symbolIndex["funcY"]).toBeDefined();
    });

    it("detects renamed files correctly when content sha256 matches", async () => {
      const content = "export function uniqueComputation() { return 42; }";
      const repo = makeProject({
        "src/old_name.ts": content,
      });
      const meta = registerProject(repo);
      await indexProject(meta);

      // Rename old_name.ts -> new_name.ts
      fs.unlinkSync(path.join(repo, "src", "old_name.ts"));
      fs.writeFileSync(path.join(repo, "src", "new_name.ts"), content);

      const index2 = await indexProject(meta);
      expect(index2.changes?.renamed).toEqual([{ from: "src/old_name.ts", to: "src/new_name.ts" }]);
      expect(index2.changes?.deleted).toEqual([]);
      expect(index2.changes?.added).toEqual([]);
      expect(index2.files["src/new_name.ts"]).toBeDefined();
      expect(index2.files["src/old_name.ts"]).toBeUndefined();
    });
  });

  describe("3. Stale Snapshots Detection", () => {
    it("detects external modifications and deletions via detectStaleIndexEntries", async () => {
      const repo = makeProject({
        "src/mod.ts": "export const val = 1;",
        "src/del.ts": "export const del = 2;",
        "src/keep.ts": "export const keep = 3;",
      });
      const meta = registerProject(repo);
      const index = await indexProject(meta);

      const checkFresh = detectStaleIndexEntries(index);
      expect(checkFresh.isStale).toBe(false);

      // External file modification
      fs.writeFileSync(path.join(repo, "src", "mod.ts"), "export const val = 999;");
      // External file deletion
      fs.unlinkSync(path.join(repo, "src", "del.ts"));

      const checkStale = detectStaleIndexEntries(index);
      expect(checkStale.isStale).toBe(true);
      expect(checkStale.staleFiles).toContain("src/mod.ts");
      expect(checkStale.deletedFiles).toContain("src/del.ts");
    });

    it("flags indexFreshness as stale in contextAssembler when files are modified externally", async () => {
      const repo = makeProject({
        "src/service.ts": "export class MainService {}",
      });
      const meta = registerProject(repo);
      const index = await indexProject(meta);

      // External change
      fs.writeFileSync(
        path.join(repo, "src", "service.ts"),
        "export class MainService { id = 1; }"
      );

      const { contextPackage } = assembleContext(index, { task: "explain MainService" });
      expect(contextPackage.projectMeta.indexFreshness).toBe("stale");
      expect(contextPackage.knownLimitations.some((k) => k.includes("modified on disk"))).toBe(
        true
      );
    });

    it("flags missing deleted files as stale during retrieval rather than silently ignoring", async () => {
      const repo = makeProject({
        "src/target.ts": "export function targetFn() { return true; }",
      });
      const meta = registerProject(repo);
      const index = await indexProject(meta);

      // Delete target.ts on disk
      fs.unlinkSync(path.join(repo, "src", "target.ts"));

      const retrieved = retrieveContext(index, "targetFn");
      expect(retrieved.staleFiles).toContain("src/target.ts");
      expect(
        retrieved.omissions.some((o) => o.identifier === "src/target.ts" && o.reason === "stale")
      ).toBe(true);
    });
  });

  describe("4. Corrupt Indexes and Metadata Recovery", () => {
    it("recovers safely from a corrupted index.json by performing a clean rebuild", async () => {
      const repo = makeProject({
        "src/index.ts": "export const ok = true;",
      });
      const meta = registerProject(repo);
      await indexProject(meta);

      // Corrupt index.json
      const indexPath = getProjectIndexPath(meta.id);
      fs.writeFileSync(indexPath, "{ corrupted json syntax invalid", "utf-8");

      expect(loadProjectIndex(meta.id)).toBeNull();

      // Re-indexing recovers cleanly
      const recovered = await indexProject(meta);
      expect(recovered).toBeDefined();
      expect(recovered.files["src/index.ts"]).toBeDefined();
    });

    it("recovers safely from a corrupted meta.json in registerProject and getProjectMeta", async () => {
      const repo = makeProject({
        "src/index.ts": "export const ok = true;",
      });
      const meta = registerProject(repo);
      const metaPath = getProjectMetaPath(meta.id);

      // Write invalid meta
      fs.writeFileSync(metaPath, "{ not a valid project meta }", "utf-8");
      expect(getProjectMeta(meta.id)).toBeNull();

      // Re-registering heals the corrupted meta.json
      const healed = registerProject(repo);
      expect(healed.id).toBe(meta.id);
      expect(healed.status).toBe("unindexed");
    });

    it("recovers safely from an unparseable or empty .lock file", () => {
      const projectId = "abcdef0123456789";
      const lockPath = getProjectLockPath(projectId);
      fs.mkdirSync(path.dirname(lockPath), { recursive: true });
      fs.writeFileSync(lockPath, "corrupt partial lock data", "utf-8");

      const lock = new ProjectLock(projectId);
      const acquired = lock.acquire(1000);
      expect(acquired).toBe(true);
      lock.release();
    });

    it("recovers from an interrupted indexing status", async () => {
      const repo = makeProject({
        "src/index.ts": "export const ok = true;",
      });
      const meta = registerProject(repo);
      const metaPath = getProjectMetaPath(meta.id);

      // Simulate interrupted indexing
      meta.status = "indexing";
      fs.writeFileSync(metaPath, JSON.stringify(meta), "utf-8");

      const reRegistered = registerProject(repo);
      expect(reRegistered.status).not.toBe("indexing");

      const index = await indexProject(reRegistered);
      expect(index.meta.status).toBe("ready");
    });
  });

  describe("5. Symlinks and Project Boundary Enforcement", () => {
    it("indexes files linked via internal symlinks inside project boundary", async () => {
      const repo = makeProject({
        "src/real.ts": "export function realSymbol() {}",
      });
      // Internal symlink: src/link.ts -> src/real.ts
      fs.symlinkSync(path.join(repo, "src", "real.ts"), path.join(repo, "src", "link.ts"));

      const meta = registerProject(repo);
      const index = await indexProject(meta);

      expect(index.files["src/link.ts"]).toBeDefined();
      expect(index.files["src/real.ts"]).toBeDefined();
      expect(index.symbolIndex["realSymbol"]).toBeDefined();
    });

    it("rejects symlinks that point outside the project boundary", async () => {
      const outsideDir = path.join(tmpDir, "outside_secret");
      fs.mkdirSync(outsideDir, { recursive: true });
      fs.writeFileSync(path.join(outsideDir, "secret.ts"), "export const SECRET = 123;");

      const repo = makeProject({
        "src/app.ts": "export const app = true;",
      });
      // Symlink to outside file
      fs.symlinkSync(path.join(outsideDir, "secret.ts"), path.join(repo, "src", "sym_secret.ts"));

      const meta = registerProject(repo);
      const index = await indexProject(meta);

      expect(index.files["src/sym_secret.ts"]).toBeUndefined();
      expect(index.files["src/app.ts"]).toBeDefined();
    });

    it("handles circular directory symlinks safely without infinite recursion", async () => {
      const repo = makeProject({
        "src/main.ts": "export const main = 1;",
      });
      // Symlink pointing back to root or parent: src/cycle -> repo
      fs.symlinkSync(repo, path.join(repo, "src", "cycle"));

      const meta = registerProject(repo);
      const index = await indexProject(meta);

      expect(index.files["src/main.ts"]).toBeDefined();
      expect(Object.keys(index.files).length).toBe(1);
    });

    it("enforces boundary checks on ignore and rules files", () => {
      const outsideDir = path.join(tmpDir, "outside_rules");
      fs.mkdirSync(outsideDir, { recursive: true });
      fs.writeFileSync(path.join(outsideDir, "evil.md"), "malicious rules");

      const repo = makeProject({});
      // Symlink AGENTS.md pointing outside
      fs.symlinkSync(path.join(outsideDir, "evil.md"), path.join(repo, "AGENTS.md"));

      const meta = registerProject(repo);
      expect(
        isWithinProjectBoundary(fs.realpathSync(path.join(repo, "AGENTS.md")), meta.canonicalPath)
      ).toBe(false);
    });
  });

  describe("6. Ignore rules and Exclusions", () => {
    it("respects both .gitignore and .ignore files", () => {
      const repo = makeProject({
        ".gitignore": "ignored_by_git.ts\n",
        ".ignore": "ignored_by_ignore.ts\n",
      });

      const patterns = loadIgnorePatterns(repo);
      expect(patterns).toContain("ignored_by_git.ts");
      expect(patterns).toContain("ignored_by_ignore.ts");

      expect(matchesIgnorePattern("src/ignored_by_git.ts", "ignored_by_git.ts", patterns)).toBe(
        true
      );
      expect(
        matchesIgnorePattern("src/ignored_by_ignore.ts", "ignored_by_ignore.ts", patterns)
      ).toBe(true);
      expect(matchesIgnorePattern("src/valid.ts", "valid.ts", patterns)).toBe(false);
    });

    it("matches directory patterns across subpaths", () => {
      const patterns = ["dist", "build/*", "*.tmp"];
      expect(matchesIgnorePattern("packages/pkg1/dist/bundle.js", "bundle.js", patterns)).toBe(
        true
      );
      expect(matchesIgnorePattern("dist/bundle.js", "bundle.js", patterns)).toBe(true);
      expect(matchesIgnorePattern("build/output.js", "output.js", patterns)).toBe(true);
      expect(matchesIgnorePattern("src/test.tmp", "test.tmp", patterns)).toBe(true);
      expect(matchesIgnorePattern("src/distrib/main.ts", "main.ts", patterns)).toBe(false);
    });
  });

  describe("7. Unreadable, binary, oversized, and malformed files", () => {
    it("detects compiled binary formats by extension and signature", () => {
      expect(isBinaryFile("module.wasm")).toBe(true);
      expect(isBinaryFile("bytecode.pyc")).toBe(true);
      expect(isBinaryFile("native.node")).toBe(true);
      expect(isBinaryFile("package.jar")).toBe(true);

      const bufferWithNulls = Buffer.from([0x68, 0x65, 0x00, 0x6c, 0x6f]);
      expect(isBinaryFile("unknown_extension", bufferWithNulls)).toBe(true);

      const textBuffer = Buffer.from("export const a = 1;\n");
      expect(isBinaryFile("code.ts", textBuffer)).toBe(false);
    });

    it("safely skips lines longer than 2048 characters to prevent regex backtracking", () => {
      const giantLine = "const minified = " + "x".repeat(5000) + ";";
      const normalLine = "export function safeFn() {}";
      const content = `${giantLine}\n${normalLine}`;

      const { symbols } = extractSymbolsAndDeps(content, "bundle.js", "javascript");
      expect(symbols.length).toBe(1);
      expect(symbols[0].name).toBe("safeFn");
    });
  });

  describe("8. Project Identity & Path Equivalences", () => {
    it("computes matching project identity for equivalent paths with trailing slashes", () => {
      const repo = makeProject({});
      const id1 = computeProjectId(repo);
      const id2 = computeProjectId(repo + path.sep);
      const id3 = computeProjectId(repo + "///");

      expect(id1).toBe(id2);
      expect(id1).toBe(id3);
    });

    it("normalizes path identity consistently", () => {
      const norm1 = normalizePathForIdentity("/a/b/c/");
      const norm2 = normalizePathForIdentity("/a/b/c");
      expect(norm1).toBe(norm2);

      const normVerbatim = normalizePathForIdentity("\\\\?\\C:\\repo\\project\\");
      expect(normVerbatim.startsWith("\\\\?\\")).toBe(false);
    });
  });

  describe("9. Degraded-Mode LSP Reporting", () => {
    it("reports degradedMode with actionable install instructions when no language server is found", async () => {
      const result = await queryLspCrossFileReferences(tmpDir, "missing.rs", 1, 1, "MyStruct", 500);
      if (!result.isAvailable) {
        expect(result.degradedMode).toBe(true);
        expect(result.degradedReason).toBeDefined();
        expect(result.degradedReason).toContain("degraded mode");
      }
    });

    it("MCP kai_get_lsp_status reports degradedMode status clearly", async () => {
      const res = await handleMcpMessage(
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "kai_get_lsp_status" },
        },
        tmpDir
      );

      expect(res?.result).toBeDefined();
      const text = (res?.result as { content: Array<{ text: string }> }).content[0].text;
      const parsed = JSON.parse(text);
      expect(typeof parsed.lspBridgeAvailable).toBe("boolean");
      expect(typeof parsed.degradedMode).toBe("boolean");
      if (parsed.degradedMode) {
        expect(parsed.degradedReason).toBeDefined();
      }
    });
  });
});
