#!/usr/bin/env node
/**
 * Black-box MCP retrieval benchmark (development only; never imported by src/).
 *
 * Drives a built Kai CLI bundle over stdio JSON-RPC and records, per call:
 * serialized UTF-8 response bytes (the full JSON-RPC line, so tool-result
 * wrappers and escaping are included), wall-clock latency, freshness/refresh
 * outcome and whether `index.json` was rewritten. Because it only speaks the
 * wire protocol it runs unchanged against an older bundle (baseline) and the
 * current one, on identical inputs.
 *
 *   node scripts/bench/mcp-response-bench.mjs --cli dist/cli/index.js \
 *        --label after --out scripts/bench/results/mcp-after.json [--repo .]
 *
 * Scenarios use a deterministic SYNTHETIC project (generated into a temp dir)
 * so before/after numbers are comparable; `--repo` additionally runs a small
 * REAL-project set (the given directory is only read, never written; the Kai
 * home is an isolated temp dir). Synthetic and real numbers are reported in
 * separate sections and must not be mixed.
 *
 * Numbers are bytes and milliseconds. Token counts are NOT measured here:
 * Kai has no real tokenizer and does not call a model.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const cliPath = path.resolve(opt("cli", "dist/cli/index.js"));
const label = opt("label", "run");
const outPath = opt("out", "");
const realRepo = opt("repo", "");

// ---------------------------------------------------------------- synthetic
const PROCESS_FILES = 400; // files each defining `process` -> large symbol result
const BARREL_IMPORTS = 900; // imports in one file -> large dependency list
const MODULES = 120;

function writeFile(root, rel, content) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function buildSynthetic(root) {
  for (let i = 0; i < MODULES; i++) {
    const next = (i + 1) % MODULES;
    writeFile(
      root,
      `src/modules/m${i}.ts`,
      [
        `import { helper${next} } from "./m${next}";`,
        `export const LIMIT_${i} = ${i};`,
        `export function helper${i}(`,
        `  value: number,`,
        `  options: { scale: number; offset: number },`,
        `): number {`,
        `  const scaled = value * options.scale;`,
        `  const shifted = scaled + options.offset;`,
        `  const result = helper${next}(shifted, options);`,
        `  return result;`,
        `}`,
        ``,
      ].join("\n")
    );
  }
  for (let i = 0; i < PROCESS_FILES; i++) {
    writeFile(
      root,
      `src/handlers/h${i}.ts`,
      [
        `export function process(`,
        `  input: string,`,
        `  flags: number,`,
        `): string {`,
        `  const trimmed = input.trim();`,
        `  const tag = "h${i}";`,
        `  return trimmed + tag + flags;`,
        `}`,
        `export function dispatch(input: string): string {`,
        `  return input + "${i}";`,
        `}`,
        ``,
      ].join("\n")
    );
  }
  const imports = [];
  for (let i = 0; i < BARREL_IMPORTS; i++) {
    imports.push(`import { item${i} } from "pkg-${i}/entry";`);
  }
  writeFile(root, "src/barrel.ts", imports.join("\n") + "\nexport const BARREL = 1;\n");
  // Target for range-vs-window comparison: a long function whose body is
  // well past the old fixed 60-line window around a matched symbol.
  const body = [];
  for (let i = 0; i < 70; i++) body.push(`  total += values[${i % 5}] * ${i};`);
  writeFile(
    root,
    "src/token_utils.ts",
    [
      `import { LIMIT_0 } from "./modules/m0";`,
      ``,
      `const rawTokens = 4;`,
      ``,
      `export function countWords(text: string): number {`,
      `  return text.split(/\\s+/).length;`,
      `}`,
      ``,
      `export function estimateTokens(`,
      `  values: number[],`,
      `  scale: number,`,
      `): number {`,
      `  let total = rawTokens + LIMIT_0;`,
      ...body,
      `  return total * scale;`,
      `}`,
      ``,
      `export function afterEstimate(): number {`,
      `  return 1;`,
      `}`,
      ``,
    ].join("\n")
  );
  // Content-rejected file: sensitive content (fake key shape) after indexing.
  writeFile(
    root,
    "src/fixture_keys.ts",
    `// test fixture with a fake credential shape\nexport const FAKE = "AKIA${"A".repeat(16)}";\n`
  );
  writeFile(root, "README.md", "# Synthetic project\n\nUsed for retrieval benchmarks.\n");
}

// ---------------------------------------------------------------- MCP client
function startServer(projectRoot, kaiHome) {
  const child = spawn(process.execPath, [cliPath, "mcp", "."], {
    cwd: projectRoot,
    env: { ...process.env, KAI_HOME: kaiHome },
    stdio: ["pipe", "pipe", "ignore"],
  });
  const rl = readline.createInterface({ input: child.stdout });
  const waiting = new Map();
  rl.on("line", (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    const w = waiting.get(msg.id);
    if (w) {
      waiting.delete(msg.id);
      w({ line, msg });
    }
  });
  let nextId = 1;
  const rpc = (method, params) =>
    new Promise((resolve) => {
      const id = nextId++;
      const t0 = process.hrtime.bigint();
      waiting.set(id, (r) => resolve({ ...r, ms: Number(process.hrtime.bigint() - t0) / 1e6 }));
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  return {
    rpc,
    close: () =>
      new Promise((resolve) => {
        child.on("exit", resolve);
        child.stdin.end();
        setTimeout(() => child.kill(), 3000).unref();
      }),
  };
}

function indexJsonPath(kaiHome) {
  const projects = path.join(kaiHome, "projects");
  if (!fs.existsSync(projects)) return null;
  const id = fs.readdirSync(projects)[0];
  return id ? path.join(projects, id, "index.json") : null;
}

function statSig(p) {
  try {
    const s = fs.statSync(p);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return "none";
  }
}

function parseText(r) {
  const c = r.msg.result && r.msg.result.content;
  if (!c || !c[0]) return { error: r.msg.error };
  const text = c[0].text;
  try {
    return { text, json: JSON.parse(text) };
  } catch {
    return { text };
  }
}

async function measuredCall(session, kaiHome, name, args) {
  const ip = indexJsonPath(kaiHome);
  const before = ip ? statSig(ip) : "none";
  const r = await session.rpc("tools/call", { name, arguments: args });
  const after = (indexJsonPath(kaiHome) && statSig(indexJsonPath(kaiHome))) || "none";
  const p = parseText(r);
  return {
    tool: name,
    args,
    ms: Math.round(r.ms * 100) / 100,
    wireBytes: Buffer.byteLength(r.line, "utf8"),
    freshness: p.json && p.json.freshness,
    refreshOutcome: p.json && p.json.refreshOutcome,
    indexRewritten: before !== "none" && before !== after,
    isError: !!r.msg.error,
    parsed: p,
  };
}

const slim = (c) => {
  const { parsed, ...rest } = c;
  return rest;
};

// ---------------------------------------------------------------- scenarios
async function runSynthetic() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kai-bench-proj-"));
  const kaiHome = fs.mkdtempSync(path.join(os.tmpdir(), "kai-bench-home-"));
  buildSynthetic(root);
  const s = startServer(root, kaiHome);
  const results = { project: { files: MODULES + PROCESS_FILES + 4 } };
  try {
    await s.rpc("initialize", {});
    const list = await s.rpc("tools/list", {});
    const tools = list.msg.result.tools.map((t) => t.name);
    results.toolsList = { bytes: Buffer.byteLength(list.line, "utf8"), tools };
    const has = (t) => tools.includes(t);

    // Cold index (first call registers + indexes)
    const t0 = Date.now();
    const info = await measuredCall(s, kaiHome, "kai_project_info", {});
    results.coldProjectInfo = { ...slim(info), coldMs: Date.now() - t0 };

    // 3. Repeated queries on an unchanged project (fresh-index behaviour)
    results.repeatedSearch = [];
    for (let i = 0; i < 6; i++) {
      const c = await measuredCall(s, kaiHome, "kai_search_code", { query: "estimateTokens" });
      results.repeatedSearch.push(slim(c));
    }

    // 1. Metadata-first vs source-inclusive search. `searchDefault` sends no
    // includeSource: older bundles return snippets, newer ones metadata only.
    results.searchDefault = slim(
      await measuredCall(s, kaiHome, "kai_search_code", {
        query: "estimateTokens truncation tokens",
        limit: 20,
      })
    );
    const withSource = await measuredCall(s, kaiHome, "kai_search_code", {
      query: "estimateTokens truncation tokens",
      limit: 20,
      includeSource: true,
    });
    results.searchSourceInclusive = slim(withSource);
    if (has("kai_read_range")) {
      const meta = await measuredCall(s, kaiHome, "kai_search_code", {
        query: "estimateTokens truncation tokens",
        limit: 20,
        includeSource: false,
      });
      results.searchMetadataOnly = slim(meta);
    }

    // 2. Targeted range vs fixed-window snippet for the same target function
    const targetFile = fs.readFileSync(path.join(root, "src/token_utils.ts"), "utf8").split("\n");
    const startIdx = targetFile.findIndex((l) => l.startsWith("export function estimateTokens"));
    const endIdx = targetFile.findIndex((l, i) => i > startIdx && l === "}");
    const functionText = targetFile.slice(startIdx, endIdx + 1).join("\n");
    const covers = (text) =>
      typeof text === "string" &&
      text.includes("export function estimateTokens") &&
      text.includes("return total * scale;");
    const sf = withSource.parsed.json && withSource.parsed.json.files;
    const hit = sf && sf.find((f) => (f.relativePath || f.path) === "src/token_utils.ts");
    results.rangeVsWindow = {
      targetFunctionBytes: Buffer.byteLength(functionText, "utf8"),
      targetFunctionLines: endIdx - startIdx + 1,
      fixedWindow: hit
        ? {
            snippetBytes: Buffer.byteLength(hit.snippet || "", "utf8"),
            coversWholeFunction: covers(hit.snippet),
            lines: [hit.startLine, hit.endLine],
          }
        : { found: false },
    };
    if (has("kai_read_range")) {
      const rr = await measuredCall(s, kaiHome, "kai_read_range", {
        filePath: "src/token_utils.ts",
        symbol: "estimateTokens",
      });
      const j = rr.parsed.json || {};
      results.rangeVsWindow.readRange = {
        wireBytes: rr.wireBytes,
        sourceBytes: Buffer.byteLength(j.source || "", "utf8"),
        coversWholeFunction: covers(j.source),
        lines: [j.startLine, j.endLine],
        status: j.status,
      };
    }

    // 4. Large symbol result sets: `dispatch` has a one-line signature in every
    // handler file; `process` has a wrapped (multi-line) signature in every
    // file, which exposes extraction recall separately from response size.
    const multi = await measuredCall(s, kaiHome, "kai_find_symbol", { name: "process" });
    const mj = multi.parsed.json || {};
    results.multilineSymbols = {
      ...slim(multi),
      definitionsInProject: PROCESS_FILES,
      reportedTotal: mj.total ?? mj.foundCount,
      returned: mj.returned ?? (mj.symbols && mj.symbols.length),
    };
    const sym = await measuredCall(s, kaiHome, "kai_find_symbol", { name: "dispatch" });
    const sj = sym.parsed.json || {};
    results.largeSymbols = {
      ...slim(sym),
      definitionsInProject: PROCESS_FILES,
      reportedTotal: sj.total ?? sj.foundCount,
      returned: sj.returned ?? (sj.symbols && sj.symbols.length),
      hasMore: sj.hasMore,
    };

    // 5. Large dependency list
    const deps = await measuredCall(s, kaiHome, "kai_get_dependencies", {
      filePath: "src/barrel.ts",
    });
    const dj = deps.parsed.json || {};
    results.largeDependencies = {
      ...slim(deps),
      importsInFile: BARREL_IMPORTS,
      reportedTotal: dj.total ?? dj.dependenciesCount,
      returned: dj.returned ?? (dj.dependencies && dj.dependencies.length),
      hasMore: dj.hasMore,
    };

    // 6. Context-budget enforcement
    results.contextBudget = [];
    for (const budget of [1000, 4000, 20000]) {
      const c = await measuredCall(s, kaiHome, "kai_get_context", {
        task: "explain how estimateTokens counts and why helper functions chain",
        tokenBudget: budget,
      });
      const m = c.parsed.text && c.parsed.text.match(/Estimated Tokens\*\*: ~(\d+)/);
      results.contextBudget.push({
        ...slim(c),
        tokenBudget: budget,
        reportedEstimatedTokens: m ? Number(m[1]) : null,
      });
    }

    // No tokenBudget: older bundles use a flat 4000, newer ones a task-aware default.
    results.contextDefaultBudget = [];
    for (const task of [
      "explain how estimateTokens counts",
      "fix a bug where helper functions chain forever",
    ]) {
      const c = await measuredCall(s, kaiHome, "kai_get_context", { task });
      const m = c.parsed.text && c.parsed.text.match(/Estimated Tokens\*\*: ~(\d+)/);
      results.contextDefaultBudget.push({
        ...slim(c),
        task,
        reportedEstimatedTokens: m ? Number(m[1]) : null,
      });
    }

    // Project info / refresh summaries (change-list size)
    results.projectInfoWarm = slim(await measuredCall(s, kaiHome, "kai_project_info", {}));
    results.refreshNoChange = slim(await measuredCall(s, kaiHome, "kai_refresh_index", {}));
    results.planTask = slim(
      await measuredCall(s, kaiHome, "kai_plan_task", {
        task: "refactor estimateTokens to share the scaling helper",
        mode: "code",
      })
    );
  } finally {
    await s.close();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(kaiHome, { recursive: true, force: true });
  }
  return results;
}

// Real-repo targets. Each expected file defines the named symbol or is the file
// the task is about (derived from `grep "function <name>"`, not guessed).
const LOOKUPS = [
  ["estimateTokens", "src/core/tokenCounter.ts"],
  ["truncateToTokenBudget", "src/core/tokenCounter.ts"],
  ["rankCandidates", "src/core/retrieval.ts"],
  ["recordMetric", "src/core/telemetry.ts"],
  ["classifyTask", "src/core/classifier.ts"],
  ["registerProject", "src/core/registry.ts"],
  ["assembleContext", "src/core/contextAssembler.ts"],
  ["extractSymbolsAndDeps", "src/core/symbolExtractor.ts"],
];
const RETRIEVAL_TASKS = [
  ["explain how estimateTokens works", "src/core/tokenCounter.ts"],
  ["explain how rankCandidates scores files", "src/core/retrieval.ts"],
  ["debug why truncateToTokenBudget cuts too much", "src/core/tokenCounter.ts"],
  ["fix a bug where assembleContext drops the task", "src/core/contextAssembler.ts"],
  ["fix loadProjectIndexShared returning a stale index", "src/core/registry.ts"],
  ["add a new field to recordMetric telemetry", "src/core/telemetry.ts"],
  ["add an option to toolReadRange", "src/core/mcpTools.ts"],
  ["review classifyTask keyword matching", "src/core/classifier.ts"],
  ["refactor extractSymbols into smaller functions", "src/core/symbolExtractor.ts"],
  ["refactor registerProject", "src/core/registry.ts"],
];

async function runReal(repo) {
  const kaiHome = fs.mkdtempSync(path.join(os.tmpdir(), "kai-bench-home-"));
  const s = startServer(path.resolve(repo), kaiHome);
  const results = { repo: path.basename(path.resolve(repo)) };
  try {
    await s.rpc("initialize", {});
    const cold = await measuredCall(s, kaiHome, "kai_project_info", {});
    results.coldProjectInfo = slim(cold);
    results.repeatedSearch = [];
    for (let i = 0; i < 4; i++) {
      results.repeatedSearch.push(
        slim(
          await measuredCall(s, kaiHome, "kai_search_code", { query: "indexProject incremental" })
        )
      );
    }
    results.contextBudget4000 = slim(
      await measuredCall(s, kaiHome, "kai_get_context", {
        task: "fix bug in estimateTokens truncation",
        tokenBudget: 4000,
      })
    );
    results.findSymbolShort = slim(
      await measuredCall(s, kaiHome, "kai_find_symbol", { name: "i" })
    );
    const ip = indexJsonPath(kaiHome);
    results.indexJsonBytes = ip && fs.existsSync(ip) ? fs.statSync(ip).size : null;

    const tools = (await s.rpc("tools/list", {})).msg.result.tools.map((t) => t.name);

    // Locate-and-read: does each strategy put the declaration in front of the
    // caller, and what does it cost in bytes and tool calls? Both read the same tree.
    results.lookups = [];
    for (const [sym, file] of LOOKUPS) {
      const row = { symbol: sym, file };
      const inc = await measuredCall(s, kaiHome, "kai_search_code", {
        query: sym,
        includeSource: true,
      });
      const incHit = ((inc.parsed.json && inc.parsed.json.files) || []).find(
        (f) => f.relativePath === file
      );
      row.sourceInclusive = {
        calls: 1,
        wireBytes: inc.wireBytes,
        ms: inc.ms,
        fileFound: !!incHit,
        declarationShown: !!incHit && String(incHit.snippet || "").includes(`function ${sym}`),
      };
      if (tools.includes("kai_read_range")) {
        const meta = await measuredCall(s, kaiHome, "kai_search_code", { query: sym });
        const metaHit = ((meta.parsed.json && meta.parsed.json.files) || []).find(
          (f) => f.relativePath === file
        );
        const rr = await measuredCall(s, kaiHome, "kai_read_range", {
          filePath: file,
          symbol: sym,
        });
        const src = (rr.parsed.json && rr.parsed.json.source) || "";
        row.metadataThenRead = {
          calls: 2,
          wireBytes: meta.wireBytes + rr.wireBytes,
          ms: Math.round((meta.ms + rr.ms) * 100) / 100,
          fileFound: !!metaHit,
          declarationShown: src.includes(`function ${sym}`),
          searchBytes: meta.wireBytes,
          readBytes: rr.wireBytes,
        };
      }
      results.lookups.push(row);
    }

    // Default-budget kai_get_context on tasks whose answer is a known file.
    results.retrieval = [];
    for (const [task, expected] of RETRIEVAL_TASKS) {
      const row = { task, expected };
      for (const [mode, args] of [
        ["default", { task }],
        ["explicit4000", { task, tokenBudget: 4000 }],
      ]) {
        const c = await measuredCall(s, kaiHome, "kai_get_context", args);
        const text = c.parsed.text || "";
        const m = text.match(/Estimated Tokens\*\*: ~(\d+)/);
        const shown = [...text.matchAll(/^### `([^`]+)`/gm)].map((x) => x[1]);
        row[mode] = {
          wireBytes: c.wireBytes,
          ms: c.ms,
          reportedEstimatedTokens: m ? Number(m[1]) : null,
          files: shown.length,
          hit: shown.includes(expected),
        };
      }
      results.retrieval.push(row);
    }
  } finally {
    await s.close();
    fs.rmSync(kaiHome, { recursive: true, force: true });
  }
  return results;
}

// ---------------------------------------------------------------- main
const report = {
  label,
  cli: path.relative(process.cwd(), cliPath),
  node: process.version,
  platform: `${process.platform}-${process.arch}`,
  ts: new Date().toISOString(),
  synthetic: await runSynthetic(),
};
if (realRepo) report.real = await runReal(realRepo);

const json = JSON.stringify(report, null, 2);
if (outPath) {
  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
  fs.writeFileSync(outPath, json);
}
const syn = report.synthetic;
const row = (k, v) => console.log(`${k.padEnd(46)} ${v}`);
console.log(`\n== ${label} (${report.cli}) ==`);
row("tools/list bytes", syn.toolsList.bytes);
row(
  "cold project_info bytes / ms",
  `${syn.coldProjectInfo.wireBytes} / ${syn.coldProjectInfo.coldMs}`
);
syn.repeatedSearch.forEach((c, i) =>
  row(
    `repeated search #${i + 1} ms / refresh / rewritten`,
    `${c.ms} / ${c.refreshOutcome} / ${c.indexRewritten}`
  )
);
row("search (source-inclusive) bytes", syn.searchSourceInclusive.wireBytes);
if (syn.searchMetadataOnly) row("search (metadata-only) bytes", syn.searchMetadataOnly.wireBytes);
row("fixed-window snippet", JSON.stringify(syn.rangeVsWindow.fixedWindow));
if (syn.rangeVsWindow.readRange)
  row("read_range symbol", JSON.stringify(syn.rangeVsWindow.readRange));
row(
  "find_symbol 'process' (wrapped sig) bytes (total/returned)",
  `${syn.multilineSymbols.wireBytes} (${syn.multilineSymbols.reportedTotal}/${syn.multilineSymbols.returned}) of ${PROCESS_FILES} defined`
);
row(
  "find_symbol 'dispatch' bytes (total/returned)",
  `${syn.largeSymbols.wireBytes} (${syn.largeSymbols.reportedTotal}/${syn.largeSymbols.returned})`
);
row(
  "get_dependencies barrel bytes (total/returned)",
  `${syn.largeDependencies.wireBytes} (${syn.largeDependencies.reportedTotal}/${syn.largeDependencies.returned})`
);
syn.contextBudget.forEach((c) =>
  row(
    `get_context budget ${c.tokenBudget} bytes / reported est`,
    `${c.wireBytes} / ${c.reportedEstimatedTokens}`
  )
);
row("project_info (warm) bytes", syn.projectInfoWarm.wireBytes);
row("refresh_index (no change) bytes", syn.refreshNoChange.wireBytes);
row("plan_task bytes", syn.planTask.wireBytes);
if (report.real) {
  console.log(`-- real project: ${report.real.repo} (separate from synthetic) --`);
  row("cold project_info bytes", report.real.coldProjectInfo.wireBytes);
  report.real.repeatedSearch.forEach((c, i) =>
    row(
      `repeated search #${i + 1} ms / refresh / rewritten / bytes`,
      `${c.ms} / ${c.refreshOutcome} / ${c.indexRewritten} / ${c.wireBytes}`
    )
  );
  row("get_context 4000 bytes", report.real.contextBudget4000.wireBytes);
  row("find_symbol 'i' bytes", report.real.findSymbolShort.wireBytes);
  row("index.json bytes", report.real.indexJsonBytes);
}
