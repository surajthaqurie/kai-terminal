import { registerProject, loadProjectIndex } from "../../core/registry";
import { indexProject } from "../../core/indexer";
import { runBenchmarks } from "../../core/benchmarks";
import { executeAgentWorkflow } from "../agentWorkflow";

export async function runRun(args: string[]): Promise<number> {
  const sepIndex = args.indexOf("--");
  if (sepIndex === -1 || sepIndex === args.length - 1) {
    console.error(`[kai] Error: Usage: kai run [path] [--timeout-ms <ms>] -- <command> [args...]`);
    console.error(`Example: kai run -- <agent> -p "fix the login bug"`);
    return 1;
  }
  const head = args.slice(1, sepIndex);
  const cmdArgs = args.slice(sepIndex + 1);
  let targetPath = process.cwd();
  let timeoutMs: number | undefined;
  for (let i = 0; i < head.length; i++) {
    if (head[i] === "--timeout-ms" && i + 1 < head.length) {
      const parsed = Number(head[i + 1]);
      if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 86400000) {
        console.error(`[kai] Error: --timeout-ms must be a positive number of milliseconds.`);
        return 1;
      }
      timeoutMs = Math.floor(parsed);
      i++;
    } else if (!head[i].startsWith("-") && targetPath === process.cwd()) {
      targetPath = head[i];
    } else {
      console.error(`[kai] Error: Unknown option "${head[i]}" for kai run.`);
      return 1;
    }
  }
  return await executeAgentWorkflow(cmdArgs[0], targetPath, {
    commandArgs: cmdArgs.slice(1),
    timeoutMs,
  });
}

export async function runBench(args: string[]): Promise<number> {
  const targetPath = args[1] || process.cwd();
  const meta = registerProject(targetPath);
  let index = loadProjectIndex(meta.id);
  if (!index) {
    console.log(`[kai] Indexing project for benchmark...`);
    index = await indexProject(meta);
  }

  console.log(`[kai] Running evaluation benchmarks across 4 configurations...`);
  const benchmarks = await runBenchmarks(index);

  console.log(`\n================================================================================`);
  console.log(
    `Benchmark Evaluation Results (Sample size: ${benchmarks.length} task configurations)`
  );
  console.log(`================================================================================`);
  console.table(
    benchmarks.map((b) => ({
      Task: b.taskDescription.slice(0, 30) + "...",
      Config: b.config,
      "Est. Tokens": b.contextTokenEstimate,
      "Latency (ms)": b.retrievalLatencyMs,
      "Files In Context": b.retrievedFilesCount,
      Omissions: b.omissionsCount,
      "Retrieval Recall": `${Math.round(b.taskSuccessRate * 100)}%`,
    }))
  );
  console.log(
    `\nNote: Est. Tokens come from a character heuristic, not a model tokenizer. Retrieval Recall measures target symbol presence in context, not autonomous LLM task completion.`
  );
  return 0;
}
