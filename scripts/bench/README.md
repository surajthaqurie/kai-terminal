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
