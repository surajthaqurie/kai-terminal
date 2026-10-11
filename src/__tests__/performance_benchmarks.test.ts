import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { performance } from "perf_hooks";
import { registerProject, getProjectStorageDir } from "../core/registry";
import { indexProject } from "../core/indexer";
import { retrieveContext } from "../core/retrieval";

describe("Phase 4: Empirical Performance and Resource Limits", () => {
  let tmpDir: string;
  let savedKaiHome: string | undefined;

  beforeEach(() => {
    savedKaiHome = process.env.KAI_HOME;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-perf-test-"));
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

  function createRepo(name: string, fileCount: number): string {
    const repoDir = path.join(tmpDir, name);
    fs.mkdirSync(path.join(repoDir, "src"), { recursive: true });
    for (let i = 0; i < fileCount; i++) {
      const filePath = path.join(repoDir, "src", `module_${i}.ts`);
      const content = `
export interface Item${i} { id: number; name: string; }
export function processItem${i}(item: Item${i}): string { return "processed_" + item.id; }
export class Service${i} { execute() { return processItem${i}({ id: ${i}, name: "test" }); } }
`;
      fs.writeFileSync(filePath, content);
    }
    return repoDir;
  }

  it("benchmarks small (15 files), medium (100 files), and large (400 files) repositories", async () => {
    const tiers = [
      { name: "Small", count: 15 },
      { name: "Medium", count: 100 },
      { name: "Large", count: 400 },
    ];

    const measurements: Array<Record<string, unknown>> = [];

    for (const tier of tiers) {
      const repoDir = createRepo(`repo_${tier.name.toLowerCase()}`, tier.count);
      const meta = registerProject(repoDir);

      // 1. Initial Indexing Time
      const t0 = performance.now();
      const index1 = await indexProject(meta, { forceRebuild: true });
      const tInitialMs = Math.round(performance.now() - t0);

      // 2. Incremental Indexing Time (1 file modified)
      fs.appendFileSync(
        path.join(repoDir, "src", "module_0.ts"),
        "\nexport const EXTRA_FLAG = true;\n"
      );
      const t1 = performance.now();
      const index2 = await indexProject(meta);
      const tIncrementalMs = Math.round(performance.now() - t1);

      // 3. Retrieval Latency
      const t2 = performance.now();
      const retrieved = retrieveContext(index2, "Service0 processItem0 Item0", {
        tokenBudget: 4000,
      });
      const tRetrievalMs = Math.round((performance.now() - t2) * 100) / 100;

      // 4. Index Size on Disk
      const storageDir = getProjectStorageDir(meta.id);
      const indexStat = fs.statSync(path.join(storageDir, "index.json"));
      const indexSizeKb = Math.round(indexStat.size / 1024);

      // 5. Concurrent Requests (20 parallel retrieval calls)
      const concStart = performance.now();
      const concurrentQueries = Array.from({ length: 20 }, (_, i) =>
        retrieveContext(index2, `processItem${i % 10}`, { tokenBudget: 4000 })
      );
      const concurrentResults = await Promise.all(concurrentQueries);
      const tConcurrent20Ms = Math.round(performance.now() - concStart);

      const mem = process.memoryUsage();
      const heapUsedMb = Math.round(mem.heapUsed / 1024 / 1024);

      expect(index1.meta.fileCount).toBe(tier.count);
      expect(retrieved.matchedFiles.length).toBeGreaterThan(0);
      expect(concurrentResults.length).toBe(20);

      measurements.push({
        Tier: `${tier.name} (${tier.count} files)`,
        "Initial Index (ms)": tInitialMs,
        "Incremental Index (ms)": tIncrementalMs,
        "Retrieval Latency (ms)": tRetrievalMs,
        "Index Size (KB)": indexSizeKb,
        "20 Concurrent Queries (ms)": tConcurrent20Ms,
        "Heap Used (MB)": heapUsedMb,
      });
    }

    console.log("\n========================================================");
    console.log("Empirical Repository Scale & Performance Benchmarks");
    console.log("========================================================");
    console.table(measurements);
  }, 30000);
});
