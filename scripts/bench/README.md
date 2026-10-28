# Step 9 benchmarks

Isolated performance harness for Kai Terminal. Never imported by `src/`
application code; it only imports `src/core/*` as a measurement target.

## Run

```sh
# Quick matrix (default; keeps `npm test` fast)
npx vitest run scripts/bench/step9.perf.test.ts

# Full matrix (adds the 1000-file large-repo tier)
KAI_PERF_FULL=1 npx vitest run scripts/bench/step9.perf.test.ts

# Or via npm script
npm run bench:perf
```

Results are printed via `console.table` and written as JSON to
`scripts/bench/results/step9-<timestamp>.json` (gitignored; copy the
numbers you want to keep into `docs/PERF_STEP9.md`).

## MCP response benchmark (`mcp-response-bench.mjs`)

A black-box client for the built CLI bundle: it speaks stdio JSON-RPC only, so the
same script runs unchanged against an older bundle (baseline) and the current one,
on identical inputs. Per call it records the full JSON-RPC line's UTF-8 bytes,
wall-clock latency, the freshness/refresh outcome, and whether `index.json` was
rewritten. It measures bytes and milliseconds only: Kai bundles no tokenizer and
never calls a model, so no token or model-usage figures are produced here.

```sh
# Build a bundle without touching dist/ (outDir can be anywhere)
node node_modules/vite/bin/vite.js build --config vite.cli.config.ts --outDir /tmp/kai-after

# For a baseline, build the same way from `git archive <rev>` in a scratch directory
node scripts/bench/mcp-response-bench.mjs --cli /tmp/kai-after/index.js \
     --label after --out scripts/bench/results/mcp-after.json --repo .
```

* **Synthetic section**: a deterministic generated project (wrapped signatures in
  400 files, a 900-import barrel, one file containing a fake credential shape that
  the indexer rejects). Numbers are comparable between runs.
* **Real section** (`--repo`): the given directory is only read; the Kai home is a
  temporary directory. Real and synthetic numbers are reported separately and must
  not be mixed.
* Compare like for like: same machine, same load, same Node version, runs back to
  back. Single runs; the figures vary by a few percent between runs.

### Repeated runs: median / p95 (`mcp-bench-summary.mjs`)

Single runs hide variance. Run baseline and current bundles alternately several
times (same machine, back to back), then aggregate the real-project section:

```sh
for i in 1 2 3 4 5; do
  node scripts/bench/mcp-response-bench.mjs --cli /tmp/kai-baseline/index.js --label baseline --out /tmp/runs/baseline-$i.json --repo .
  node scripts/bench/mcp-response-bench.mjs --cli /tmp/kai-after/index.js    --label after    --out /tmp/runs/after-$i.json    --repo .
done
node scripts/bench/mcp-bench-summary.mjs --baseline /tmp/runs/baseline-*.json --after /tmp/runs/after-*.json
```

Samples are pooled across tasks and runs (the median is a typical call, not a
typical task); p95 is nearest-rank and, with five runs, close to the maximum.
"Expected file present" checks retrieval only. It does not show that a model would
complete the task: the harness never calls a model, so task completion rate and
actual model token usage are **not measured**.

## Task benchmark (`mcp-task-bench.mjs`)

Measures what a *task* costs, not one call. A fixed suite (`task-suite/fixture.mjs`:
a generated TypeScript API, a Python data layer with migrations, a cross-module
rename target, a ~3,000-line legacy file and 70 distractor modules) defines seven
tasks (exact symbol, function explanation, localized bug fix, API endpoint change,
database model + migration, cross-module refactor, large-file fix) with hand-written
ground truth: files that must be edited (`edit`) and contracts, callers and tests a
careful change should see (`support`). Three fixed policies drive the built bundle
over stdio and are identical for every bundle: `context` (one `kai_get_context`),
`meta-read` (search, read the best symbol of the top 3 files, dependencies of the
top file) and `context+deps`.

```sh
node scripts/bench/mcp-task-bench.mjs --cli /tmp/kai-after/index.js --label after \
     --out /tmp/runs/task-after-1.json --reps 5
# repeated runs of one label are pooled; several labels are tabulated side by side
node scripts/bench/mcp-task-bench.mjs --compare /tmp/runs/task-baseline-*.json /tmp/runs/task-after-*.json
```

Per task it reports calls, response bytes (bytes/4 as an *estimate* of tokens),
latency, edit recall and support recall by delivered source, and a retrieval-proxy
`success` (every edit file's source delivered; for the large file, the declaration
without most of the file). **No model runs here**: coding-task completion rate,
generated-code regressions and real model token usage are not measured. Response
bytes embed the JSON-RPC id, so repetitions may differ by a byte or two; the
stability check allows that and nothing more. The fixture was written together
with the expansion it evaluates, so treat it as a regression suite and a
demonstration, not independent evidence; the real-repo section of
`mcp-response-bench.mjs` is the cross-check.

Reference results (Windows 11, Node 24, 5 alternating runs per bundle, 5 repetitions
each; baseline = the commit before the 0.2.0 retrieval rework, head = 0.2.0 plus
docs, final = this change), `context` policy:

| | baseline | head | final |
|---|---|---|---|
| tasks whose edit files were all delivered | 5/7 | 5/7 | 7/7 |
| tasks with every support file delivered too | 1/7 | 2/7 | 4/7 |
| median response bytes per task | 5,738 | 4,779 | 5,025 |
| response bytes per delivered task | 7,658 | 6,765 | 5,296 |
| call latency median / p95 (ms) | 917 / 1,177 | 47 / 65 | 46 / 61 |

The median per task rises from head to final because the refactor task now returns
its callers (2,205 to 6,355 bytes) and is delivered, where before it was not.
