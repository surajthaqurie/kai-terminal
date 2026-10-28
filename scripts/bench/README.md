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
