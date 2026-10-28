#!/usr/bin/env node
/**
 * Aggregates repeated `mcp-response-bench.mjs` result files into median / p95
 * tables (development only; never imported by src/).
 *
 *   node scripts/bench/mcp-bench-summary.mjs \
 *        --baseline results/b-1.json results/b-2.json ... \
 *        --after    results/a-1.json results/a-2.json ...
 *
 * Only the REAL-project section is summarised (the synthetic project exercises
 * limits, not typical tasks). Samples are pooled across tasks and runs, so the
 * median describes a typical call, not a typical task. p95 uses nearest-rank,
 * which with few samples is close to the maximum: read it as "worst observed".
 *
 * Everything here is bytes, milliseconds and counts. "Estimated tokens" is Kai's
 * own character heuristic reported inside the response; it is not model usage.
 * "Hit" means the expected file appeared in the result, not that a model would
 * have completed the task: task completion is not measured by this harness.
 */
import fs from "node:fs";

const argv = process.argv.slice(2);
function collect(flag) {
  const i = argv.indexOf(flag);
  if (i < 0) return [];
  const out = [];
  for (let j = i + 1; j < argv.length && !argv[j].startsWith("--"); j++) out.push(argv[j]);
  return out;
}
const load = (files) => files.map((f) => JSON.parse(fs.readFileSync(f, "utf8")));
const sets = { baseline: load(collect("--baseline")), after: load(collect("--after")) };
if (!sets.baseline.length || !sets.after.length) {
  console.error("usage: --baseline <json...> --after <json...>");
  process.exit(2);
}

const sorted = (xs) => [...xs].sort((a, b) => a - b);
const median = (xs) => {
  const s = sorted(xs);
  if (!s.length) return null;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const p95 = (xs) => {
  const s = sorted(xs);
  return s.length ? s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)] : null;
};
const fmt = (n) =>
  n === null || n === undefined ? "n/a" : Number.isInteger(n) ? String(n) : n.toFixed(1);
const pair = (xs) => `${fmt(median(xs))} / ${fmt(p95(xs))}`;
const rate = (flags) => (flags.length ? `${flags.filter(Boolean).length}/${flags.length}` : "n/a");

function pool(runs, pick) {
  const out = [];
  for (const r of runs)
    for (const v of pick(r.real || {}) || []) if (v !== null && v !== undefined) out.push(v);
  return out;
}

const rows = [];
const add = (metric, fn) => rows.push([metric, ...["baseline", "after"].map((k) => fn(sets[k]))]);

for (const mode of ["default", "explicit4000"]) {
  const pickRows = (key) => (real) => (real.retrieval || []).map((t) => t[mode] && t[mode][key]);
  add(`get_context ${mode}: wire bytes (median / p95)`, (r) =>
    pair(pool(r, pickRows("wireBytes")))
  );
  add(`get_context ${mode}: reported est. tokens (heuristic)`, (r) =>
    pair(pool(r, pickRows("reportedEstimatedTokens")))
  );
  add(`get_context ${mode}: latency ms`, (r) => pair(pool(r, pickRows("ms"))));
  add(`get_context ${mode}: expected file present`, (r) => rate(pool(r, pickRows("hit"))));
  add(`get_context ${mode}: files shown`, (r) => pair(pool(r, pickRows("files"))));
}

for (const [label, key] of [
  ["search with source, then read nothing", "sourceInclusive"],
  ["metadata search, then kai_read_range", "metadataThenRead"],
]) {
  const pickRows = (field) => (real) => (real.lookups || []).map((t) => t[key] && t[key][field]);
  add(`lookup (${label}): tool calls`, (r) => pair(pool(r, pickRows("calls"))));
  add(`lookup (${label}): wire bytes`, (r) => pair(pool(r, pickRows("wireBytes"))));
  add(`lookup (${label}): latency ms`, (r) => pair(pool(r, pickRows("ms"))));
  add(`lookup (${label}): file found`, (r) => rate(pool(r, pickRows("fileFound"))));
  add(`lookup (${label}): declaration shown`, (r) => rate(pool(r, pickRows("declarationShown"))));
}

const search = (field) => (real) => (real.repeatedSearch || []).map((c) => c[field]);
add("repeated kai_search_code: latency ms", (r) => pair(pool(r, search("ms"))));
add("repeated kai_search_code: wire bytes", (r) => pair(pool(r, search("wireBytes"))));
add("repeated kai_search_code: calls that rewrote index.json", (r) =>
  rate(pool(r, search("indexRewritten")))
);
add("cold kai_project_info: wire bytes", (r) =>
  pair(pool(r, (real) => [real.coldProjectInfo && real.coldProjectInfo.wireBytes]))
);
add("find_symbol 'i': wire bytes", (r) =>
  pair(pool(r, (real) => [real.findSymbolShort && real.findSymbolShort.wireBytes]))
);
add("index.json bytes on disk", (r) => pair(pool(r, (real) => [real.indexJsonBytes])));

console.log(`runs: baseline=${sets.baseline.length} after=${sets.after.length}`);
console.log(`bundles: ${sets.baseline[0].cli} | ${sets.after[0].cli}`);
console.log("");
console.log("| metric | baseline | after |");
console.log("|---|---|---|");
for (const r of rows) console.log(`| ${r.join(" | ")} |`);

// Per-task view: which tasks lose their expected file, and byte change per task.
console.log("");
console.log(
  "Per task, default budget (median bytes over runs; expected file present in all runs?)"
);
console.log("| task | baseline bytes | after bytes | baseline hit | after hit |");
console.log("|---|---|---|---|---|");
const tasks = (sets.after[0].real.retrieval || []).map((t) => t.task);
for (const task of tasks) {
  const cell = (runs) => {
    const hits = runs
      .map((r) => ((r.real.retrieval || []).find((t) => t.task === task) || {}).default)
      .filter(Boolean);
    return [median(hits.map((h) => h.wireBytes)), rate(hits.map((h) => h.hit))];
  };
  const [bb, bh] = cell(sets.baseline);
  const [ab, ah] = cell(sets.after);
  console.log(`| ${task} | ${fmt(bb)} | ${fmt(ab)} | ${bh} | ${ah} |`);
}
