import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { indexProject, isSensitiveContent, matchesIgnorePattern } from "../core/indexer";
import { registerProject, loadProjectIndex } from "../core/registry";
import { retrieveContext } from "../core/retrieval";
import { handleMcpMessage } from "../core/mcp";

let savedKaiHome: string | undefined;
let isolatedKaiHome: string;

beforeEach(() => {
  savedKaiHome = process.env.KAI_HOME;
  isolatedKaiHome = fs.mkdtempSync(path.join(os.tmpdir(), "kai-home-"));
  process.env.KAI_HOME = isolatedKaiHome;
});

afterEach(() => {
  if (savedKaiHome === undefined) delete process.env.KAI_HOME;
  else process.env.KAI_HOME = savedKaiHome;
  fs.rmSync(isolatedKaiHome, { recursive: true, force: true });
});

function makeTempProject(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-audit-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

describe("audit regression: indexer security & correctness", () => {
  it("excludes file content containing high-confidence secrets", () => {
    expect(isSensitiveContent("const x = 1;")).toBe(false);
    expect(isSensitiveContent("AKIAIOSFODNN7EXAMPLE plus more")).toBe(true);
    const testRsaKey = ["-----", "BEGIN ", "RSA ", "PRIVATE KEY-----", "\nabc"].join("");
    expect(isSensitiveContent(testRsaKey)).toBe(true);
    expect(isSensitiveContent("token = ghp_abcdefghijklmnopqrstuvwxyz123456")).toBe(true);
  });

  it("does not treat package-lock.json as binary and indexes it", async () => {
    const dir = makeTempProject({ "package-lock.json": '{"name":"x"}\n' });
    const meta = registerProject(dir);
    const index = await indexProject(meta, { forceRebuild: true });
    expect(index.files["package-lock.json"]).toBeDefined();
  });

  it("honors .gitignore globs like *.log", async () => {
    const dir = makeTempProject({
      ".gitignore": "*.log\n",
      "debug.log": "noise\n",
      "src/a.ts": "export function a() {}\n",
    });
    const meta = registerProject(dir);
    const index = await indexProject(meta, { forceRebuild: true });
    expect(index.files["debug.log"]).toBeUndefined();
    expect(index.files["src/a.ts"]).toBeDefined();
    expect(matchesIgnorePattern("debug.log", "debug.log", ["*.log"])).toBe(true);
  });

  it("extracts Go symbols and dependencies", async () => {
    const dir = makeTempProject({
      "main.go": 'package main\nimport "fmt"\nfunc ServerMain() {}\ntype Server struct{}\n',
    });
    const meta = registerProject(dir);
    const index = await indexProject(meta, { forceRebuild: true });
    const names = Object.keys(index.symbolIndex);
    expect(names).toContain("ServerMain");
    expect(names).toContain("Server");
  });

  it("extracts symbols from CRLF (Windows) line endings", async () => {
    const dir = makeTempProject({
      "src/a.ts": "export function crlfFn() {\r\n  return 1;\r\n}\r\nexport class CrlfCls {}\r\n",
    });
    const meta = registerProject(dir);
    const index = await indexProject(meta, { forceRebuild: true });
    const names = Object.keys(index.symbolIndex);
    expect(names).toContain("crlfFn");
    expect(names).toContain("CrlfCls");
    const res = retrieveContext(index, "crlfFn", { tokenBudget: 4000, fileBudget: 5 });
    expect(res.matchedFiles.map((m) => m.file.relativePath)).toContain("src/a.ts");
  });

  it("estimates total tokens from file sizes, not path strings", async () => {
    const dir = makeTempProject({ "src/big.ts": "x".repeat(4000) + "\n" });
    const meta = registerProject(dir);
    const index = await indexProject(meta, { forceRebuild: true });
    // 4001 bytes -> ~1001 tokens; path-based bug would give <10
    expect(index.totalTokensEstimated).toBeGreaterThan(500);
  });

  it("skips symlinks escaping the project root", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "kai-outside-"));
    fs.writeFileSync(path.join(outside, "s.txt"), "outside-secret\n");
    const dir = makeTempProject({ "src/a.ts": "export function a() {}\n" });
    try {
      fs.symlinkSync(path.join(outside, "s.txt"), path.join(dir, "src", "evil-link"));
    } catch {
      return; // symlink creation unavailable; skip
    }
    const meta = registerProject(dir);
    const index = await indexProject(meta, { forceRebuild: true });
    expect(index.files["src/evil-link"]).toBeUndefined();
  });
});

describe("audit regression: retrieval confinement", () => {
  it("refuses path traversal via a crafted index entry", () => {
    const dir = makeTempProject({ "src/a.ts": "export function a() {}\n" });
    const meta = registerProject(dir);
    const base: ReturnType<typeof loadProjectIndex> = loadProjectIndex(meta.id) as never;
    void base;
    // Build a minimal malicious index pointing outside the root
    const evilIndex = {
      meta: { ...meta, canonicalPath: dir },
      files: {
        "../../evil": {
          relativePath: "../../evil",
          canonicalPath: "/etc/hostname",
          sizeBytes: 10,
          mtimeMs: 0,
          sha256: "x",
          language: "text",
          symbols: [],
          dependencies: [],
          isTest: false,
          isConfig: false,
          isDoc: false,
        },
      },
      symbolIndex: {},
      rules: [],
      totalTokensEstimated: 0,
      generatedAt: new Date().toISOString(),
    } as never;
    // Query tokens unlikely to match; force a candidate via symbol table instead
    const withSym = JSON.parse(JSON.stringify(evilIndex));
    withSym.symbolIndex = {
      evil: [
        {
          name: "evil",
          kind: "function",
          filePath: "../../evil",
          location: { filePath: "../../evil", line: 1, column: 1 },
          isExported: true,
        },
      ],
    };
    const res = retrieveContext(withSym, "evil", { tokenBudget: 4000, fileBudget: 5 });
    expect(res.matchedFiles.length).toBe(0);
    expect(res.omissions.some((o) => o.reason === "untrusted")).toBe(true);
  });

  it("packs smaller files after an over-budget file instead of stopping", () => {
    const big = "y\n".repeat(3000);
    const dir = makeTempProject({
      "src/bigmatch.ts": `export function matchme() {}\n${big}`,
      "src/smallmatch.ts": `export function matchme() {}\nshort\n`,
    });
    return (async () => {
      const meta = registerProject(dir);
      const index = await indexProject(meta, { forceRebuild: true });
      const res = retrieveContext(index, "matchme", { tokenBudget: 400, fileBudget: 5 });
      const paths = res.matchedFiles.map((m) => m.file.relativePath);
      expect(paths).toContain("src/smallmatch.ts");
    })();
  });

  it("recalls single-character symbols via short-query fallback", async () => {
    const dir = makeTempProject({ "src/c.ts": "export function c() { return 1; }\n" });
    const meta = registerProject(dir);
    const index = await indexProject(meta, { forceRebuild: true });
    const res = retrieveContext(index, "c", { tokenBudget: 4000, fileBudget: 5 });
    expect(res.matchedFiles.map((m) => m.file.relativePath)).toContain("src/c.ts");
  });

  it("treats non-finite file budgets as the default", async () => {
    const dir = makeTempProject({ "src/a.ts": "export function alpha() {}\n" });
    const meta = registerProject(dir);
    const index = await indexProject(meta, { forceRebuild: true });
    const res = retrieveContext(index, "alpha", { tokenBudget: 4000, fileBudget: NaN });
    expect(res.matchedFiles.length).toBeLessThanOrEqual(20);
    expect(res.matchedFiles.length).toBeGreaterThan(0);
  });
});

describe("audit regression: MCP validation", () => {
  it("rejects absolute and traversal filePath values", async () => {
    const dir = makeTempProject({ "src/a.ts": "export function a() {}\n" });
    const abs = await handleMcpMessage(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "kai_get_dependencies",
          arguments: { filePath: "/etc/passwd", projectPath: dir },
        },
      },
      dir
    );
    expect(abs?.error?.code).toBe(-32602);
    const trav = await handleMcpMessage(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "kai_get_dependencies",
          arguments: { filePath: "../../etc/passwd", projectPath: dir },
        },
      },
      dir
    );
    expect(trav?.error?.code).toBe(-32602);
  });

  it("clamps tokenBudget and ignores invalid categoryOverride", async () => {
    const dir = makeTempProject({ "src/a.ts": "export function a() {}\n" });
    const res = await handleMcpMessage(
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "kai_get_context",
          arguments: {
            task: "explain a",
            projectPath: dir,
            tokenBudget: -500,
            categoryOverride: "rm -rf",
          },
        },
      },
      dir
    );
    expect(res?.error).toBeUndefined();
    expect(JSON.stringify(res?.result)).toContain("Kai Project Context");
  });

  it("returns a directory error for file projectPath without leaking internals", async () => {
    const dir = makeTempProject({ "f.txt": "hi\n" });
    const file = path.join(dir, "f.txt");
    const res = await handleMcpMessage(
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "kai_project_info", arguments: { projectPath: file } },
      },
      dir
    );
    expect(res?.error?.code).toBe(-32602);
    expect(String(res?.error?.message)).not.toContain(file);
  });

  it("rejects unknown tools without registering or indexing anything", async () => {
    const dir = makeTempProject({ "src/a.ts": "export function a() {}\n" });
    const { computeProjectId } = await import("../core/registry");
    const { resolveCanonicalPath, getProjectStorageDir } = await import("../core/registry");
    const id = computeProjectId(resolveCanonicalPath(dir));
    const res = await handleMcpMessage(
      {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "no_such_tool", arguments: { projectPath: dir } },
      },
      dir
    );
    expect(res?.error?.code).toBe(-32601);
    expect(fs.existsSync(getProjectStorageDir(id))).toBe(false);
  });

  it("safely indexes and looks up symbols named after Object.prototype properties", async () => {
    const dir = makeTempProject({
      "src/props.ts": [
        "export function toString() { return 'str'; }",
        "export function valueOf() { return 1; }",
        "export class ConstructorHandler { constructor() {} }",
      ].join("\n"),
    });
    const meta = registerProject(dir);
    const index = await indexProject(meta, { forceRebuild: true });
    expect(index.meta.status).toBe("ready");
    expect(Object.keys(index.symbolIndex)).toContain("toString");
    expect(Object.keys(index.symbolIndex)).toContain("valueOf");

    // MCP kai_find_symbol for prototype property name
    const res = await handleMcpMessage(
      {
        jsonrpc: "2.0",
        id: 10,
        method: "tools/call",
        params: {
          name: "kai_find_symbol",
          arguments: { name: "toString", projectPath: dir },
        },
      },
      dir
    );
    expect(res?.error).toBeUndefined();
    const resultObj = JSON.parse(
      (res?.result as { content: Array<{ text: string }> }).content[0].text
    );
    expect(resultObj.symbolName).toBe("toString");
    expect(resultObj.foundCount).toBe(1);

    // MCP kai_get_dependencies for prototype property name
    const depRes = await handleMcpMessage(
      {
        jsonrpc: "2.0",
        id: 11,
        method: "tools/call",
        params: {
          name: "kai_get_dependencies",
          arguments: { filePath: "toString", projectPath: dir },
        },
      },
      dir
    );
    expect(depRes?.error?.code).toBe(-32602);
  });

  it("rejects null bytes in projectPath and filePath", async () => {
    const dir = makeTempProject({ "src/a.ts": "export function a() {}\n" });
    const nullPathRes = await handleMcpMessage(
      {
        jsonrpc: "2.0",
        id: 12,
        method: "tools/call",
        params: {
          name: "kai_project_info",
          arguments: { projectPath: dir + "\0bad" },
        },
      },
      dir
    );
    expect(nullPathRes?.error?.code).toBe(-32602);
    expect(nullPathRes?.error?.message).toContain("null bytes");

    const nullFileRes = await handleMcpMessage(
      {
        jsonrpc: "2.0",
        id: 13,
        method: "tools/call",
        params: {
          name: "kai_get_dependencies",
          arguments: { filePath: "src/a.ts\0bad", projectPath: dir },
        },
      },
      dir
    );
    expect(nullFileRes?.error?.code).toBe(-32602);
  });

  it("detects same-size content modifications during retrieval and flags stale context", async () => {
    const dir = makeTempProject({
      "src/config.ts": "export const mode = 'dev';\n", // 28 chars
    });
    const meta = registerProject(dir);
    const index = await indexProject(meta);
    const originalHash = index.files["src/config.ts"].sha256;
    expect(originalHash).toBeDefined();

    // Mutate content with identical byte length and restore timestamp
    const fullPath = path.join(dir, "src", "config.ts");
    const stat1 = fs.statSync(fullPath);
    fs.writeFileSync(fullPath, "export const mode = 'prd';\n"); // identical 28 chars
    fs.utimesSync(fullPath, stat1.atime, stat1.mtime); // preserve mtime

    const { assembleContext } = await import("../core/contextAssembler");
    const { contextPackage, renderedPrompt } = assembleContext(index, {
      task: "explain mode configuration",
      tokenBudget: 4000,
    });

    // Verify that retrieval read the live disk content (not the old content)
    expect(renderedPrompt).toContain("export const mode = 'prd';");
    // Verify that staleness was actively detected by sha256 mismatch
    expect(contextPackage.projectMeta.indexFreshness).toBe("stale");
    expect(contextPackage.knownLimitations.some((k) => k.includes("modified on disk"))).toBe(true);
  });
});
