import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  estimateTokens,
  truncateToTokenBudget,
  registerCustomTokenizer,
  type TokenizerFunction,
} from "../core/tokenCounter";
import { registerProject } from "../core/registry";
import { indexProject } from "../core/indexer";
import { retrieveContext } from "../core/retrieval";
import { handleMcpMessage } from "../core/mcp";

let savedKaiHome: string | undefined;
let isolatedKaiHome: string;

beforeEach(() => {
  savedKaiHome = process.env.KAI_HOME;
  isolatedKaiHome = fs.mkdtempSync(path.join(os.tmpdir(), "kai-home-"));
  process.env.KAI_HOME = isolatedKaiHome;
  registerCustomTokenizer(null);
});

afterEach(() => {
  registerCustomTokenizer(null);
  if (savedKaiHome === undefined) delete process.env.KAI_HOME;
  else process.env.KAI_HOME = savedKaiHome;
  fs.rmSync(isolatedKaiHome, { recursive: true, force: true });
});

function makeTempProject(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-tok-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

const SAMPLE = "function calculateSum(a: number, b: number) { return a + b; }";

describe("token-count truthfulness contract (KNOWN_LIMITATIONS 1.8.2)", () => {
  it("labels heuristic counts as estimates, deterministically", () => {
    const a = estimateTokens(SAMPLE);
    const b = estimateTokens(SAMPLE);
    expect(a.estimatedTokens).toBeGreaterThan(0);
    expect(a.estimatedTokens).toBe(b.estimatedTokens);
    expect(a.isEstimate).toBe(true);
    expect(a.measuredTokens).toBeUndefined();
    expect(a.characterCount).toBe(SAMPLE.length);
  });

  it("handles empty input without claiming false precision", () => {
    const est = estimateTokens("");
    expect(est.estimatedTokens).toBe(0);
    expect(est.isEstimate).toBe(true);
    const exact = estimateTokens("", () => 42);
    expect(exact.estimatedTokens).toBe(0);
    expect(exact.measuredTokens).toBe(0);
    expect(exact.isEstimate).toBe(false);
  });

  it("refuses exact status for fractional tokenizer output", () => {
    const fractional: TokenizerFunction = () => 3.7;
    const m = estimateTokens(SAMPLE, fractional);
    // A fractional "count" is malformed: must fall back to the heuristic,
    // never be labeled exact.
    expect(m.isEstimate).toBe(true);
    expect(m.measuredTokens).toBeUndefined();
    expect(m.estimatedTokens).toBe(estimateTokens(SAMPLE).estimatedTokens);
  });

  it("normalizes negative-zero tokenizer output to positive zero", () => {
    const negZero: TokenizerFunction = () => -0;
    const m = estimateTokens("hi", negZero);
    expect(m.isEstimate).toBe(false);
    expect(Object.is(m.estimatedTokens, -0)).toBe(false);
    expect(m.estimatedTokens).toBe(0);
  });

  it("falls back to the labeled heuristic for invalid or failing tokenizers", () => {
    const heuristic = estimateTokens(SAMPLE).estimatedTokens;
    const bad: TokenizerFunction[] = [
      () => NaN,
      () => Infinity,
      () => -1,
      (() => {
        throw new Error("tokenizer down");
      }) as TokenizerFunction,
      "5" as unknown as TokenizerFunction as TokenizerFunction,
    ];
    for (const fn of bad) {
      const m = estimateTokens(SAMPLE, fn as TokenizerFunction);
      expect(m.isEstimate).toBe(true);
      expect(m.measuredTokens).toBeUndefined();
      expect(m.estimatedTokens).toBe(heuristic);
    }
  });

  it("honors a registered global tokenizer and resets cleanly", () => {
    registerCustomTokenizer(() => 7);
    const exact = estimateTokens(SAMPLE);
    expect(exact.isEstimate).toBe(false);
    expect(exact.measuredTokens).toBe(7);
    expect(exact.estimatedTokens).toBe(7);
    registerCustomTokenizer(() => 2.5);
    const fallback = estimateTokens(SAMPLE);
    expect(fallback.isEstimate).toBe(true);
    expect(fallback.measuredTokens).toBeUndefined();
  });

  it("preserves the accuracy flag through truncation in both modes", () => {
    const longText = 'console.log("Hello world");\n'.repeat(100);
    const est = truncateToTokenBudget(longText, 50);
    expect(est.wasTruncated).toBe(true);
    expect(est.metrics.estimatedTokens).toBeLessThanOrEqual(50);
    expect(est.metrics.isEstimate).toBe(true);
    expect(est.metrics.measuredTokens).toBeUndefined();

    const words = (t: string) => (t.match(/\S+/g) || []).length;
    const kept = truncateToTokenBudget(longText, 50, words);
    expect(kept.wasTruncated).toBe(true);
    expect(kept.metrics.isEstimate).toBe(false);
    expect(kept.metrics.measuredTokens).toBe(kept.metrics.estimatedTokens);

    const passthrough = truncateToTokenBudget("tiny", 4000);
    expect(passthrough.wasTruncated).toBe(false);
    expect(passthrough.text).toBe("tiny");
    expect(passthrough.metrics.isEstimate).toBe(true);

    const passthroughExact = truncateToTokenBudget("tiny", 4000, words);
    expect(passthroughExact.wasTruncated).toBe(false);
    expect(passthroughExact.metrics.isEstimate).toBe(false);
  });

  it("bounds degenerate budgets to empty output without mislabeling", () => {
    for (const weird of [0, -500, NaN]) {
      const r = truncateToTokenBudget(SAMPLE, weird);
      expect(r.wasTruncated).toBe(true);
      expect(r.text).toBe("");
      expect(r.metrics.estimatedTokens).toBe(0);
      expect(r.metrics.isEstimate).toBe(true);
    }
  });

  it("treats non-finite retrieval budgets as the default instead of voiding the bound", async () => {
    const dir = makeTempProject({
      "src/a.ts": `export function alpha() {\n${"  const x = 1;\n".repeat(200)}}\n`,
      "src/b.ts": `export function alphaBeta() {\n${"  const y = 2;\n".repeat(200)}}\n`,
      "src/c.ts": `export function gammaAlpha() {\n${"  const z = 3;\n".repeat(200)}}\n`,
    });
    const meta = registerProject(dir);
    const index = await indexProject(meta, { forceRebuild: true });
    const baseline = retrieveContext(index, "alpha", {});
    for (const weird of [NaN, Infinity, -Infinity]) {
      const res = retrieveContext(index, "alpha", { tokenBudget: weird });
      expect(res.usedTokens).toBe(baseline.usedTokens);
      expect(res.matchedFiles.map((m) => m.file.relativePath)).toEqual(
        baseline.matchedFiles.map((m) => m.file.relativePath)
      );
      expect(res.usedTokens).toBeLessThanOrEqual(3500);
    }
  });

  it("surfaces the estimate label end-to-end through the MCP context response", async () => {
    const dir = makeTempProject({
      "src/a.ts": "export function alpha() { return 1; }\n",
    });
    const res = await handleMcpMessage(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "kai_get_context",
          arguments: { task: "explain alpha", projectPath: dir },
        },
      },
      dir
    );
    expect(res?.error).toBeUndefined();
    const text = (res?.result as { content: Array<{ text: string }> }).content[0].text;
    expect(text).toContain("Estimate (character heuristic, not a model tokenizer)");
  });
});
