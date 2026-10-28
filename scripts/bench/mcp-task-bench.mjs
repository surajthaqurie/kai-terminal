#!/usr/bin/env node
/**
 * Task-level MCP retrieval benchmark (development only; never imported by src/).
 *
 * Where mcp-response-bench.mjs measures single tool calls, this measures what a
 * task costs end to end: for each task of the fixed suite (scripts/bench/task-suite)
 * a FIXED retrieval policy drives the built CLI bundle over stdio and records
 *   - tool calls, serialized response bytes (full JSON-RPC lines), latency
 *   - which ground-truth files had their SOURCE delivered ("read") or were only
 *     named in a dependency listing ("named")
 * The policies are fixed in advance and identical for every bundle, so a bundle
 * is judged on what its tools return, not on a smarter caller.
 *
 * What this is not: no model runs here. "success" is a RETRIEVAL proxy (every file
 * the change must edit had its source delivered), not task completion; token
 * figures are bytes/4 and labelled estimates. Completion rate, regressions in
 * generated code and real model usage are NOT measured.
 *
 *   node scripts/bench/mcp-task-bench.mjs --cli <bundle> --label after --out <file.json> [--reps 5]
 *   node scripts/bench/mcp-task-bench.mjs --compare a.json b.json [c.json ...]
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const median = (xs) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const p95 = (xs) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)];
};
const r1 = (n) => Math.round(n * 10) / 10;

// ------------------------------------------------------------------ compare
if (argv.includes("--compare")) {
  const files = argv.slice(argv.indexOf("--compare") + 1).filter((a) => !a.startsWith("--"));
  // Files sharing a label are repeated runs of one bundle: pool their latencies.
  const byLabel = new Map();
  for (const f of files) {
    const run = JSON.parse(fs.readFileSync(f, "utf8"));
    const prior = byLabel.get(run.label);
    if (!prior) {
      byLabel.set(run.label, run);
      continue;
    }
    prior.results.forEach((x, i) => {
      const y = run.results[i];
      x.callMs = x.callMs.concat(y.callMs);
      x.msMedian = r1(median([x.msMedian, y.msMedian]));
      x.stable = x.stable && y.stable && Math.abs(x.bytes - y.bytes) <= 2 * x.calls;
    });
    prior.pooledRuns = (prior.pooledRuns ?? 1) + 1;
  }
  const runs = [...byLabel.values()];
  printComparison(runs);
  process.exit(0);
}

const cliPath = path.resolve(opt("cli", "dist/cli/index.js"));
const label = opt("label", "run");
const outPath = opt("out", "");
const reps = Math.max(1, Number(opt("reps", "5")));
const here = path.dirname(fileURLToPath(import.meta.url));
const { buildTaskFixture, TASKS } = await import(
  pathToFileURL(path.join(here, "task-suite", "fixture.mjs")).href
);

// --------------------------------------------------------------- MCP client
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

async function call(session, name, args) {
  const r = await session.rpc("tools/call", { name, arguments: args });
  const c = r.msg.result && r.msg.result.content;
  const text = c && c[0] ? c[0].text : "";
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return {
    name,
    ms: r.ms,
    bytes: Buffer.byteLength(r.line, "utf8"),
    text,
    json,
    isError: !!r.msg.error || (r.msg.result && r.msg.result.isError === true),
  };
}

// ----------------------------------------------------------------- policies
// A policy returns { calls: [...], read: Set<path>, named: Set<path>, spanText }.
function collectNamed(value, known, into) {
  if (typeof value === "string") {
    if (known.has(value)) into.add(value);
  } else if (Array.isArray(value)) value.forEach((v) => collectNamed(v, known, into));
  else if (value && typeof value === "object")
    Object.values(value).forEach((v) => collectNamed(v, known, into));
}

function contextFiles(text) {
  return [...text.matchAll(/^### `([^`]+)`/gm)].map((m) => m[1]);
}

const POLICIES = {
  // One call: the pre-assembled context package.
  context: async (s, task, env) => {
    const out = { calls: [], read: new Set(), named: new Set(), spanText: "" };
    const c = await call(s, "kai_get_context", { task: task.task });
    out.calls.push(c);
    contextFiles(c.text).forEach((f) => out.read.add(f));
    out.spanText = c.text;
    return out;
  },
  // Metadata-first: search, read the best symbol of the top files, then look at
  // the top file's dependencies and dependents. Bundles without kai_read_range
  // use the snippets their search returns instead.
  "meta-read": async (s, task, env) => {
    const out = { calls: [], read: new Set(), named: new Set(), spanText: "" };
    const search = await call(s, "kai_search_code", { query: task.task });
    out.calls.push(search);
    const files = (search.json && search.json.files) || [];
    for (const f of files.slice(0, 3)) {
      if (env.hasReadRange) {
        const sym = f.symbols && f.symbols[0] && f.symbols[0].name;
        const args = sym ? { filePath: f.relativePath, symbol: sym } : null;
        if (!args) continue;
        const rr = await call(s, "kai_read_range", args);
        out.calls.push(rr);
        if (rr.json && rr.json.source) {
          out.read.add(f.relativePath);
          out.spanText += rr.json.source + "\n";
        }
      } else if (f.snippet) {
        out.read.add(f.relativePath);
        out.spanText += f.snippet + "\n";
      }
    }
    if (files[0]) {
      const dep = await call(s, "kai_get_dependencies", {
        filePath: files[0].relativePath,
        includeDependents: true,
      });
      out.calls.push(dep);
      collectNamed(dep.json, env.known, out.named);
    }
    return out;
  },
  // Context package plus one dependency/dependents lookup on its first file.
  "context+deps": async (s, task, env) => {
    const out = await POLICIES.context(s, task, env);
    const first = [...out.read][0];
    if (first) {
      const dep = await call(s, "kai_get_dependencies", {
        filePath: first,
        includeDependents: true,
      });
      out.calls.push(dep);
      collectNamed(dep.json, env.known, out.named);
    }
    return out;
  },
};

function score(task, run, env) {
  const edit = task.edit;
  const support = task.support;
  const got = (set, list) => list.filter((f) => set.has(f)).length;
  const either = (f) => run.read.has(f) || run.named.has(f);
  const editRead = edit.length ? got(run.read, edit) / edit.length : 1;
  const supportRead = support.length ? got(run.read, support) / support.length : 1;
  const supportAny = support.length ? support.filter(either).length / support.length : 1;
  let spanOk = true;
  if (task.span) {
    const fileBytes = env.sizes.get(task.span.file) ?? Infinity;
    const bytes = run.calls.reduce((a, c) => a + c.bytes, 0);
    spanOk =
      run.spanText.includes(task.span.mustContain) && bytes < fileBytes * task.maxFileFraction;
  }
  const bytes = run.calls.reduce((a, c) => a + c.bytes, 0);
  return {
    calls: run.calls.length,
    bytes,
    estTokens: Math.round(bytes / 4), // estimate: bytes/4, not model usage
    ms: r1(run.calls.reduce((a, c) => a + c.ms, 0)),
    editRecall: editRead,
    supportRead,
    supportReadOrNamed: supportAny,
    spanOk,
    errors: run.calls.filter((c) => c.isError).length,
    // Retrieval proxy for success: all edit files delivered (and, for the large
    // file, only the declaration rather than most of the file).
    success: editRead === 1 && spanOk,
    fullSuccess: editRead === 1 && supportRead === 1 && spanOk,
  };
}

// The response line embeds the JSON-RPC request id, so its width (9 -> 10 -> 100)
// moves a response by a byte or two between repetitions. That is not retrieval
// variance: allow 2 bytes per call.
const sameBytes = (a, b) => Math.abs(a.bytes - b.bytes) <= 2 * a.calls;

// --------------------------------------------------------------------- main
const root = fs.mkdtempSync(path.join(os.tmpdir(), "kai-task-proj-"));
const kaiHome = fs.mkdtempSync(path.join(os.tmpdir(), "kai-task-home-"));
buildTaskFixture(root);
const known = new Set();
const sizes = new Map();
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full);
    else {
      const rel = path.relative(root, full).split(path.sep).join("/");
      known.add(rel);
      sizes.set(rel, fs.statSync(full).size);
    }
  }
})(root);

const report = {
  label,
  cli: path.relative(process.cwd(), cliPath),
  node: process.version,
  platform: `${process.platform}-${process.arch}`,
  ts: new Date().toISOString(),
  reps,
  fixtureFiles: known.size,
  tokensAreEstimate: true,
  results: [],
};

const s = startServer(root, kaiHome);
try {
  await s.rpc("initialize", {});
  const tools = (await s.rpc("tools/list", {})).msg.result.tools.map((t) => t.name);
  const env = { known, sizes, hasReadRange: tools.includes("kai_read_range") };
  await call(s, "kai_project_info", {}); // cold index, excluded from per-task numbers
  for (const task of TASKS) {
    for (const policy of Object.keys(POLICIES)) {
      const samples = [];
      let last;
      for (let i = 0; i < reps; i++) {
        const run = await POLICIES[policy](s, task, env);
        samples.push({
          ...score(task, run, env),
          callMs: run.calls.map((c) => c.ms),
          callBytes: run.calls.map((c) => c.bytes),
        });
        last = run;
      }
      const first = samples[0]; // deterministic fields are identical across reps
      report.results.push({
        task: task.id,
        category: task.category,
        policy,
        calls: first.calls,
        bytes: first.bytes,
        estTokens: first.estTokens,
        editRecall: first.editRecall,
        supportRead: first.supportRead,
        supportReadOrNamed: first.supportReadOrNamed,
        spanOk: first.spanOk,
        success: first.success,
        fullSuccess: first.fullSuccess,
        errors: first.errors,
        stable: samples.every((x) => sameBytes(x, first) && x.editRecall === first.editRecall),
        msMedian: r1(median(samples.map((x) => x.ms))),
        callMs: samples.flatMap((x) => x.callMs),
        callBytes: first.callBytes,
        ...(samples.every((x) => sameBytes(x, first))
          ? {}
          : { callBytesVariants: samples.map((x) => x.callBytes) }),
        filesRead: [...last.read],
      });
    }
  }
} finally {
  await s.close();
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(kaiHome, { recursive: true, force: true });
}

if (outPath) {
  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
}
printComparison([report]);

// ------------------------------------------------------------------ report
function printComparison(runs) {
  const policies = [...new Set(runs.flatMap((r) => r.results.map((x) => x.policy)))];
  for (const policy of policies) {
    console.log(`\n== policy: ${policy} ==  (tokens = bytes/4, an estimate)`);
    const tasks = [...new Set(runs[0].results.map((x) => x.task))];
    const head = ["task".padEnd(22), ...runs.map((r) => r.label.padEnd(30))];
    console.log(head.join(" "));
    console.log("".padEnd(22) + runs.map(() => " calls  bytes  editR supR  ms  ok").join(" "));
    for (const t of tasks) {
      const cells = runs.map((r) => {
        const x = r.results.find((y) => y.task === t && y.policy === policy);
        if (!x) return "-".padEnd(30);
        return `${String(x.calls).padStart(5)} ${String(x.bytes).padStart(6)} ${x.editRecall
          .toFixed(2)
          .padStart(5)} ${x.supportRead.toFixed(2).padStart(4)} ${String(x.msMedian).padStart(5)} ${
          x.success ? (x.fullSuccess ? "FULL" : "edit") : "FAIL"
        }`;
      });
      console.log(t.padEnd(22) + " " + cells.join(" "));
    }
    for (const r of runs) {
      const rows = r.results.filter((x) => x.policy === policy);
      const succ = rows.filter((x) => x.success);
      const calls = rows.reduce((a, x) => a + x.calls, 0);
      const bytes = rows.reduce((a, x) => a + x.bytes, 0);
      const lat = rows.flatMap((x) => x.callMs);
      console.log(
        `  ${r.label.padEnd(10)} success ${succ.length}/${rows.length}  full ${
          rows.filter((x) => x.fullSuccess).length
        }/${rows.length}  calls ${calls}  median bytes/task ${median(rows.map((x) => x.bytes))}  ` +
          `bytes/success ${succ.length ? Math.round(bytes / succ.length) : "n/a"}  ` +
          `call latency median ${r1(median(lat))} ms p95 ${r1(p95(lat))} ms  unstable ${
            rows.filter((x) => !x.stable).length
          }`
      );
    }
  }
}
