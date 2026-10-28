import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { registerProject, resolveCanonicalPath, ProjectLock } from "../core/registry";
import { indexProject } from "../core/indexer";
import { readIndexedSource } from "../core/retrieval";
import { toolReadRange, type ToolContext } from "../core/mcpTools";
import { callTool } from "./helpers/mcpCall";
import type { ProjectIndex } from "../core/types";

let home = "";
let root = "";
let outside = "";
const prev = { home: process.env.KAI_HOME, ceiling: process.env.KAI_MCP_MAX_RESPONSE_BYTES };

// Assembled at runtime so this file does not itself look like a credential.
const FAKE_AWS_KEY = "AKIA" + "B".repeat(16);

function write(rel: string, content: string): void {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

const A_TS = [
  "export function alpha(x: number): number {", // 1
  "  const doubled = x * 2;", // 2
  "  return doubled;", // 3
  "}", // 4
  "", // 5
  "export function beta(", // 6
  "  a: string,", // 7
  "  b: string,", // 8
  "): string {", // 9
  "  return a + b;", // 10
  "}", // 11
  "", // 12
].join("\n");

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "kai-range-home-"));
  root = fs.mkdtempSync(path.join(os.tmpdir(), "kai-range-proj-"));
  outside = fs.mkdtempSync(path.join(os.tmpdir(), "kai-range-outside-"));
  process.env.KAI_HOME = home;
  delete process.env.KAI_MCP_MAX_RESPONSE_BYTES;
  write("src/a.ts", A_TS);
  write(
    "src/classes.ts",
    [
      "export class Svc {", // 1
      "  run(): number {", // 2
      "    return 1;", // 3
      "  }", // 4
      "}", // 5
      "export class Other {", // 6
      "  run(): number {", // 7
      "    return 2;", // 8
      "  }", // 9
      "}", // 10
    ].join("\n")
  );
  write("src/dup1.ts", "export function shared() { return 1; }\n");
  write("src/dup2.ts", "export function shared() { return 2; }\n");
});

afterEach(() => {
  if (prev.home === undefined) delete process.env.KAI_HOME;
  else process.env.KAI_HOME = prev.home;
  if (prev.ceiling === undefined) delete process.env.KAI_MCP_MAX_RESPONSE_BYTES;
  else process.env.KAI_MCP_MAX_RESPONSE_BYTES = prev.ceiling;
  for (const d of [home, root, outside]) fs.rmSync(d, { recursive: true, force: true });
});

describe("kai_read_range: valid reads", () => {
  it("reads a symbol by name and file with its exact declared range", async () => {
    const r = await callTool(root, "kai_read_range", { filePath: "src/a.ts", symbol: "beta" });
    const j = r.json!;
    expect(j).toMatchObject({
      status: "ok",
      filePath: "src/a.ts",
      startLine: 6,
      endLine: 11,
      lineCount: 6,
      totalLines: 11,
      symbol: { name: "beta", kind: "function", declaredLines: [6, 11] },
    });
    expect(j.source).toBe(A_TS.split("\n").slice(5, 11).join("\n"));
    expect(j.contentHash).toMatch(/^[0-9a-f]{16}$/);
    expect(j.tokenEstimate).toBe("heuristic");
    expect(j.estimatedTokens).toBeGreaterThan(0);
    // Relative path only.
    expect(r.text).not.toContain(root);
    expect(r.text).not.toContain(os.tmpdir());
  });

  it("reads explicit lines, with Windows-style separators and optional context", async () => {
    const r = await callTool(root, "kai_read_range", {
      filePath: "src\\a.ts",
      startLine: 2,
      endLine: 3,
    });
    expect(r.json).toMatchObject({ status: "ok", filePath: "src/a.ts", startLine: 2, endLine: 3 });
    expect(r.json!.source).toBe("  const doubled = x * 2;\n  return doubled;");

    const ctxd = await callTool(root, "kai_read_range", {
      filePath: "src/a.ts",
      startLine: 2,
      endLine: 3,
      contextLines: 1,
    });
    expect(ctxd.json).toMatchObject({ startLine: 1, endLine: 4, lineCount: 4 });
  });

  it("finds a unique symbol without a file path, and uses Class.method to disambiguate", async () => {
    const r = await callTool(root, "kai_read_range", { symbol: "alpha" });
    expect(r.json).toMatchObject({ status: "ok", filePath: "src/a.ts", startLine: 1, endLine: 4 });

    const m = await callTool(root, "kai_read_range", {
      filePath: "src/classes.ts",
      symbol: "Other.run",
    });
    expect(m.json).toMatchObject({ status: "ok", startLine: 7, endLine: 9 });
    expect(m.json!.source).toContain("return 2;");
    expect(m.json!.symbol.container).toBe("Other");
  });

  it("reports an unknown symbol as a status, not a crash", async () => {
    const r = await callTool(root, "kai_read_range", { filePath: "src/a.ts", symbol: "nope" });
    expect(r.json).toMatchObject({ status: "not_found", filePath: "src/a.ts" });
  });
});

describe("kai_read_range: invalid and oversized requests", () => {
  const bad = async (args: Record<string, unknown>) =>
    (await callTool(root, "kai_read_range", args)).error;

  it("rejects missing, conflicting and malformed arguments", async () => {
    expect((await bad({}))?.code).toBe(-32602);
    expect((await bad({ filePath: "src/a.ts" }))?.code).toBe(-32602);
    expect((await bad({ startLine: 1, endLine: 2 }))?.message).toContain("filePath is required");
    expect(
      (await bad({ filePath: "src/a.ts", symbol: "alpha", startLine: 1, endLine: 2 }))?.message
    ).toContain("either symbol or");
    expect((await bad({ filePath: "src/a.ts", startLine: 0, endLine: 2 }))?.message).toContain(
      "positive"
    );
    expect((await bad({ filePath: "src/a.ts", startLine: 1.5, endLine: 2 }))?.code).toBe(-32602);
    expect((await bad({ filePath: "src/a.ts", startLine: 5, endLine: 2 }))?.message).toContain(
      "before startLine"
    );
    expect((await bad({ filePath: "src/a.ts", startLine: 1, endLine: 2, maxLines: 0 }))?.code).toBe(
      -32602
    );
    expect(
      (await bad({ filePath: "src/a.ts", startLine: 1, endLine: 2, expectedHash: "not-hex" }))?.code
    ).toBe(-32602);
  });

  it("rejects out-of-range lines against the live file", async () => {
    expect((await bad({ filePath: "src/a.ts", startLine: 50, endLine: 60 }))?.message).toContain(
      "out-of-range"
    );
    expect((await bad({ filePath: "src/a.ts", startLine: 1, endLine: 60 }))?.message).toContain(
      "out-of-range"
    );
  });

  it("rejects ranges larger than maxLines and never allows more than the hard cap", async () => {
    write(
      "src/long.ts",
      Array.from({ length: 600 }, (_, i) => `// line ${i + 1}`).join("\n") + "\n"
    );
    const def = await bad({ filePath: "src/long.ts", startLine: 1, endLine: 201 });
    expect(def?.message).toContain("range too large: 201 lines requested, maximum 200");
    const raised = await callTool(root, "kai_read_range", {
      filePath: "src/long.ts",
      startLine: 1,
      endLine: 300,
      maxLines: 300,
    });
    expect(raised.json).toMatchObject({ status: "ok", lineCount: 300 });
    const capped = await bad({
      filePath: "src/long.ts",
      startLine: 1,
      endLine: 401,
      maxLines: 5000,
    });
    expect(capped?.message).toContain("maximum 400");
  });

  it("truncates an oversized symbol with a continuation point instead of failing", async () => {
    const body = Array.from({ length: 299 }, (_, i) => `  total += ${i};`);
    write(
      "src/huge.ts",
      ["export function huge() {", "  let total = 0;", ...body, "  return total;", "}"].join("\n")
    );
    const first = await callTool(root, "kai_read_range", {
      filePath: "src/huge.ts",
      symbol: "huge",
    });
    expect(first.json).toMatchObject({
      status: "ok",
      startLine: 1,
      lineCount: 200,
      truncated: true,
      nextStartLine: 201,
    });
    const rest = await callTool(root, "kai_read_range", {
      filePath: "src/huge.ts",
      startLine: first.json!.nextStartLine,
      endLine: 302,
    });
    expect(rest.json).toMatchObject({ status: "ok", startLine: 201, endLine: 302 });
  });

  it("cuts a single enormous line to fit the response ceiling", async () => {
    process.env.KAI_MCP_MAX_RESPONSE_BYTES = "8192";
    write("src/wide.ts", `export const WIDE = "${"y".repeat(100000)}";\n`);
    const r = await callTool(root, "kai_read_range", {
      filePath: "src/wide.ts",
      startLine: 1,
      endLine: 1,
    });
    expect(r.bytes).toBeLessThanOrEqual(8192);
    expect(r.json).toMatchObject({ status: "ok", truncated: true });
  });
});

describe("kai_read_range: path and content protection", () => {
  const denied = async (filePath: string) =>
    (await callTool(root, "kai_read_range", { filePath, startLine: 1, endLine: 1 })).error;

  it("rejects traversal, absolute and UNC paths and null bytes", async () => {
    write("src/ok.ts", "export const OK = 1;\n");
    fs.writeFileSync(path.join(outside, "leak.ts"), "export const LEAK = 1;\n");
    const cases = [
      "../outside.ts",
      "src/../../outside.ts",
      path.join(outside, "leak.ts"),
      "/etc/passwd",
      "C:\\Windows\\win.ini",
      "\\\\server\\share\\x.ts",
      "src/ok.ts\0.png",
    ];
    for (const c of cases) {
      const e = await denied(c);
      expect(e?.code, c).toBe(-32602);
      expect(e?.message, c).not.toContain(outside);
    }
  });

  it("refuses sensitive files by name and never reads files skipped for secret content", async () => {
    write(".env", "TOKEN=abc\n");
    write("src/aws.ts", `export const KEY = "${FAKE_AWS_KEY}";\n`);
    write("src/id_rsa", "irrelevant\n");
    expect((await denied(".env"))?.message).toContain("Access denied");
    expect((await denied("src/id_rsa"))?.message).toContain("Access denied");
    // Skipped on content during indexing: not an indexed file, so never readable.
    expect((await denied("src/aws.ts"))?.message).toContain("File not found in index");
    expect((await denied("src/missing.ts"))?.message).toContain("File not found in index");
  });

  it("does not follow a directory link out of the project root", async () => {
    fs.writeFileSync(path.join(outside, "leak.ts"), "export const LEAK = 'outside';\n");
    try {
      fs.symlinkSync(outside, path.join(root, "src", "linked"), "junction");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES" || code === "ENOSYS") return; // cannot create links here
      throw err;
    }
    const e = await denied("src/linked/leak.ts");
    expect(e?.code).toBe(-32602);
    const search = await callTool(root, "kai_search_code", { query: "LEAK outside" });
    expect(search.text).not.toContain("outside'");
  });

  it("re-checks confinement at read time even for a path that is in the index", async () => {
    // A crafted/stale index naming a file that now resolves outside the root.
    fs.writeFileSync(path.join(outside, "leak.ts"), "export const LEAK = 'outside';\n");
    try {
      fs.symlinkSync(outside, path.join(root, "src", "swapped"), "junction");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES" || code === "ENOSYS") return;
      throw err;
    }
    const index = await indexProject(registerProject(root));
    const crafted: ProjectIndex = JSON.parse(JSON.stringify(index));
    crafted.files["src/swapped/leak.ts"] = {
      ...crafted.files["src/a.ts"],
      relativePath: "src/swapped/leak.ts",
    };
    expect(readIndexedSource(crafted, "src/swapped/leak.ts").status).toBe("untrusted");
    expect(readIndexedSource(crafted, "src/not-in-index.ts").status).toBe("not_indexed");
    expect(readIndexedSource(index, "src/a.ts").status).toBe("ok");
  });

  it("applies the indexer's full sensitive-name list to indexed files too (symbol and snippet paths)", async () => {
    const index = await indexProject(registerProject(root));
    const crafted: ProjectIndex = JSON.parse(JSON.stringify(index));
    // Names `isSensitiveFile` knows but the narrower retrieval-only screen did not.
    for (const name of [".npmrc", "service-account.json", "keystore.p12", "id_dsa", ".netrc"]) {
      write(name, "harmless text, not a credential pattern\n");
      crafted.files[name] = { ...crafted.files["src/a.ts"], relativePath: name };
      expect(readIndexedSource(crafted, name).status, name).toBe("untrusted");
    }
    expect(readIndexedSource(crafted, "src/a.ts").status).toBe("ok");
  });

  it("refuses a secret-looking path and credential content even if the file is indexed", async () => {
    const index = await indexProject(registerProject(root));
    const crafted: ProjectIndex = JSON.parse(JSON.stringify(index));
    // Edited after indexing to contain a credential: retrieval must not return it.
    write("src/a.ts", `export const KEY = "${FAKE_AWS_KEY}";\n`);
    expect(readIndexedSource(crafted, "src/a.ts").status).toBe("untrusted");
    crafted.files["credentials.json"] = {
      ...crafted.files["src/a.ts"],
      relativePath: "credentials.json",
    };
    expect(readIndexedSource(crafted, "credentials.json").status).toBe("untrusted");
  });
});

describe("kai_read_range: ambiguity and staleness", () => {
  it("returns a bounded candidate list instead of guessing between definitions", async () => {
    const r = await callTool(root, "kai_read_range", { symbol: "shared" });
    const j = r.json!;
    expect(j.status).toBe("ambiguous");
    expect(j.source).toBeUndefined();
    expect(j.total).toBe(2);
    expect(j.candidates.map((c: { filePath: string }) => c.filePath)).toEqual([
      "src/dup1.ts",
      "src/dup2.ts",
    ]);
    expect(j.candidates[0]).toMatchObject({ name: "shared", kind: "function", startLine: 1 });

    const same = await callTool(root, "kai_read_range", {
      filePath: "src/classes.ts",
      symbol: "run",
    });
    expect(same.json).toMatchObject({ status: "ambiguous", total: 2 });
    expect(same.json!.candidates.map((c: { container: string }) => c.container)).toEqual([
      "Svc",
      "Other",
    ]);
  });

  it("caps the candidate list for very common names", async () => {
    for (let i = 0; i < 60; i++)
      write(`src/many/m${i}.ts`, `export function common() { return ${i}; }\n`);
    const r = await callTool(root, "kai_read_range", { symbol: "common" });
    expect(r.json).toMatchObject({ status: "ambiguous", total: 60, returned: 20 });
    expect(r.json!.candidates).toHaveLength(20);
  });

  it("reports a hash mismatch as stale and does not return the changed source", async () => {
    const search = await callTool(root, "kai_search_code", { query: "beta", includeSource: false });
    const hash = search.json!.files[0].contentHash as string;
    const ok = await callTool(root, "kai_read_range", {
      filePath: "src/a.ts",
      symbol: "beta",
      expectedHash: hash,
    });
    expect(ok.json!.status).toBe("ok");
    expect(ok.json!.contentHash).toBe(hash);

    write("src/a.ts", A_TS.replace("a + b", "b + a"));
    const stale = await callTool(root, "kai_read_range", {
      filePath: "src/a.ts",
      symbol: "beta",
      expectedHash: hash,
    });
    expect(stale.json).toMatchObject({ status: "stale", filePath: "src/a.ts", expectedHash: hash });
    expect(stale.json!.currentHash).toMatch(/^[0-9a-f]{16}$/);
    expect(stale.json!.currentHash).not.toBe(hash);
    expect(stale.json!.source).toBeUndefined();

    // Without a hash, the refreshed index serves the new content.
    const fresh = await callTool(root, "kai_read_range", { filePath: "src/a.ts", symbol: "beta" });
    expect(fresh.json!.source).toContain("b + a");
    // The hash prefix form (8+ chars) is accepted.
    const prefix = await callTool(root, "kai_read_range", {
      filePath: "src/a.ts",
      symbol: "beta",
      expectedHash: fresh.json!.contentHash.slice(0, 8),
    });
    expect(prefix.json!.status).toBe("ok");
  });

  it("treats symbol ranges as untrustworthy when the file moved on since indexing", async () => {
    const meta = registerProject(root);
    const index = await indexProject(meta);
    const ctx: ToolContext = {
      meta,
      index,
      canonicalRoot: resolveCanonicalPath(root),
      gate: { freshness: "fresh", refreshOutcome: "not-required" },
      maxBytes: 64 * 1024,
      wrapperBytes: 100,
    };
    // An edit lands after the index was built and before the read (no gate here).
    write("src/a.ts", "// shifted by a new first line\n" + A_TS);
    const sym = toolReadRange(ctx, { filePath: "src/a.ts", symbol: "beta" });
    expect(sym).toMatchObject({ kind: "json", payload: { status: "stale" } });
    // Explicit lines are served from the live file and flagged.
    const lines = toolReadRange(ctx, { filePath: "src/a.ts", startLine: 1, endLine: 2 });
    expect(lines).toMatchObject({ kind: "json", payload: { status: "ok", indexStale: true } });
    if (lines.kind === "json")
      expect(lines.payload.source).toContain("shifted by a new first line");

    // A deleted file reads as stale, not as an error leaking its location.
    fs.rmSync(path.join(root, "src", "dup1.ts"));
    const gone = toolReadRange(ctx, { filePath: "src/dup1.ts", startLine: 1, endLine: 1 });
    expect(gone).toMatchObject({
      kind: "json",
      payload: { status: "stale", filePath: "src/dup1.ts" },
    });
  });

  it("never serves outdated source while the index refresh is blocked", async () => {
    const meta = registerProject(root);
    await indexProject(meta);
    const lock = new ProjectLock(meta.id);
    expect(lock.acquire(1000)).toBe(true);
    try {
      write("src/a.ts", "// shifted by a new first line\n" + A_TS);
      // The gate cannot refresh (lock held): the stale index must not be trusted for ranges.
      const sym = await callTool(root, "kai_read_range", { filePath: "src/a.ts", symbol: "beta" });
      expect(sym.json).toMatchObject({ status: "stale" });
      expect(sym.text).not.toContain("return a + b");
      const lines = await callTool(root, "kai_read_range", {
        filePath: "src/a.ts",
        startLine: 1,
        endLine: 1,
      });
      expect(lines.json).toMatchObject({ status: "ok", indexStale: true });
      expect(lines.json!.source).toContain("shifted by a new first line");
    } finally {
      lock.release();
    }
    // Once the blocker is gone the next read refreshes and the symbol resolves again.
    const after = await callTool(root, "kai_read_range", { filePath: "src/a.ts", symbol: "beta" });
    expect(after.json).toMatchObject({ status: "ok" });
    expect(after.json!.source).toContain("return a + b");
  });
});
