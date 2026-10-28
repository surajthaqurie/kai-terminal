import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { registerProject, loadProjectIndexShared } from "../core/registry";
import { indexProject } from "../core/indexer";
import { rankCandidates, retrieveContext, selectRanges, describeMatch } from "../core/retrieval";
import { assembleContext } from "../core/contextAssembler";
import { expandSupportingFiles } from "../core/codeModeWorkflow";
import { getReverseImports, splitIdentifier, stemWord } from "../core/indexDerived";
import type { ProjectIndex } from "../core/types";

let home = "";
let root = "";
const prevHome = process.env.KAI_HOME;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "kai-rank-home-"));
  root = fs.mkdtempSync(path.join(os.tmpdir(), "kai-rank-proj-"));
  process.env.KAI_HOME = home;
});
afterEach(() => {
  if (prevHome === undefined) delete process.env.KAI_HOME;
  else process.env.KAI_HOME = prevHome;
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
});

function write(rel: string, content: string): void {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}
async function build(): Promise<ProjectIndex> {
  return indexProject(registerProject(root));
}

/** A project where `tokens` is everywhere but `estimateTokens` is the thing being asked about. */
function writeTokenProject(): void {
  write(
    "src/tokenCounter.ts",
    [
      "export function estimateTokens(text: string): number {",
      "  return Math.ceil(text.length / 4);",
      "}",
      "export function truncateToTokenBudget(text: string, max: number): string {",
      "  return text.slice(0, max);",
      "}",
    ].join("\n")
  );
  write(
    "src/classifier.ts",
    [
      "export const tokens = ['a', 'b'];",
      "export function parseTokens(input: string): string[] { return input.split(' '); }",
      "export function tokensToString(list: string[]): string { return list.join(' '); }",
      "export function rawTokens(): string[] { return tokens; }",
      "export class TokenList {}",
    ].join("\n")
  );
  write(
    "src/lexer.ts",
    "export function tokens() { return []; }\nexport function nextTokens() { return 1; }\n"
  );
  write(
    "src/other.ts",
    "export function tokenize() { return []; }\nexport const tokenCount = 3;\n"
  );
}

describe("relevance: a common word must not outrank the specific target", () => {
  it("ranks estimateTokens first for natural-language and identifier queries", async () => {
    writeTokenProject();
    const index = await build();
    for (const query of [
      "estimate tokens for a string",
      "estimateTokens",
      "where are tokens estimated",
      "how does estimateTokens count tokens",
    ]) {
      const ranking = rankCandidates(index, query);
      expect(ranking.ranked[0].file.relativePath, query).toBe("src/tokenCounter.ts");
      expect(ranking.ranked[0].symbolHits[0].symbol.name, query).toBe("estimateTokens");
      expect(ranking.matchedSymbols[0].name, query).toBe("estimateTokens");
    }
  });

  it("still finds `tokens`-named symbols when only the common word is asked for", async () => {
    writeTokenProject();
    const index = await build();
    const ranking = rankCandidates(index, "tokens");
    const names = ranking.matchedSymbols.slice(0, 3).map((s) => s.name);
    expect(names).toContain("tokens");
    expect(ranking.ranked.length).toBeGreaterThan(1);
  });

  it("explains why each result was selected", async () => {
    writeTokenProject();
    const index = await build();
    const [top] = rankCandidates(index, "estimateTokens").ranked;
    expect(describeMatch(top)).toMatch(/symbol estimateTokens \(exact name\)/);
    const [pathOnly] = rankCandidates(index, "lexer").ranked;
    expect(describeMatch(pathOnly)).toContain("path matches lexer");
  });

  it("splits and stems identifiers deterministically", () => {
    expect(splitIdentifier("estimateTokens")).toEqual(["estimate", "tokens"]);
    expect(splitIdentifier("XMLHttpRequest")).toEqual(["xml", "http", "request"]);
    expect(splitIdentifier("MAX_ITEMS_PER_PAGE")).toEqual(["max", "items", "per", "page"]);
    expect(stemWord("estimated")).toBe(stemWord("estimate"));
    expect(stemWord("tokens")).toBe(stemWord("token"));
  });
});

describe("snippet selection centres on the best-scored symbol", () => {
  function writeTwoSymbolFile(): void {
    const filler = Array.from({ length: 100 }, (_, i) => `  filler${i}();`);
    write(
      "src/counter.ts",
      [
        "export function helperTokens() {", // 1 : weak match, first in the file
        "  return 1;", // 2
        "}", // 3
        "",
        ...Array.from({ length: 90 }, (_, i) => `// padding ${i}`), // 5..94
        "export function estimateTokens(text: string): number {", // 95
        "  const length = text.length;", // 96
        "  return Math.ceil(length / 4);", // 97
        "}", // 98
        ...filler.map((l) => `// ${l}`),
      ].join("\n")
    );
  }

  it("returns the declaration of estimateTokens, not the first matched symbol's neighbourhood", async () => {
    writeTwoSymbolFile();
    const index = await build();
    const result = retrieveContext(index, "estimate tokens");
    const hit = result.matchedFiles[0];
    expect(hit.file.relativePath).toBe("src/counter.ts");
    expect(hit.snippet).toContain("export function estimateTokens(");
    expect(hit.snippet).not.toContain("export function helperTokens");
    expect(hit.startLine).toBeGreaterThan(80);
    // And the line numbers describe the text actually returned.
    const fileLines = fs.readFileSync(path.join(root, "src/counter.ts"), "utf8").split("\n");
    expect(hit.snippet!.split("\n")[0]).toBe(fileLines[hit.startLine! - 1]);
    expect(hit.snippet!.split("\n").length).toBe(hit.endLine! - hit.startLine! + 1);
  });

  it("keeps startLine/endLine consistent after token-budget truncation", async () => {
    const body = Array.from(
      { length: 55 },
      (_, i) => `  const value${i} = computeSomethingLong(${i}, "argument-${i}");`
    );
    write(
      "src/big.ts",
      [
        "export function estimateTokens() {",
        ...body,
        "}",
        ...Array.from({ length: 80 }, () => "// pad"),
      ].join("\n")
    );
    const index = await build();
    const result = retrieveContext(index, "estimateTokens", { tokenBudget: 300 });
    const hit = result.matchedFiles[0];
    expect(hit).toBeDefined();
    const returnedLines = hit.snippet!.split("\n").length;
    expect(hit.endLine! - hit.startLine! + 1).toBe(returnedLines);
    // It really was cut: the declaration is 57 lines.
    expect(returnedLines).toBeLessThan(57);
  });

  it("merges overlapping and touching symbol ranges into one snippet", async () => {
    write(
      "src/pair.ts",
      [
        ...Array.from({ length: 70 }, (_, i) => `// pad ${i}`), // 1..70
        "export function encodeFrame(data: string) {", // 71
        "  return data;", // 72
        "}", // 73
        "export function decodeFrame(data: string) {", // 74
        "  return data;", // 75
        "}", // 76
        ...Array.from({ length: 70 }, (_, i) => `// tail ${i}`),
      ].join("\n")
    );
    const index = await build();
    const result = retrieveContext(index, "encodeFrame decodeFrame");
    const hit = result.matchedFiles[0];
    expect(hit.snippet).toContain("encodeFrame");
    expect(hit.snippet).toContain("decodeFrame");
    expect(hit.moreRanges).toBeUndefined();
    expect(hit.startLine).toBeLessThanOrEqual(71);
    expect(hit.endLine).toBeGreaterThanOrEqual(76);
  });

  it("reports far-apart secondary ranges as metadata only and never duplicates covered ones", async () => {
    write(
      "src/far.ts",
      [
        "export function encodeFrame(data: string) {",
        "  return data;",
        "}",
        ...Array.from({ length: 120 }, (_, i) => `// pad ${i}`),
        "export function decodeFrame(data: string) {",
        "  return data;",
        "}",
        ...Array.from({ length: 70 }, (_, i) => `// tail ${i}`),
      ].join("\n")
    );
    const index = await build();
    const hit = retrieveContext(index, "encodeFrame decodeFrame").matchedFiles[0];
    expect(hit.moreRanges).toHaveLength(1);
    expect(hit.moreRanges![0].startLine).toBeGreaterThan(hit.endLine!);
    // Reported as line ranges to read, never as extra source text.
    expect(JSON.stringify(hit.moreRanges)).not.toContain("return data");
    const { primary, more } = selectRanges(
      rankCandidates(index, "encodeFrame decodeFrame").ranked[0].symbolHits,
      190,
      false
    );
    expect(more.every((m) => m.startLine > primary.endLine || m.endLine < primary.startLine)).toBe(
      true
    );
  });

  it("returns whole small files and the head of large files without a matched symbol", async () => {
    write("src/tiny.ts", "export const ONE = 1;\n");
    write("src/notes_widget.ts", Array.from({ length: 300 }, (_, i) => `// line ${i}`).join("\n"));
    const index = await build();
    const tiny = retrieveContext(index, "tiny").matchedFiles[0];
    expect(tiny).toMatchObject({ startLine: 1 });
    expect(tiny.snippet).toContain("ONE");
    const large = retrieveContext(index, "notes_widget").matchedFiles[0];
    expect(large.startLine).toBe(1);
    expect(large.endLine).toBeLessThanOrEqual(80);
  });
});

describe("omissions and context stay bounded", () => {
  it("caps the omission list but keeps the true count visible", async () => {
    for (let i = 0; i < 80; i++)
      write(`src/widget/w${i}.ts`, `export function widgetRender${i}() { return ${i}; }\n`);
    const index = await build();
    const result = retrieveContext(index, "widget render", { fileBudget: 3 });
    expect(result.matchedFiles).toHaveLength(3);
    expect(result.omissions.length).toBeLessThanOrEqual(25);
    expect(result.omissionsTotal).toBe(result.candidateCount - 3);
    expect(result.omissionsTotal).toBeGreaterThan(25);

    const { contextPackage, renderedPrompt } = assembleContext(index, {
      task: "explain widget render",
      fileBudget: 3,
    });
    expect(contextPackage.omissions.length).toBeLessThanOrEqual(30);
    expect(contextPackage.omissionsTotal).toBeGreaterThan(contextPackage.omissions.length);
    expect(renderedPrompt).toMatch(/\.\.\.and \d+ more item\(s\) omitted \(list capped\)/);
  });

  it("never claims a truncation it did not perform when the task itself exceeds the budget", async () => {
    write("src/a.ts", "export function alpha() { return 1; }\n");
    const index = await build();
    const task = "explain alpha in detail " + "very long requirement text ".repeat(150); // ~4000 chars
    const { renderedPrompt, contextPackage } = assembleContext(index, { task, tokenBudget: 200 });
    // The task is never cut, so the prompt cannot fit 200 tokens...
    expect(renderedPrompt).toContain(task);
    expect(contextPackage.tokenMetrics.estimatedTokens).toBeGreaterThan(200);
    // ...and the package says so instead of reporting a truncation that did not happen.
    const notes = contextPackage.knownLimitations.join("\n");
    expect(notes).toMatch(/cannot be truncated without cutting the user task/);
    expect(notes).not.toMatch(/was truncated/);
  });

  it("shrinks the omission list first so a tight budget keeps its metrics footer", async () => {
    for (let i = 0; i < 80; i++) {
      write(`src/widget/w${i}.ts`, `export function widgetRender${i}() { return ${i}; }\n`);
    }
    const index = await build();
    const { renderedPrompt, contextPackage } = assembleContext(index, {
      task: "explain widget render",
      tokenBudget: 1000,
    });
    expect(contextPackage.tokenMetrics.estimatedTokens).toBeLessThanOrEqual(1000);
    // The footer survives: it was not cut off by a hard truncation of a long omission list.
    expect(renderedPrompt).toContain("Estimated Tokens");
    expect(renderedPrompt).toContain("Measurement Type");
    expect(renderedPrompt).toMatch(/\.\.\.and \d+ more item\(s\) omitted/);
    // The structured package still carries the capped list and the true total.
    expect(contextPackage.omissions.length).toBeGreaterThan(10);
    expect(contextPackage.omissionsTotal).toBeGreaterThanOrEqual(contextPackage.omissions.length);
    expect(contextPackage.omissionRenderLimit).toBeLessThanOrEqual(3);
  });

  it("drops optional context to fit a byte budget in escaped bytes and keeps the task", async () => {
    for (let i = 0; i < 12; i++) {
      write(
        `src/q${i}.ts`,
        `export function quoted${i}() {\n${Array.from({ length: 30 }, (_, k) => `  const s${k} = "a \\" b 😀 ${k}";`).join("\n")}\n}\n`
      );
    }
    const index = await build();
    const budget = 6000;
    const { renderedPrompt, contextPackage } = assembleContext(index, {
      task: "explain quoted functions",
      tokenBudget: 20000,
      maxBytes: budget,
    });
    expect(JSON.stringify(renderedPrompt).length - 2).toBeLessThanOrEqual(budget + 200); // escaped bytes ~ chars here
    expect(
      Buffer.byteLength(JSON.stringify(renderedPrompt).slice(1, -1), "utf8")
    ).toBeLessThanOrEqual(budget);
    expect(renderedPrompt).toContain("explain quoted functions");
    expect(contextPackage.omissions.length).toBeGreaterThan(0);
    expect(contextPackage.knownLimitations.join(" ")).toMatch(/byte/);
  });
});

describe("import-graph expansion is bounded, resolver-based and honest", () => {
  it("follows imports and importers to a configurable depth and file count", async () => {
    for (let i = 0; i < 12; i++) {
      write(
        `src/chain/c${i}.ts`,
        (i < 11 ? `import { x } from './c${i + 1}';\n` : "") + `export const v${i} = ${i};\n`
      );
    }
    const index = await build();
    const d1 = expandSupportingFiles(index, ["src/chain/c5.ts"], { depth: 1 });
    expect(d1.supporting.map((s) => s.path).sort()).toEqual(["src/chain/c4.ts", "src/chain/c6.ts"]);
    expect(d1.supporting.find((s) => s.path === "src/chain/c6.ts")!.reason).toBe(
      "imported by selected file src/chain/c5.ts"
    );
    expect(d1.supporting.find((s) => s.path === "src/chain/c4.ts")!.reason).toBe(
      "imports selected file src/chain/c5.ts"
    );

    const d3 = expandSupportingFiles(index, ["src/chain/c5.ts"], { depth: 3 });
    expect(d3.supporting.map((s) => s.path).sort()).toEqual([
      "src/chain/c2.ts",
      "src/chain/c3.ts",
      "src/chain/c4.ts",
      "src/chain/c6.ts",
      "src/chain/c7.ts",
      "src/chain/c8.ts",
    ]);
    const capped = expandSupportingFiles(index, ["src/chain/c5.ts"], { depth: 3, maxFiles: 3 });
    expect(capped.supporting).toHaveLength(3);
    // Depth is clamped, so a hostile value cannot trigger a whole-graph walk.
    const clamped = expandSupportingFiles(index, ["src/chain/c0.ts"], {
      depth: 999,
      maxFiles: 999,
    });
    expect(clamped.supporting.length).toBeLessThanOrEqual(25);
    expect(clamped.supporting.length).toBeLessThanOrEqual(3);
    expect(d3.graphSteps).toBeGreaterThan(0);
  });

  it("caps a hub's importers and says only import relationships were used", async () => {
    write("src/hub.ts", "export const HUB = 1;\n");
    for (let i = 0; i < 40; i++)
      write(`src/users/u${i}.ts`, `import { HUB } from '../hub';\nexport const U${i} = HUB;\n`);
    const index = await build();
    const out = expandSupportingFiles(index, ["src/hub.ts"]);
    expect(out.supporting.length).toBeLessThanOrEqual(10);
    expect(out.rationale.join(" ")).toContain("import relationships only; no call graph");
  });

  it("states what it could not follow instead of pretending", async () => {
    write(
      "src/entry.ts",
      "import React from 'react';\nimport '@/alias/thing';\nimport './missing';\nexport const E = 1;\n"
    );
    write("src/lib.rs", "use crate::other::Thing;\npub fn f() {}\n");
    const index = await build();
    const ts = expandSupportingFiles(index, ["src/entry.ts"]);
    expect(ts.rationale.join(" ")).toMatch(
      /Not followed: 2 package\/alias\/unsupported-language import\(s\) and 1 relative import/
    );
    const rs = expandSupportingFiles(index, ["src/lib.rs"]);
    // `crate::other` names a module that is not an indexed file: a relative-style miss.
    expect(rs.rationale.join(" ")).toMatch(
      /Not followed: 0 package\/alias\/unsupported-language import\(s\) and 1 relative import/
    );
    expect(rs.supporting).toEqual([]);
  });

  it("builds the reverse-import map once per index and reuses it", async () => {
    write("src/a.ts", "export const A = 1;\n");
    write("src/b.ts", "import { A } from './a';\nexport const B = A;\n");
    const index = await build();
    const first = getReverseImports(index);
    expect(getReverseImports(index)).toBe(first);
    expect(first.get("src/a.ts")).toEqual(["src/b.ts"]);
    // A cached (frozen) index shares the same derived table across requests.
    const shared = loadProjectIndexShared(registerProject(root).id).index!;
    expect(getReverseImports(shared)).toBe(getReverseImports(shared));
    expect(getReverseImports(shared)).not.toBe(first);
  });
});
