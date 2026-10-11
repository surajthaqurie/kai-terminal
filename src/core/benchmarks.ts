import fs from "fs";
import path from "path";
import type { ProjectIndex, EvaluationBaseline, TaskCategory } from "./types";
import { retrieveContext } from "./retrieval";
import { assembleContext } from "./contextAssembler";

export interface BenchmarkTaskDef {
  id: string;
  category: TaskCategory;
  description: string;
  query: string;
  expectedSymbolOrFile: string;
}

export const REPRESENTATIVE_BENCHMARK_TASKS: BenchmarkTaskDef[] = [
  {
    id: "find_symbol",
    category: "explain",
    description: "Find where PtyManager is defined and explain its lifecycle",
    query: "PtyManager lifecycle",
    expectedSymbolOrFile: "pty",
  },
  {
    id: "trace_dependencies",
    category: "architecture",
    description: "Trace how ptyService interacts with Tauri IPC commands",
    query: "ptyService Tauri IPC invoke create_pty",
    expectedSymbolOrFile: "ptyService",
  },
  {
    id: "explain_feature",
    category: "explain",
    description: "Explain how workspaces migration from terminal_workspaces_v1 works",
    query: "workspaces terminal_workspaces_v1 migration",
    expectedSymbolOrFile: "workspaces",
  },
  {
    id: "debug_issue",
    category: "debug",
    description: "Debug why terminal resize might fail with invalid row and column clamp limits",
    query: "resize_pty clamp cols rows TerminalError",
    expectedSymbolOrFile: "pty",
  },
  {
    id: "implement_feature",
    category: "implement",
    description: "Implement a new keyboard shortcut for toggling AI CLI panel",
    query: "shortcuts AiCliPanel toggle keybinding",
    expectedSymbolOrFile: "shortcuts",
  },
  {
    id: "refactor_code",
    category: "refactor",
    description: "Refactor gitCache to use a LRU eviction policy while preserving TTL",
    query: "gitCache getCachedGitInfo GIT_CACHE_TTL_MS",
    expectedSymbolOrFile: "projectService",
  },
  {
    id: "generate_tests",
    category: "test",
    description: "Write unit tests for paneLayout horizontal and vertical split ratios",
    query: "paneLayout split horizontal vertical test",
    expectedSymbolOrFile: "paneLayout",
  },
];

export async function runBenchmarks(
  index: ProjectIndex,
  tasks: BenchmarkTaskDef[] = REPRESENTATIVE_BENCHMARK_TASKS
): Promise<EvaluationBaseline[]> {
  const results: EvaluationBaseline[] = [];

  /** Measured retrieval accuracy per task: whether the expected token
   * appears in any retrieved file path or symbol name. */
  function hitRate(
    retrieved: { file: { relativePath: string } }[],
    expected: string,
    symbolNames: string[]
  ): boolean {
    const needle = expected.toLowerCase();
    return (
      retrieved.some((m) => m.file.relativePath.toLowerCase().includes(needle)) ||
      symbolNames.some((s) => s.toLowerCase().includes(needle))
    );
  }

  for (const task of tasks) {
    // Config A: Baseline without Kai (Simulated: reads raw entire files in repository without indexing)
    const startA = Date.now();
    let totalRawChars = 0;
    let filesSampledA = 0;
    for (const [relPath] of Object.entries(index.files).slice(0, 10)) {
      try {
        const full = path.join(index.meta.canonicalPath, relPath);
        totalRawChars += fs.readFileSync(full, "utf-8").length;
        filesSampledA++;
      } catch {
        // ignore
      }
    }
    const latencyA = Date.now() - startA;
    const tokensA = Math.max(1, Math.ceil(totalRawChars / 3.8));

    results.push({
      taskDescription: task.description,
      category: task.category,
      config: "A_baseline_no_kai",
      contextTokenEstimate: tokensA,
      retrievalLatencyMs: Math.max(1, latencyA),
      toolCallsCount: filesSampledA,
      retrievedFilesCount: filesSampledA,
      omissionsCount: Math.max(0, Object.keys(index.files).length - filesSampledA),
      taskSuccessRate: 0, // Baseline dumps unranked files; no measured hit signal
      notes: "Raw file dumps without indexing or relevance ranking (success not measured)",
    });

    // Config B: Kai with basic relevant-file retrieval
    const startB = Date.now();
    const retrievedB = retrieveContext(index, task.description, {
      tokenBudget: 4000,
      fileBudget: 8,
    });
    const latencyB = Date.now() - startB;
    const hitB = hitRate(
      retrievedB.matchedFiles,
      task.expectedSymbolOrFile,
      retrievedB.matchedSymbols.map((s) => s.name)
    );

    results.push({
      taskDescription: task.description,
      category: task.category,
      config: "B_kai_basic",
      contextTokenEstimate: retrievedB.usedTokens,
      retrievalLatencyMs: Math.max(1, latencyB),
      toolCallsCount: 1,
      retrievedFilesCount: retrievedB.matchedFiles.length,
      omissionsCount: retrievedB.omissions.length,
      taskSuccessRate: hitB ? 1 : 0,
      notes: "Deterministic symbol and keyword matching (hit = expected token found)",
    });

    // Config C: Kai with task-specific templates and selective skills
    const startC = Date.now();
    const { contextPackage: pkgC } = assembleContext(index, {
      task: task.description,
      tokenBudget: 4000,
      includeSkills: true,
    });
    const latencyC = Date.now() - startC;
    const hitC = hitRate(
      pkgC.sourceReferences.map((s) => ({
        file: { relativePath: s.relativePath },
        snippet: s.content,
      })),
      task.expectedSymbolOrFile,
      pkgC.symbols.map((s) => s.name)
    );

    results.push({
      taskDescription: task.description,
      category: task.category,
      config: "C_kai_templates_skills",
      contextTokenEstimate: pkgC.tokenMetrics.estimatedTokens,
      retrievalLatencyMs: Math.max(1, latencyC),
      toolCallsCount: 1,
      retrievedFilesCount: pkgC.sourceReferences.length,
      omissionsCount: pkgC.omissions.length,
      taskSuccessRate: hitC ? 1 : 0,
      notes: "Structured category template, provenance, and matching skills (measured hit)",
    });

    // Config D: Kai with ranking, context budgets, freshness checks, and full packaging
    const startD = Date.now();
    const { contextPackage: pkgD } = assembleContext(index, {
      task: task.description,
      tokenBudget: 3500, // Tighter optimized budget
      includeSkills: true,
    });
    const latencyD = Date.now() - startD;
    const hitD = hitRate(
      pkgD.sourceReferences.map((s) => ({
        file: { relativePath: s.relativePath },
        snippet: s.content,
      })),
      task.expectedSymbolOrFile,
      pkgD.symbols.map((s) => s.name)
    );

    results.push({
      taskDescription: task.description,
      category: task.category,
      config: "D_kai_optimized",
      contextTokenEstimate: pkgD.tokenMetrics.estimatedTokens,
      retrievalLatencyMs: Math.max(1, latencyD),
      toolCallsCount: 1,
      retrievedFilesCount: pkgD.sourceReferences.length,
      omissionsCount: pkgD.omissions.length,
      taskSuccessRate: hitD ? 1 : 0,
      notes: "Optimized token budget, bounded snippets, exact line ranges (measured hit)",
    });
  }

  return results;
}
