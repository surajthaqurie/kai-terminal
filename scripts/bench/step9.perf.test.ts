/**
 * Step 9 — evidence-based performance benchmarks.
 *
 * ISOLATED TOOLING: this file lives under scripts/bench and is never
 * imported by application code. It measures the nine workloads listed in
 * the Step 9 brief and prints before/after tables. Run with:
 *
 *   npx vitest run scripts/bench/step9.perf.test.ts
 *   KAI_PERF_FULL=1 npx vitest run scripts/bench/step9.perf.test.ts
 */
import { describe, it, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { execFileSync } from "child_process";
import { performance } from "perf_hooks";
import { registerProject } from "../../src/core/registry";
import { indexProject, matchesIgnorePattern } from "../../src/core/indexer";
import { retrieveContext } from "../../src/core/retrieval";
import { assembleContext } from "../../src/core/contextAssembler";
import { classifyTask } from "../../src/core/classifier";
import { estimateTokens, truncateToTokenBudget } from "../../src/core/tokenCounter";
import { handleMcpMessage } from "../../src/core/mcp";
import { gitCacheKey, getCachedGitInfo, setCachedGitInfo } from "../../src/services/projectService";

const FULL = process.env.KAI_PERF_FULL === "1";

function createRepo(base: string, name: string, fileCount: number): string {
  const repoDir = path.join(base, name);
  fs.mkdirSync(path.join(repoDir, "src"), { recursive: true });
  for (let i = 0; i < fileCount; i++) {
    const filePath = path.join(repoDir, "src", `module_${i}.ts`);
    const content = `export interface Item${i} { id: number; name: string; }\nexport function processItem${i}(item: Item${i}): string { return "processed_" + item.id; }\nexport class Service${i} { execute() { return processItem${i}({ id: ${i}, name: "test" }); } }\n`;
    fs.writeFileSync(filePath, content);
  }
  return repoDir;
}

function timeSync<T>(fn: () => T): { result: T; ms: number } {
  const t0 = performance.now();
  const result = fn();
  return { result, ms: performance.now() - t0 };
}

async function timeAsync<T>(fn: () => Promise<T>): Promise<{ result: T; ms: number }> {
  const t0 = performance.now();
  const result = await fn();
  return { result, ms: performance.now() - t0 };
}

describe("Step 9 performance matrix", () => {
  let tmpDir: string;
  let savedKaiHome: string | undefined;
  const rows: Array<Record<string, string | number>> = [];

  beforeEach(() => {
    savedKaiHome = process.env.KAI_HOME;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-step9-"));
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

  it("measures all workloads", async () => {
    // ---- 1. Application startup (cold registry open) ----
    {
      const { ms } = timeSync(() => {
        const meta = registerProject(process.cwd());
        void meta;
      });
      // Use an isolated dir so registration cost is measured without touching real state.
      const iso = path.join(tmpDir, "startup-probe");
      fs.mkdirSync(iso, { recursive: true });
      const t1 = timeSync(() => registerProject(iso));
      rows.push({
        workload: "startup: registerProject (isolated)",
        ms: Math.round(t1.ms * 100) / 100,
      });
      rows.push({ workload: "startup: registerProject (cwd)", ms: Math.round(ms * 100) / 100 });
    }

    // ---- 2/3/4. Cold, incremental, and large-repo indexing ----
    const tiers = FULL
      ? [
          { name: "small", count: 15 },
          { name: "medium", count: 100 },
          { name: "large", count: 400 },
          { name: "xlarge", count: 1000 },
        ]
      : [
          { name: "small", count: 15 },
          { name: "medium", count: 100 },
          { name: "large", count: 400 },
        ];
    let mediumRepo = "";
    for (const tier of tiers) {
      const repoDir = createRepo(tmpDir, `repo_${tier.name}`, tier.count);
      if (tier.name === "medium") mediumRepo = repoDir;
      const meta = registerProject(repoDir);
      const cold = await timeAsync(() => indexProject(meta, { forceRebuild: true }));
      fs.appendFileSync(
        path.join(repoDir, "src", "module_0.ts"),
        "\nexport const EXTRA_FLAG = true;\n"
      );
      const incr = await timeAsync(() => indexProject(meta));
      rows.push({
        workload: `index cold (${tier.name}, ${tier.count} files)`,
        ms: Math.round(cold.ms),
      });
      rows.push({
        workload: `index incremental 1-file (${tier.name})`,
        ms: Math.round(incr.ms * 100) / 100,
      });
    }

    // ---- 5. Context assembly (includes classification + retrieval + render) ----
    {
      const meta = registerProject(mediumRepo);
      const index = await indexProject(meta, { forceRebuild: true });
      const asmTimes: number[] = [];
      for (let i = 0; i < 3; i++) {
        const t = timeSync(() =>
          assembleContext(index, {
            task: "Explain how Service5 executes processItem5",
            tokenBudget: 4000,
          })
        );
        asmTimes.push(t.ms);
      }
      asmTimes.sort((a, b) => a - b);
      rows.push({
        workload: "context assembly median x3 (100 files)",
        ms: Math.round(asmTimes[1] * 100) / 100,
      });
      const retTimes: number[] = [];
      for (let i = 0; i < 5; i++) {
        const r = timeSync(() =>
          retrieveContext(index, "Service5 processItem5 Item5", { tokenBudget: 4000 })
        );
        retTimes.push(r.ms);
      }
      retTimes.sort((a, b) => a - b);
      rows.push({
        workload: "retrieval median x5 (100 files)",
        ms: Math.round(retTimes[2] * 100) / 100,
      });
      const cLoop = timeSync(() => {
        for (let i = 0; i < 200; i++)
          classifyTask("Fix the crashing bug in the login handler", undefined);
      });
      rows.push({ workload: "classifyTask x200", ms: Math.round(cLoop.ms * 100) / 100 });
    }

    // ---- 6. Git status retrieval: cold subprocess vs cache hit ----
    {
      const repo = process.cwd();
      let coldMs = -1;
      try {
        const t0 = performance.now();
        execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: repo, stdio: "pipe" });
        execFileSync("git", ["status", "--porcelain"], { cwd: repo, stdio: "pipe" });
        coldMs = performance.now() - t0;
      } catch {
        coldMs = -1;
      }
      rows.push({
        workload: "git status cold (2 spawns, kai repo)",
        ms: Math.round(coldMs * 100) / 100,
      });
      const key = gitCacheKey(repo);
      setCachedGitInfo(repo, {
        branch: "main",
        dirty: false,
        ahead_behind: null,
        repo_root: repo,
        error: null,
      });
      const hit = timeSync(() => {
        for (let i = 0; i < 1000; i++) getCachedGitInfo(repo);
      });
      void key;
      rows.push({ workload: "git status cache hit x1000", ms: Math.round(hit.ms * 100) / 100 });
      // PATH-scan proxy for the backend git_binary_available() check.
      const pathScan = timeSync(() => {
        const pathEnv = process.env.PATH || "";
        let found = false;
        for (let i = 0; i < 20; i++) {
          for (const dir of pathEnv.split(path.delimiter)) {
            if (!dir) continue;
            try {
              const st = fs.statSync(path.join(dir, "git.exe"));
              if (st.isFile()) {
                found = true;
                break;
              }
            } catch {
              // ignore
            }
          }
        }
        return found;
      });
      rows.push({ workload: "git binary PATH scan x20", ms: Math.round(pathScan.ms * 100) / 100 });
    }

    // ---- 7. Terminal output throughput: string += vs chunk array ----
    {
      // ~10 MB flood so the 1 MB cap engages continuously (the real
      // `npm install` case), not just on the final chunk.
      const chunks: string[] = [];
      for (let i = 0; i < 20000; i++) chunks.push("x".repeat(512) + `line-${i}\r\n`);
      const concat = timeSync(() => {
        let pending = "";
        for (const c of chunks) {
          pending += c;
          if (pending.length > 1_048_576) pending = pending.slice(pending.length - 1_048_576);
        }
        return pending.length;
      });
      const buffered = timeSync(() => {
        const parts: string[] = [];
        let head = 0;
        let len = 0;
        for (const c of chunks) {
          parts.push(c);
          len += c.length;
          while (len > 1_048_576 && head < parts.length) {
            len -= parts[head].length;
            head++;
          }
          if (head > 4096) {
            parts.splice(0, head);
            head = 0;
          }
        }
        return parts.slice(head).join("").length;
      });
      rows.push({
        workload: "terminal flood: string += (20000x512B)",
        ms: Math.round(concat.ms * 100) / 100,
      });
      rows.push({
        workload: "terminal flood: chunk array (20000x512B)",
        ms: Math.round(buffered.ms * 100) / 100,
      });
      const { TerminalOutputBuffer } = await import("../../src/services/terminalOutputBuffer");
      const bufRun = timeSync(() => {
        const buf = new TerminalOutputBuffer();
        for (const c of chunks) buf.append(c);
        return buf.flush().length;
      });
      rows.push({
        workload: "terminal flood: TerminalOutputBuffer",
        ms: Math.round(bufRun.ms * 100) / 100,
      });
      // Tokenizer truncation cost on a large prompt-sized string.
      const big = "const x = 1;\n".repeat(20000);
      const trunc = timeSync(() => truncateToTokenBudget(big, 4000));
      const est = timeSync(() => estimateTokens(big));
      rows.push({
        workload: "truncateToTokenBudget (~260KB)",
        ms: Math.round(trunc.ms * 100) / 100,
      });
      rows.push({ workload: "estimateTokens (~260KB)", ms: Math.round(est.ms * 100) / 100 });
      rows.push({
        workload: "ignore matcher x1000",
        ms: (() => {
          const t = timeSync(() => {
            for (let i = 0; i < 1000; i++)
              matchesIgnorePattern("src/module_0.ts", "module_0.ts", [
                "*.log",
                "dist/",
                "build/*.js",
              ]);
          });
          return Math.round(t.ms * 100) / 100;
        })(),
      });
      // Realistic ignore list (globs + prefixes) as found in real .gitignore files.
      rows.push({
        workload: "ignore matcher realistic x2000",
        ms: (() => {
          const pats = [
            "*.log",
            "*.tmp",
            "dist/",
            "build/",
            "coverage/",
            ".next/",
            "*.test.js",
            "src/generated/*.ts",
            "docs/*.md",
            "*.map",
            ".turbo/",
            "out/",
            "vendor/",
            "*.min.js",
            "node_modules/",
            ".cache/",
            "*.bak",
            "tmp/",
            "logs/*.log",
            "public/build/*",
          ];
          const t = timeSync(() => {
            for (let i = 0; i < 2000; i++)
              matchesIgnorePattern("src/components/module_0.ts", "module_0.ts", pats);
          });
          return Math.round(t.ms * 100) / 100;
        })(),
      });
    }

    // ---- 8. Four concurrent sessions (retrieval + MCP proxies) ----
    {
      const meta = registerProject(mediumRepo);
      const index = await indexProject(meta, { forceRebuild: true });
      const t0 = performance.now();
      await Promise.all(
        [0, 1, 2, 3].map((i) =>
          Promise.resolve(
            retrieveContext(index, `processItem${i * 7} Service${i * 7}`, { tokenBudget: 4000 })
          )
        )
      );
      rows.push({
        workload: "4x concurrent retrieval",
        ms: Math.round((performance.now() - t0) * 100) / 100,
      });
      const t1 = performance.now();
      await Promise.all(
        [0, 1, 2, 3].map((i) =>
          handleMcpMessage(
            {
              jsonrpc: "2.0",
              id: i + 1,
              method: "tools/call",
              params: {
                name: "kai_search_code",
                arguments: { query: `Service${i * 11}`, projectPath: mediumRepo },
              },
            },
            mediumRepo
          )
        )
      );
      rows.push({
        workload: "4x concurrent MCP search",
        ms: Math.round((performance.now() - t1) * 100) / 100,
      });
    }

    // ---- 9a. MCP request processing ----
    {
      const tInit = timeSync(() =>
        handleMcpMessage({ jsonrpc: "2.0", id: "a", method: "initialize", params: {} }, mediumRepo)
      );
      const rInit = await tInit.result;
      void rInit;
      rows.push({ workload: "MCP initialize", ms: Math.round(tInit.ms * 1000) / 1000 });
      const tList = await timeAsync(() =>
        handleMcpMessage({ jsonrpc: "2.0", id: "b", method: "tools/list", params: {} }, mediumRepo)
      );
      rows.push({ workload: "MCP tools/list", ms: Math.round(tList.ms * 1000) / 1000 });
      const tSearch = await timeAsync(() =>
        handleMcpMessage(
          {
            jsonrpc: "2.0",
            id: "c",
            method: "tools/call",
            params: {
              name: "kai_search_code",
              arguments: { query: "Service5", projectPath: mediumRepo },
            },
          },
          mediumRepo
        )
      );
      rows.push({ workload: "MCP kai_search_code", ms: Math.round(tSearch.ms * 100) / 100 });
      const tCtx = await timeAsync(() =>
        handleMcpMessage(
          {
            jsonrpc: "2.0",
            id: "d",
            method: "tools/call",
            params: {
              name: "kai_get_context",
              arguments: { task: "Explain Service5", projectPath: mediumRepo },
            },
          },
          mediumRepo
        )
      );
      rows.push({ workload: "MCP kai_get_context", ms: Math.round(tCtx.ms * 100) / 100 });
    }

    // ---- 9b. Shutdown and process cleanup ----
    {
      const meta = registerProject(mediumRepo);
      const t0 = performance.now();
      const { deleteProjectData, getProjectStorageDir } = await import("../../src/core/registry");
      const storageDir = getProjectStorageDir(meta.id);
      void storageDir;
      const del = deleteProjectData(meta.id);
      void del;
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-step9b-"));
      process.env.KAI_HOME = path.join(tmpDir, "kai_home");
      rows.push({
        workload: "shutdown: deleteProjectData + tmp cleanup",
        ms: Math.round((performance.now() - t0) * 100) / 100,
      });
      const leftovers: string[] = [];
      try {
        const home = process.env.KAI_HOME;
        const walk = (d: string) => {
          for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const p = path.join(d, e.name);
            if (e.isDirectory()) walk(p);
            else if (e.name.endsWith(".tmp")) leftovers.push(p);
          }
        };
        if (fs.existsSync(home)) walk(home);
      } catch {
        // ignore
      }
      rows.push({ workload: "shutdown: stray .tmp files", ms: leftovers.length });
    }

    console.log("\n==== Step 9 performance matrix ====");
    console.table(rows);
    try {
      const outDir = path.join(process.cwd(), "scripts", "bench", "results");
      fs.mkdirSync(outDir, { recursive: true });
      const out = path.join(outDir, `step9-${Date.now()}.json`);
      fs.writeFileSync(
        out,
        JSON.stringify({ ts: new Date().toISOString(), full: FULL, rows }, null, 2)
      );
      console.log(`results written to ${out}`);
    } catch (e) {
      console.log(`could not write results json: ${String(e)}`);
    }

    // Golden parity probes (used by the regression test).
    console.log(
      "GOLDEN classify debug:",
      classifyTask("Fix the crashing bug in the login handler", undefined).category
    );
    console.log(
      "GOLDEN classify test:",
      classifyTask("Write unit tests for the login handler", undefined).category
    );
    console.log("GOLDEN classify unknown:", classifyTask("blorple zzzqqq", undefined).category);
    console.log(
      "GOLDEN truncate len:",
      truncateToTokenBudget("const x = 1;\n".repeat(20000), 4000).text.length
    );
    console.log(
      "GOLDEN ignore node_modules:",
      matchesIgnorePattern("node_modules/foo/index.js", "index.js", ["node_modules/"])
    );
  }, 180000);
});
