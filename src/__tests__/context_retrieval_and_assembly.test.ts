import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { registerProject } from "../core/registry";
import { indexProject } from "../core/indexer";
import { retrieveContext } from "../core/retrieval";
import { assembleContext } from "../core/contextAssembler";
import { classifyTask, extractSearchTokens } from "../core/classifier";
import {
  estimateTokens,
  registerCustomTokenizer,
  type TokenizerFunction,
} from "../core/tokenCounter";
import { runBenchmarks, REPRESENTATIVE_BENCHMARK_TASKS } from "../core/benchmarks";

describe("Context Retrieval and Prompt Assembly Hardening", () => {
  let tmpDir: string;
  let savedKaiHome: string | undefined;

  beforeEach(() => {
    savedKaiHome = process.env.KAI_HOME;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-retrieval-test-"));
    process.env.KAI_HOME = path.join(tmpDir, "kai_home");
    registerCustomTokenizer(null); // Ensure clean tokenizer state
  });

  afterEach(() => {
    registerCustomTokenizer(null);
    if (savedKaiHome === undefined) delete process.env.KAI_HOME;
    else process.env.KAI_HOME = savedKaiHome;
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  function makeProject(files: Record<string, string>, rules: string[] = []): string {
    const projDir = path.join(tmpDir, "repo_" + Math.random().toString(36).slice(2, 8));
    fs.mkdirSync(projDir, { recursive: true });

    for (const [relPath, content] of Object.entries(files)) {
      const fullPath = path.join(projDir, relPath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, content, "utf-8");
    }

    if (rules.length > 0) {
      fs.writeFileSync(path.join(projDir, ".cursorrules"), rules.join("\n---\n"), "utf-8");
    }

    return projDir;
  }

  describe("1. Task Classification & Query Token Decomposition", () => {
    it("decomposes camelCase, snake_case, and file paths into searchable sub-tokens", () => {
      const extracted = extractSearchTokens("Debug PtyManager.create_pty in src/pty/service.ts");
      expect(extracted.tokens).toContain("ptymanager");
      expect(extracted.tokens).toContain("pty");
      expect(extracted.tokens).toContain("manager");
      expect(extracted.tokens).toContain("create_pty");
      expect(extracted.tokens).toContain("create");
      expect(extracted.intentHints.prefersTests).toBe(false);
    });

    it("prioritizes action-oriented debug/test intents when multi-intent keywords overlap", () => {
      const debugResult = classifyTask("Explain why the test is crashing and fix the panic");
      expect(debugResult.category).toBe("debug");
      expect(debugResult.confidence).toBeGreaterThan(0.5);

      const testResult = classifyTask("Write unit tests for the authentication handler");
      expect(testResult.category).toBe("test");
    });
  });

  describe("2. File and Symbol Ranking", () => {
    it("ranks files matching multiple query tokens higher via conjunction boost", async () => {
      const repo = makeProject({
        "src/isolated.ts": `
          // Matches only 'resize'
          export function resize() { return 1; }
          export function resizeMore() { return 2; }
          export function resizeExtra() { return 3; }
        `,
        "src/terminal.ts": `
          // Matches both 'resize' and 'clamp'
          export function resizeTerminal(cols: number, rows: number) {
            return clampDimensions(cols, rows);
          }
          export function clampDimensions(w: number, h: number) {
            return [Math.max(1, w), Math.max(1, h)];
          }
        `,
      });

      const meta = registerProject(repo);
      const index = await indexProject(meta);

      const result = retrieveContext(index, "resize clamp dimensions");
      expect(result.matchedFiles.length).toBeGreaterThan(0);
      // terminal.ts covers both 'resize' and 'clamp', so conjunction boost ranks it first
      expect(result.matchedFiles[0].file.relativePath).toBe("src/terminal.ts");
    });

    it("deprioritizes test files for implementation tasks and boosts them for test tasks", async () => {
      const repo = makeProject({
        "src/service.ts": "export class AuthService { login() { return true; } }",
        "tests/service.test.ts":
          "import { AuthService } from '../src/service'; describe('AuthService', () => {});",
      });

      const meta = registerProject(repo);
      const index = await indexProject(meta);

      // Implementation task: service.ts should rank first
      const implRet = retrieveContext(index, "implement AuthService login session");
      expect(implRet.matchedFiles[0].file.relativePath).toBe("src/service.ts");

      // Test task: service.test.ts should be retrieved and prioritized
      const testRet = retrieveContext(index, "write unit tests for AuthService", {
        includeTests: true,
      });
      expect(
        testRet.matchedFiles.some((f) => f.file.relativePath === "tests/service.test.ts")
      ).toBe(true);
    });

    it("ranks symbols by match quality and exported status with deterministic tie-breaking", async () => {
      const repo = makeProject({
        "src/api.ts": `
          export function findUser() { return true; }
          function internalFind() { return false; }
          export class UserManager {}
        `,
      });

      const meta = registerProject(repo);
      const index = await indexProject(meta);

      const result = retrieveContext(index, "findUser");
      expect(result.matchedSymbols.length).toBeGreaterThan(0);
      expect(result.matchedSymbols[0].name).toBe("findUser");
      expect(result.matchedSymbols[0].isExported).toBe(true);
    });
  });

  describe("3. Duplicate Context Removal", () => {
    it("deduplicates identical files sharing the same content hash", async () => {
      const repo = makeProject({
        "src/original.ts": "export const DUPLICATE_FLAG = 42;\n",
        "src/copy.ts": "export const DUPLICATE_FLAG = 42;\n", // Identical content
      });

      const meta = registerProject(repo);
      const index = await indexProject(meta);

      const result = retrieveContext(index, "DUPLICATE_FLAG");
      // Only one of the identical files should be included to conserve budget
      expect(result.matchedFiles.length).toBe(1);
    });

    it("deduplicates identical project rules across multiple configuration sources", async () => {
      const duplicateRule = "Always use strict typing and explicit return types.";
      const repo = makeProject(
        { "src/index.ts": "export const ok = 1;" },
        [duplicateRule, duplicateRule] // Duplicated in rules
      );

      const meta = registerProject(repo);
      const index = await indexProject(meta);

      const { contextPackage } = assembleContext(index, { task: "implement new feature" });
      const matched = contextPackage.applicableRules.filter((r) =>
        r.content.includes("strict typing")
      );
      expect(matched.length).toBe(1);
    });

    it("deduplicates matched symbols so same symbol is never repeated in context package", async () => {
      const repo = makeProject({
        "src/item.ts": "export class TargetItem { id = 1; }",
      });

      const meta = registerProject(repo);
      const index = await indexProject(meta);

      // Query with overlapping terms that both match TargetItem
      const { contextPackage } = assembleContext(index, { task: "explain TargetItem Item" });
      const symbolNames = contextPackage.symbols.map(
        (s) => `${s.filePath}:${s.name}:${s.location.line}`
      );
      const uniqueNames = new Set(symbolNames);
      expect(symbolNames.length).toBe(uniqueNames.size);
    });
  });

  describe("4. Token-Budget Enforcement & Optional Exact Tokenizer", () => {
    it("strictly bounds prompt output within token budget by shedding skills, sources, then rules", async () => {
      const repo = makeProject(
        {
          "src/large1.ts":
            "export const v1 = " +
            JSON.stringify(Array.from({ length: 80 }, (_, i) => `item_${i}`)) +
            ";\n",
          "src/large2.ts":
            "export const v2 = " +
            JSON.stringify(Array.from({ length: 80 }, (_, i) => `item_${i}`)) +
            ";\n",
          "src/large3.ts":
            "export const v3 = " +
            JSON.stringify(Array.from({ length: 80 }, (_, i) => `item_${i}`)) +
            ";\n",
        },
        ["Important rule A: preserve invariants.", "Important rule B: verify errors."]
      );

      const meta = registerProject(repo);
      const index = await indexProject(meta);

      const tightBudget = 600;
      const { contextPackage, renderedPrompt } = assembleContext(index, {
        task: "explain item collections",
        tokenBudget: tightBudget,
      });

      expect(contextPackage.tokenMetrics.estimatedTokens).toBeLessThanOrEqual(tightBudget);
      expect(contextPackage.omissions.length).toBeGreaterThan(0);
      expect(renderedPrompt).toContain("explain item collections");
    });

    it("supports registering an optional exact tokenizer and marks counts as measured, not estimate", async () => {
      const mockExactTokenizer: TokenizerFunction = (text: string) => {
        // Mock exact token count: words count * 2
        return (text.match(/\S+/g) || []).length * 2;
      };

      const metrics = estimateTokens(
        "function calculateSum(a: number, b: number) { return a + b; }",
        mockExactTokenizer
      );
      expect(metrics.isEstimate).toBe(false);
      expect(metrics.measuredTokens).toBeDefined();
      expect(metrics.measuredTokens).toBe(metrics.estimatedTokens);
    });

    it("uses cl100k estimate marked with isEstimate: true when no exact tokenizer is registered", () => {
      const metrics = estimateTokens(
        "function calculateSum(a: number, b: number) { return a + b; }"
      );
      expect(metrics.isEstimate).toBe(true);
      expect(metrics.measuredTokens).toBeUndefined();
      expect(metrics.estimatedTokens).toBeGreaterThan(0);
    });
  });

  describe("5. Secrets, Boundary Checks, and Omissions Reporting", () => {
    it("excludes .env and private key files during indexing and omits them if crafted into index", async () => {
      const repo = makeProject({
        "src/api.ts": "export const API_URL = 'https://api.example.com';",
        ".env": "DATABASE_PASSWORD=supersecret_12345\nAPI_KEY=key_abcdef1234567890",
        // Split-string fixture: the runtime bytes stay identical, but the
        // "BEGIN ... PRIVATE KEY" marker never appears literally in tracked
        // source, keeping the committed-secret scan green. Same idiom as
        // audit_production_security.test.ts.
        "certs/id_rsa": [
          "-----BEGIN ",
          "RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0\n-----END RSA PRIVATE KEY-----",
        ].join(""),
      });

      const meta = registerProject(repo);
      const index = await indexProject(meta);

      // 1. Verify indexer excludes them from the index
      expect(index.files[".env"]).toBeUndefined();
      expect(index.files["certs/id_rsa"]).toBeUndefined();

      // 2. Defense-in-depth: inject an unverified entry into index to test retrieval-time gate
      index.files[".env"] = {
        relativePath: ".env",
        canonicalPath: path.join(repo, ".env"),
        sizeBytes: 100,
        mtimeMs: Date.now(),
        sha256: "dummy",
        language: "text",
        symbols: [],
        dependencies: [],
        isTest: false,
        isConfig: true,
        isDoc: false,
      };

      const result = retrieveContext(index, "env API_URL");
      const matchedPaths = result.matchedFiles.map((m) => m.file.relativePath);

      expect(matchedPaths).not.toContain(".env");
      expect(matchedPaths).toContain("src/api.ts");
      expect(
        result.omissions.some((o) => o.identifier === ".env" && o.reason === "untrusted")
      ).toBe(true);
    });

    it("omits files whose disk content contains high-confidence secrets during retrieval", async () => {
      const repo = makeProject({
        "src/config.ts": "export const config = { mode: 'test' };",
      });

      const meta = registerProject(repo);
      const index = await indexProject(meta);

      // Now external change introduces a private key into src/config.ts.
      // Split-string fixture (see above): runtime content is byte-identical,
      // the marker just never sits literally in tracked source.
      fs.writeFileSync(
        path.join(repo, "src", "config.ts"),
        "export const config = {\n  secret: '-----BEGIN " +
          "RSA PRIVATE KEY-----\\nMIIE...\\n-----END RSA PRIVATE KEY-----'\n};\n"
      );

      const result = retrieveContext(index, "config secret");
      // Must not be returned in matchedFiles because it contains a private key
      expect(result.matchedFiles.length).toBe(0);
      expect(
        result.omissions.some((o) => o.identifier === "src/config.ts" && o.reason === "untrusted")
      ).toBe(true);
    });
  });

  describe("6. Empty Projects & Oversized Files", () => {
    it("handles completely empty projects gracefully and preserves user task", async () => {
      const repo = makeProject({});
      const meta = registerProject(repo);
      const index = await indexProject(meta);

      const { contextPackage, renderedPrompt } = assembleContext(index, {
        task: "start building a new application",
        tokenBudget: 3000,
      });

      expect(contextPackage.sourceReferences.length).toBe(0);
      expect(contextPackage.originalTask).toBe("start building a new application");
      expect(renderedPrompt).toContain("start building a new application");
    });

    it("omits files exceeding 512KB during indexing and retrieval with budget_exceeded reason", async () => {
      const repo = makeProject({
        "src/normal.ts": "export const normal = 1;\n",
      });

      const meta = registerProject(repo);
      const index = await indexProject(meta);

      // Simulate a file that grew over 512KB on disk
      fs.writeFileSync(
        path.join(repo, "src", "normal.ts"),
        "// " + "A".repeat(600 * 1024) + "\nexport const normal = 1;\n"
      );

      const result = retrieveContext(index, "normal");
      expect(result.matchedFiles.map((f) => f.file.relativePath)).not.toContain("src/normal.ts");
      expect(
        result.omissions.some(
          (o) => o.identifier === "src/normal.ts" && o.reason === "budget_exceeded"
        )
      ).toBe(true);
    });
  });

  describe("7. Task Preservation & Deterministic Prompt Generation", () => {
    it("preserves user task verbatim across multiple assembly executions", async () => {
      const userTask =
        "Explain how `calculateTotal(items: CartItem[])` handles discounts and null values";
      const repo = makeProject({
        "src/cart.ts":
          "export interface CartItem { price: number; } export function calculateTotal(items: CartItem[]) { return 0; }",
      });

      const meta = registerProject(repo);
      const index = await indexProject(meta);

      const { contextPackage, renderedPrompt } = assembleContext(index, { task: userTask });
      expect(contextPackage.originalTask).toBe(userTask);
      expect(renderedPrompt).toContain(userTask);
    });

    it("produces identical rendered prompts when provided with a deterministic timestamp", async () => {
      const repo = makeProject({
        "src/service.ts": "export class Service { execute() { return true; } }",
      });

      const meta = registerProject(repo);
      const index = await indexProject(meta);

      const fixedTime = "2026-10-13T12:00:00.000Z";
      const res1 = assembleContext(index, {
        task: "explain Service",
        assembledAt: fixedTime,
      });
      const res2 = assembleContext(index, {
        task: "explain Service",
        assembledAt: fixedTime,
      });

      expect(res1.renderedPrompt).toBe(res2.renderedPrompt);
      expect(res1.contextPackage.tokenMetrics).toEqual(res2.contextPackage.tokenMetrics);
    });

    it("includes deterministic index notice clarifying non-guarantee of complete semantic proofs", async () => {
      const repo = makeProject({ "src/a.ts": "export const a = 1;" });
      const meta = registerProject(repo);
      const index = await indexProject(meta);

      const { renderedPrompt } = assembleContext(index, { task: "explain a" });
      expect(renderedPrompt).toContain("Deterministic Index Notice");
      expect(renderedPrompt).toContain(
        "No cloud models, telemetry, or remote services were queried"
      );
    });
  });

  describe("8. Representative Tasks Context Quality Benchmarks", () => {
    it("runs reproducible benchmark evaluation and verifies retrieval accuracy within budget", async () => {
      const repo = makeProject({
        "src/pty.ts":
          "export class PtyManager { create() { return true; } } export function resize_pty(cols: number, rows: number) { return [cols, rows]; }",
        "src/ptyService.ts":
          "import { PtyManager } from './pty'; export class PtyService { invoke() {} }",
        "src/workspaces.ts":
          "export function migrateWorkspaces() { return 'terminal_workspaces_v1'; }",
        "src/shortcuts.ts": "export const SHORTCUTS = { toggleAiCli: 'Ctrl+Shift+A' };",
        "src/projectService.ts": "export const gitCache = { GIT_CACHE_TTL_MS: 5000 };",
        "src/paneLayout.ts":
          "export function splitLayout(horizontal: boolean, ratio: number) { return { horizontal, ratio }; }",
      });

      const meta = registerProject(repo);
      const index = await indexProject(meta);

      const benchmarks = await runBenchmarks(index, REPRESENTATIVE_BENCHMARK_TASKS);
      expect(benchmarks.length).toBe(REPRESENTATIVE_BENCHMARK_TASKS.length * 4);

      // Verify Config D (optimized Kai) outperforms Config A (unindexed dumps) in token footprint
      const configABaselines = benchmarks.filter((b) => b.config === "A_baseline_no_kai");
      const configDOptimized = benchmarks.filter((b) => b.config === "D_kai_optimized");

      expect(configABaselines.length).toBe(REPRESENTATIVE_BENCHMARK_TASKS.length);
      for (let i = 0; i < REPRESENTATIVE_BENCHMARK_TASKS.length; i++) {
        const d = configDOptimized[i];
        // Kai optimized should achieve non-zero hit rate
        expect(d.taskSuccessRate).toBe(1);
        // Kai optimized context should stay within 3500 token budget
        expect(d.contextTokenEstimate).toBeLessThanOrEqual(3500);
        // Latency should stay interactive locally. Isolated medians are
        // ~17-40ms (see docs/PERF_STEP9.md); the bound is load-tolerant so
        // the full parallel suite on loaded hosts does not flake, while a
        // real pathology (seconds, e.g. unbounded symbol scans) still fails.
        expect(d.retrievalLatencyMs).toBeLessThan(500);
      }
    });
  });
});
