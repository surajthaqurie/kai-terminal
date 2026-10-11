import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { indexProject, isSensitiveContent, matchesIgnorePattern } from "../core/indexer";
import { registerProject, loadProjectIndex } from "../core/registry";
import { retrieveContext } from "../core/retrieval";
import { handleMcpMessage } from "../core/mcp";

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
    expect(isSensitiveContent("-----BEGIN RSA PRIVATE KEY-----\nabc")).toBe(true);
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
});
