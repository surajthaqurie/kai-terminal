import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  assembleContext,
  resolveContextBudgets,
  DEFAULT_CONTEXT_BUDGETS,
} from "../core/contextAssembler";
import { retrieveContext } from "../core/retrieval";
import { indexProject } from "../core/indexer";
import { registerProject, loadProjectIndex } from "../core/registry";
import type { ProjectIndex, TaskCategory } from "../core/types";
import { callTool } from "./helpers/mcpCall";

const prev = { home: process.env.KAI_HOME, budgets: process.env.KAI_CONTEXT_BUDGETS };

function write(root: string, rel: string, content: string): void {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

afterEach(() => {
  if (prev.budgets === undefined) delete process.env.KAI_CONTEXT_BUDGETS;
  else process.env.KAI_CONTEXT_BUDGETS = prev.budgets;
});

describe("task-aware default budgets", () => {
  it("defines a bounded default for every task category", () => {
    const categories: TaskCategory[] = [
      "explain",
      "implement",
      "debug",
      "refactor",
      "test",
      "review",
      "architecture",
      "documentation",
      "unknown",
    ];
    for (const c of categories) {
      expect(DEFAULT_CONTEXT_BUDGETS[c], c).toBeGreaterThanOrEqual(200);
      expect(DEFAULT_CONTEXT_BUDGETS[c], c).toBeLessThanOrEqual(20000);
    }
    // Lookups are cheaper than localized fixes. No default may exceed the legacy 4000:
    // larger ones were measured to grow responses without improving retrieval.
    expect(DEFAULT_CONTEXT_BUDGETS.explain).toBeLessThan(DEFAULT_CONTEXT_BUDGETS.debug);
    expect(DEFAULT_CONTEXT_BUDGETS.debug).toBeLessThan(DEFAULT_CONTEXT_BUDGETS.implement);
    for (const c of categories) expect(DEFAULT_CONTEXT_BUDGETS[c], c).toBeLessThanOrEqual(4000);
    // An unclassified task keeps the long-standing 4000.
    expect(DEFAULT_CONTEXT_BUDGETS.unknown).toBe(4000);
  });

  it("applies valid KAI_CONTEXT_BUDGETS overrides, clamped, and ignores everything else", () => {
    const base = resolveContextBudgets(undefined);
    expect(base).toEqual(DEFAULT_CONTEXT_BUDGETS);
    expect(resolveContextBudgets('{"debug":2600}').debug).toBe(2600);
    expect(resolveContextBudgets('{"debug":2600}').explain).toBe(DEFAULT_CONTEXT_BUDGETS.explain);
    expect(resolveContextBudgets('{"debug":50}').debug).toBe(200);
    expect(resolveContextBudgets('{"debug":999999}').debug).toBe(20000);
    expect(resolveContextBudgets('{"debug":2600.9}').debug).toBe(2600);
    for (const bad of [
      "not json",
      "[1,2,3]",
      "null",
      '"debug"',
      '{"debug":"big"}',
      '{"debug":null}',
      '{"nonsense":5}',
      '{"__proto__":{"debug":1}}',
      "",
    ]) {
      expect(resolveContextBudgets(bad), bad).toEqual(DEFAULT_CONTEXT_BUDGETS);
    }
  });
});

describe("adaptive context assembly", { timeout: 120_000 }, () => {
  let home = "";
  let root = "";
  let index: ProjectIndex;
  let bigFunctionLines = 0;

  beforeAll(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "kai-adaptive-home-"));
    process.env.KAI_HOME = home;
    root = fs.mkdtempSync(path.join(os.tmpdir(), "kai-adaptive-proj-"));
    const body = Array.from({ length: 140 }, (_, i) => `  total += lines[${i % 7}] * ${i + 1};`);
    bigFunctionLines = body.length + 6;
    write(
      root,
      "src/billing/invoice.ts",
      [
        "export function computeInvoiceTotal(",
        "  lines: number[],",
        "  taxRate: number,",
        "): number {",
        "  let total = 0;",
        ...body,
        "  return total * (1 + taxRate);",
        "}",
      ].join("\n")
    );
    for (let i = 0; i < 8; i++) {
      write(
        root,
        `src/misc/m${i}.ts`,
        `export function totalHelper${i}(values: number[]): number {\n  return values.length + ${i};\n}\n`
      );
    }
    write(root, "src/misc/readme-notes.ts", "export const notes = 'invoice';\n");
    const meta = registerProject(root);
    await indexProject(meta, { forceRebuild: true });
    index = loadProjectIndex(meta.id)!;
    expect(index).toBeTruthy();
  });

  afterAll(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
    if (prev.home === undefined) delete process.env.KAI_HOME;
    else process.env.KAI_HOME = prev.home;
  });

  const task = "compute the invoice total";

  describe("budget selection and reporting", () => {
    it("uses the category default only when no budget is given", () => {
      const adaptive = assembleContext(index, {
        task,
        adaptiveBudget: true,
        categoryOverride: "debug",
      });
      expect(adaptive.contextPackage.budget).toEqual({
        tokens: DEFAULT_CONTEXT_BUDGETS.debug,
        origin: "task-default",
      });
    });

    it("honours an explicit budget exactly, adaptive or not", () => {
      for (const adaptiveBudget of [true, false]) {
        const r = assembleContext(index, {
          task,
          tokenBudget: 2750,
          adaptiveBudget,
          categoryOverride: "debug",
        });
        expect(r.contextPackage.budget).toEqual({ tokens: 2750, origin: "explicit" });
      }
    });

    it("keeps the legacy 4000 when adaptive mode is not requested", () => {
      const r = assembleContext(index, { task, categoryOverride: "explain" });
      expect(r.contextPackage.budget).toEqual({ tokens: 4000, origin: "default" });
    });

    it("clamps explicit budgets and falls back for non-finite ones", () => {
      const lo = assembleContext(index, { task, tokenBudget: 5 });
      const hi = assembleContext(index, { task, tokenBudget: 10_000_000 });
      const nan = assembleContext(index, { task, tokenBudget: Number.NaN });
      expect(lo.contextPackage.budget?.tokens).toBe(200);
      expect(hi.contextPackage.budget?.tokens).toBe(20000);
      expect(nan.contextPackage.budget?.tokens).toBe(4000);
    });

    it("says what the budget covers: this package, not the model's full input", () => {
      const r = assembleContext(index, { task, adaptiveBudget: true, categoryOverride: "debug" });
      expect(r.renderedPrompt).toContain("**Budget**: ~3000 tokens (debug default");
      expect(r.renderedPrompt).toContain("this package only, not the model's full input");
      expect(r.renderedPrompt).toContain("Estimate (character heuristic, not a model tokenizer)");
      const explicit = assembleContext(index, { task, tokenBudget: 3500 });
      expect(explicit.renderedPrompt).toContain("**Budget**: ~3500 tokens (requested)");
    });

    it("applies the environment override to the adaptive default", () => {
      process.env.KAI_CONTEXT_BUDGETS = '{"debug":2600}';
      const r = assembleContext(index, { task, adaptiveBudget: true, categoryOverride: "debug" });
      expect(r.contextPackage.budget?.tokens).toBe(2600);
    });
  });

  describe("retrieval stops when weak matches add no evidence", () => {
    it("keeps only the best file at ratio 1 and reports the rest as low_relevance", () => {
      const all = retrieveContext(index, task, { tokenBudget: 20000, fileBudget: 20 });
      const strict = retrieveContext(index, task, {
        tokenBudget: 20000,
        fileBudget: 20,
        minScoreRatio: 1,
        minFiles: 1,
      });
      expect(all.matchedFiles.length).toBeGreaterThan(2);
      expect(strict.matchedFiles).toHaveLength(1);
      expect(strict.matchedFiles[0].file.relativePath).toBe(all.matchedFiles[0].file.relativePath);
      expect(strict.matchedFiles[0].file.relativePath).toBe("src/billing/invoice.ts");
      const dropped = all.matchedFiles.slice(1).map((m) => m.file.relativePath);
      const reported = strict.omissions
        .filter((o) => o.reason === "low_relevance")
        .map((o) => o.identifier);
      for (const p of dropped) expect(reported, p).toContain(p);
      expect(strict.omissionsTotal).toBeGreaterThanOrEqual(dropped.length);
    });

    it("never goes below minFiles, however weak the extra matches are", () => {
      const r = retrieveContext(index, task, {
        tokenBudget: 20000,
        fileBudget: 20,
        minScoreRatio: 1,
        minFiles: 3,
      });
      expect(r.matchedFiles).toHaveLength(3);
    });

    it("ignores a non-positive or non-finite ratio (exhaustive, as before)", () => {
      const all = retrieveContext(index, task, { tokenBudget: 20000, fileBudget: 20 });
      for (const minScoreRatio of [0, -1, Number.NaN, Number.NEGATIVE_INFINITY]) {
        const r = retrieveContext(index, task, {
          tokenBudget: 20000,
          fileBudget: 20,
          minScoreRatio,
        });
        expect(
          r.matchedFiles.map((m) => m.file.relativePath),
          String(minScoreRatio)
        ).toEqual(all.matchedFiles.map((m) => m.file.relativePath));
      }
    });

    it("adaptive packages never add files, never lose the best one, and cost no more", () => {
      const exhaustive = assembleContext(index, {
        task,
        tokenBudget: 4000,
        categoryOverride: "debug",
      });
      const adaptive = assembleContext(index, {
        task,
        adaptiveBudget: true,
        categoryOverride: "debug",
      });
      const exhaustiveFiles = exhaustive.contextPackage.sourceReferences.map((s) => s.relativePath);
      const adaptiveFiles = adaptive.contextPackage.sourceReferences.map((s) => s.relativePath);
      expect(adaptiveFiles[0]).toBe(exhaustiveFiles[0]);
      expect(adaptiveFiles[0]).toBe("src/billing/invoice.ts");
      for (const f of adaptiveFiles) expect(exhaustiveFiles).toContain(f);
      expect(adaptive.contextPackage.tokenMetrics.estimatedTokens).toBeLessThanOrEqual(
        exhaustive.contextPackage.tokenMetrics.estimatedTokens
      );
      // Anything the adaptive package left out is listed with a reason.
      const missing = exhaustiveFiles.filter((f) => !adaptiveFiles.includes(f));
      const listed = new Set(adaptive.contextPackage.omissions.map((o) => o.identifier));
      for (const f of missing) expect(listed.has(f), f).toBe(true);
    });
  });

  describe("a tight budget shortens the best source instead of dropping everything", () => {
    it("returns one shortened source with a range that matches the text and says so", () => {
      const r = assembleContext(index, {
        task,
        tokenBudget: 1500,
        categoryOverride: "debug",
        fileBudget: 1,
      });
      const refs = r.contextPackage.sourceReferences;
      expect(refs).toHaveLength(1);
      const ref = refs[0];
      expect(ref.relativePath).toBe("src/billing/invoice.ts");
      const shownLines = ref.content.split("\n").length;
      expect(shownLines).toBeLessThan(bigFunctionLines);
      expect(ref.endLine).toBe((ref.startLine as number) + shownLines - 1);
      // The text really is that range of the file, on whole lines.
      const fileLines = fs.readFileSync(path.join(root, ref.relativePath), "utf8").split("\n");
      expect(ref.content.split("\n")).toEqual(
        fileLines.slice((ref.startLine as number) - 1, ref.endLine)
      );
      expect(r.contextPackage.knownLimitations.join(" ")).toContain("was shortened");
      expect(r.contextPackage.tokenMetrics.estimatedTokens).toBeLessThanOrEqual(1500);
    });

    it("does not claim a reduction when nothing was cut", () => {
      const r = assembleContext(index, { task, tokenBudget: 12000, categoryOverride: "debug" });
      expect(r.contextPackage.knownLimitations.join(" ")).not.toContain("shortened");
      expect(r.contextPackage.knownLimitations.join(" ")).not.toContain("reduced to fit");
    });

    it("still keeps the task verbatim", () => {
      const longTask = `${task} ${"and be careful about rounding ".repeat(5)}`.trim();
      const r = assembleContext(index, {
        task: longTask,
        tokenBudget: 1500,
        categoryOverride: "debug",
      });
      expect(r.renderedPrompt).toContain(longTask);
    });
  });

  describe("kai_get_context over MCP", () => {
    it("starts from the task default when no budget is passed and reports it", async () => {
      const r = await callTool(root, "kai_get_context", {
        task,
        categoryOverride: "debug",
      });
      expect(r.text).toContain(
        "**Budget**: ~3000 tokens (debug default; pass tokenBudget to change)"
      );
    });

    it("honours an explicit tokenBudget over the task default", async () => {
      const r = await callTool(root, "kai_get_context", {
        task,
        categoryOverride: "debug",
        tokenBudget: 5000,
      });
      expect(r.text).toContain("**Budget**: ~5000 tokens (requested)");
      expect(r.text).not.toContain("default; pass tokenBudget");
    });

    it("uses a smaller default package for a lookup than for a refactor of the same code", async () => {
      const lookup = await callTool(root, "kai_get_context", {
        task,
        categoryOverride: "explain",
      });
      const refactor = await callTool(root, "kai_get_context", {
        task,
        categoryOverride: "refactor",
      });
      expect(lookup.text).toContain("**Budget**: ~1700 tokens");
      expect(refactor.text).toContain("**Budget**: ~4000 tokens");
      expect(lookup.text.length).toBeLessThan(refactor.text.length);
      // The lookup still answers: it contains the target function.
      expect(lookup.text).toContain("computeInvoiceTotal");
    });
  });
});
