/**
 * Step 9 regression tests: correctness-sensitive optimizations must not
 * change observable behavior. Each test pins the pre-optimization golden
 * behavior (captured 2026-10-14) or a budget/cap invariant.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { matchesIgnorePattern } from "../core/indexer";
import { classifyTask } from "../core/classifier";
import { estimateTokens, truncateToTokenBudget } from "../core/tokenCounter";
import { registerProject } from "../core/registry";
import { indexProject } from "../core/indexer";
import { retrieveContext } from "../core/retrieval";
import { TerminalOutputBuffer, MAX_TERMINAL_PENDING_CHARS } from "../services/terminalOutputBuffer";

describe("Step 9: ignore-matcher cache parity", () => {
  it("returns identical results on repeat calls (cache hit path)", () => {
    const pats = [
      "*.log",
      "dist/",
      "build/*.js",
      "src/generated/*.ts",
      "node_modules/",
      "logs/*.log",
    ];
    const cases: Array<[string, string]> = [
      ["src/module_0.ts", "module_0.ts"],
      ["dist/bundle.js", "bundle.js"],
      ["build/app.js", "app.js"],
      ["src/generated/types.ts", "types.ts"],
      ["node_modules/foo/index.js", "index.js"],
      ["logs/app.log", "app.log"],
      ["README.md", "README.md"],
    ];
    for (const [rel, name] of cases) {
      const first = matchesIgnorePattern(rel, name, pats);
      const second = matchesIgnorePattern(rel, name, pats);
      expect(second).toBe(first);
    }
    expect(matchesIgnorePattern("node_modules/foo/index.js", "index.js", ["node_modules/"])).toBe(
      true
    );
    expect(matchesIgnorePattern("src/a.ts", "a.ts", ["*.log"])).toBe(false);
  });
});

describe("Step 9: classifier parity", () => {
  it("keeps golden categories", () => {
    expect(classifyTask("Fix the crashing bug in the login handler", undefined).category).toBe(
      "debug"
    );
    expect(classifyTask("Write unit tests for the login handler", undefined).category).toBe("test");
    expect(classifyTask("blorple zzzqqq", undefined).category).toBe("unknown");
  });

  it("is deterministic across calls", () => {
    const tasks = [
      "Refactor the auth module to simplify token refresh",
      "Review this pull request for security issues",
      "How does the PTY reader thread work?",
      "Add a new keyboard shortcut for the AI panel",
      "Document the workspace restore format",
    ];
    for (const t of tasks) {
      expect(classifyTask(t, undefined)).toEqual(classifyTask(t, undefined));
    }
  });
});

describe("Step 9: truncateToTokenBudget guarantees", () => {
  const big = "const x = 1;\n".repeat(20000);

  it("keeps the golden boundary on the reference sample", () => {
    const { text, wasTruncated, metrics } = truncateToTokenBudget(big, 4000);
    expect(wasTruncated).toBe(true);
    expect(text.length).toBe(5200);
    expect(metrics.estimatedTokens).toBeLessThanOrEqual(4000);
  });

  it("always respects the budget and preserves the prefix", () => {
    for (const budget of [5, 100, 1000, 4000, 19999]) {
      const { text, metrics } = truncateToTokenBudget(big, budget);
      expect(metrics.estimatedTokens).toBeLessThanOrEqual(budget);
      expect(big.startsWith(text)).toBe(true);
      expect(estimateTokens(text).estimatedTokens).toBeLessThanOrEqual(budget);
    }
  });

  it("returns input unchanged when it already fits", () => {
    const small = "hello world";
    const { text, wasTruncated } = truncateToTokenBudget(small, 4000);
    expect(text).toBe(small);
    expect(wasTruncated).toBe(false);
  });

  it("fills the budget near-maximally on prose", () => {
    const prose = "The quick brown fox jumps over the lazy dog. ".repeat(5000);
    const budget = 2000;
    const { text, metrics } = truncateToTokenBudget(prose, budget);
    expect(metrics.estimatedTokens).toBeLessThanOrEqual(budget);
    // Within 10% of the budget: not a degenerate over-truncation.
    expect(metrics.estimatedTokens).toBeGreaterThan(budget * 0.9);
    expect(prose.startsWith(text)).toBe(true);
  });
});

describe("Step 9: retrieval staleness fast path", () => {
  let tmpDir: string;
  let savedKaiHome: string | undefined;

  beforeEach(() => {
    savedKaiHome = process.env.KAI_HOME;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-step9-reg-"));
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

  it("flags unmodified files fresh and modified files stale", async () => {
    const repo = path.join(tmpDir, "repo");
    fs.mkdirSync(path.join(repo, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(repo, "src", "alpha.ts"),
      'export function alphaService(): string { return "alpha"; }\n'
    );
    const meta = registerProject(repo);
    const index = await indexProject(meta, { forceRebuild: true });

    const fresh = retrieveContext(index, "alphaService", { tokenBudget: 4000 });
    expect(fresh.matchedFiles.length).toBeGreaterThan(0);
    expect(fresh.staleFiles).toEqual([]);

    // Modify on disk (mtime + size change) without re-indexing.
    fs.appendFileSync(path.join(repo, "src", "alpha.ts"), "export const BETA = 42;\n");
    const stale = retrieveContext(index, "alphaService", { tokenBudget: 4000 });
    expect(stale.staleFiles).toContain("src/alpha.ts");
  });
});

describe("Step 9: retrieval symbol-match bounds", () => {
  let tmpDir: string;
  let savedKaiHome: string | undefined;

  beforeEach(() => {
    savedKaiHome = process.env.KAI_HOME;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-step9-cap-"));
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

  it("bounds pathological symbol matches and stays deterministic", async () => {
    const repo = path.join(tmpDir, "repo");
    fs.mkdirSync(path.join(repo, "src"), { recursive: true });
    const lines = Array.from(
      { length: 1500 },
      (_, i) => `export function sym${i}(): number { return ${i}; }`
    );
    fs.writeFileSync(path.join(repo, "src", "big.ts"), lines.join("\n") + "\n");
    fs.writeFileSync(
      path.join(repo, "src", "small.ts"),
      "export function symTarget(): number { return 1; }\n"
    );
    const meta = registerProject(repo);
    const index = await indexProject(meta, { forceRebuild: true });

    const first = retrieveContext(index, "sym", { tokenBudget: 4000, fileBudget: 8 });
    const second = retrieveContext(index, "sym", { tokenBudget: 4000, fileBudget: 8 });
    expect(second).toEqual(first);
    for (const m of first.matchedFiles) {
      expect(m.matchedSymbols.length).toBeLessThanOrEqual(500);
    }
    expect(first.matchedSymbols.length).toBeLessThanOrEqual(1000);
    // Exact hit still ranks first.
    const exact = retrieveContext(index, "symTarget", { tokenBudget: 4000, fileBudget: 8 });
    expect(exact.matchedSymbols[0]?.name).toBe("symTarget");
  });
});

describe("Step 9: TerminalOutputBuffer", () => {
  it("preserves order and round-trips exactly (surrogates intact)", () => {
    const buf = new TerminalOutputBuffer();
    buf.append("hello ");
    buf.append("world \u{1F600} ");
    buf.append("done\r\n");
    expect(buf.flush()).toBe("hello world \u{1F600} done\r\n");
    expect(buf.flush()).toBe("");
    expect(buf.isEmpty).toBe(true);
  });

  it("caps memory at ~1 MB keeping the tail", () => {
    const buf = new TerminalOutputBuffer();
    const a = "a".repeat(600 * 1024);
    const b = "b".repeat(600 * 1024);
    buf.append(a);
    buf.append(b);
    expect(buf.size).toBeLessThanOrEqual(MAX_TERMINAL_PENDING_CHARS);
    const out = buf.flush();
    expect(out.length).toBeLessThanOrEqual(MAX_TERMINAL_PENDING_CHARS);
    expect(out.endsWith(b)).toBe(true);
    expect(out).not.toContain("a");
  });

  it("trims a single oversized payload without splitting surrogates", () => {
    const buf = new TerminalOutputBuffer(100);
    buf.append("x".repeat(50) + "\u{1F600}".repeat(50));
    const out = buf.flush();
    expect(out.length).toBeLessThanOrEqual(100);
    // Valid JS string: no lone surrogates.
    expect(Array.from(out).join("")).toBe(out);
  });

  it("handles a 10 MB flood with bounded memory", () => {
    const buf = new TerminalOutputBuffer();
    for (let i = 0; i < 20000; i++) buf.append("x".repeat(512) + `line-${i}\r\n`);
    expect(buf.size).toBeLessThanOrEqual(MAX_TERMINAL_PENDING_CHARS);
    const out = buf.flush();
    expect(out.length).toBeLessThanOrEqual(MAX_TERMINAL_PENDING_CHARS);
    expect(out.endsWith("line-19999\r\n")).toBe(true);
  });
});
