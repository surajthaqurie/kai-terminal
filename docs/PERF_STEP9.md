# Step 9 — Performance Testing and Optimization Report

## Environment

- Machine: Windows 11, Node v24.21.0, git 2.43.0.windows.1 (no Rust toolchain
  available in this environment; the one Rust change is minimal, idiomatic,
  and covered by existing Rust unit tests — see trade-offs).
- Repo state: `kai-terminal` at `0d7bccf`, Windows checkout with
  `node_modules` present.
- Harness: `scripts/bench/step9.perf.test.ts` (isolated tooling, never
  imported by application code). Run with `npm run bench:perf`; full matrix
  with `KAI_PERF_FULL=1` (adds a 1000-file tier).
- Method: baseline captured on unmodified `src/` (via `git stash push -- src/`),
  then re-ran after the optimizations. CPU microbenchmarks use loops/medians;
  FS-bound workloads report single timed runs plus medians where noted. All
  numbers in milliseconds unless stated.

## Workload definitions

| #   | Workload                   | What is timed                                                                                                                                                                                                  |
| --- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Application startup        | `registerProject` on an isolated dir and on the real repo (cold registry open: canonicalize + stat + atomic meta write)                                                                                        |
| 2   | Cold project indexing      | `indexProject(forceRebuild)` on synthetic 15 / 100 / 400-file repos                                                                                                                                            |
| 3   | Incremental indexing       | One file appended, then `indexProject` (must re-stat every file, re-parse one)                                                                                                                                 |
| 4   | Large repository indexing  | The 400-file tier above (1000-file tier under `KAI_PERF_FULL=1`)                                                                                                                                               |
| 5   | Context assembly           | `assembleContext` median of 3 on the 100-file index (classify + staleness scan + retrieval + 2 render passes)                                                                                                  |
| 6   | Git status retrieval       | Cold `git rev-parse --show-toplevel` + `git status --porcelain` spawns in this repo vs 1000 frontend cache hits; plus a PATH-scan proxy for the backend `git_binary_available()` check                         |
| 7   | Terminal output throughput | 20000 × ~512 B flood (~10 MB, cap engaged continuously): old `string +=` vs chunk array vs new `TerminalOutputBuffer`; plus `truncateToTokenBudget`/`estimateTokens` on a 260 KB prompt and the ignore matcher |
| 8   | Four concurrent sessions   | 4× parallel `retrieveContext` and 4× parallel MCP `kai_search_code` on one index (proxy: no Tauri backend in this environment)                                                                                 |
| 9a  | MCP request processing     | `initialize`, `tools/list`, `kai_search_code`, `kai_get_context`                                                                                                                                               |
| 9b  | Shutdown / cleanup         | `deleteProjectData` + temp cleanup; asserts zero stray `.tmp` files                                                                                                                                            |

## Before → after (dedicated runs, same machine)

| Workload                              | Before              | After               | Δ                                |
| ------------------------------------- | ------------------- | ------------------- | -------------------------------- |
| startup: registerProject (isolated)   | 3.70                | 4.58                | noise                            |
| startup: registerProject (cwd)        | 6.78                | 7.88                | noise                            |
| index cold small (15)                 | 42                  | 53                  | noise (FS-bound)                 |
| index incremental small               | 40.83               | 43.94               | noise                            |
| index cold medium (100)               | 170                 | 180                 | noise                            |
| index incremental medium              | 182.46              | 213.95              | noise                            |
| index cold large (400)                | 703                 | 688                 | noise                            |
| index incremental large               | 556.31              | 601.52              | noise                            |
| context assembly median x3            | 31.16               | 31.60               | no change                        |
| retrieval median x5                   | 14.80               | 16.62               | noise                            |
| classifyTask x200                     | 6.93 (34.7 µs/call) | 2.51 (12.6 µs/call) | **2.8×**                         |
| git status cold (2 spawns)            | 88.88               | 84.90               | noise                            |
| git status cache hit x1000            | 1.13                | 1.52                | noise (~1.5 µs/hit)              |
| git binary PATH scan x20 (proxy)      | 20.07               | 20.22               | proxy only; Rust side now cached |
| terminal flood string `+=` (control)  | 4774                | 4466                | unchanged path                   |
| terminal flood chunk array            | 2.19                | 2.34                | reference                        |
| terminal flood `TerminalOutputBuffer` | 3.33                | 2.48                | **~1800× vs old path**           |
| truncateToTokenBudget (260 KB)        | 22.35               | 8.23                | **2.7×** (≈ one estimate pass)   |
| estimateTokens (260 KB, reference)    | 13.31               | 8.74                | —                                |
| ignore matcher x1000                  | 3.56                | 5.08                | noise                            |
| ignore matcher realistic x2000        | 40.94               | 34.20               | noise                            |
| 4× concurrent retrieval               | 70.35               | 77.16               | noise (sync CPU-bound)           |
| 4× concurrent MCP search              | 44.87               | 45.77               | noise                            |
| MCP initialize                        | 0.132               | 0.084               | noise                            |
| MCP tools/list                        | 0.027               | 0.022               | noise                            |
| MCP kai_search_code                   | 20.79               | 25.61               | noise (FS-bound)                 |
| MCP kai_get_context                   | 34.93               | 38.59               | noise (FS-bound)                 |
| shutdown cleanup                      | 106                 | 110                 | noise                            |
| stray .tmp files                      | 0                   | 0                   | clean                            |

Stress probes (temporary scratch harness, since removed):

| Probe                                       | Before  | After                                |
| ------------------------------------------- | ------- | ------------------------------------ |
| retrieval, 10 × 400 KB files, 60000 symbols | 1347 ms | 173 ms (**7.8×**, symbol caps)       |
| ignore matcher, 100-pattern list × 2000     | 381 ms  | 366–406 ms (noise → change reverted) |

## Changes made (smallest effective, one per bottleneck)

1. **Terminal output buffer** (`src/services/terminalOutputBuffer.ts`, new;
   `src/components/TerminalView.tsx`): pending output was accumulated with
   `pendingOutput += data` plus a 1 MB `slice` on every event once the cap
   engaged — O(n²) copying, ~4.8 s for a 10 MB flood, enough to trip Windows
   "Not Responding". The new bounded FIFO appends whole payloads O(1),
   trims whole chunks from the front (surrogate pairs never split), compacts
   its dead head, and joins only on flush. ~2.5 ms on the same flood, same
   1 MB cap, same 64 KB xterm write chunking. No validation weakened: size
   limits and Tai​ IPC paths untouched.
2. **Token truncation** (`src/core/tokenCounter.ts`): `truncateToTokenBudget`
   re-scanned the candidate ~log2(n) times (≈18 full passes for 260 KB).
   Now jumps to a proportional estimate and corrects with ≤6 refinement
   passes plus a shrink guard that preserves the hard budget guarantee.
   22.4 → 8.2 ms; golden boundary byte-identical (5200 chars on the
   reference sample; pinned by regression test).
3. **Task classification** (`src/core/classifier.ts`): `classifyTask` rebuilt
   ~70 keyword regexes per call. They are now compiled once into a
   module-level cache (fixed key set, no `/g` flag → stateless sharing).
   34.7 → 12.6 µs/call; golden categories unchanged.
4. **Retrieval staleness check** (`src/core/retrieval.ts`): every retrieved
   file paid a full sha256 pass per query even when unchanged. Now skipped
   when size+mtime(+ctime) already match the index — the exact predicate the
   indexer itself uses for incremental reuse; any mismatch still falls back
   to the hash comparison as ground truth. Saves one memory pass per
   retrieved file per query (~9% on large-file retrieval).
5. **Retrieval match bounds** (`src/core/retrieval.ts`): per-file
   `matchedSymbols` dedup was a linear `.some()` scan with no cap, and the
   ranked symbol list was unbounded — one 6000-symbol file turned retrieval
   quadratic (1347 ms). Capped at 500 per file / 1000 globally, insertion
   order preserved (deterministic). Consumers only read the top entries
   (assembler slices 15). Normal queries are unaffected (pinned by tests).
6. **Git binary probe** (`src-tauri/src/git.rs`): `git_binary_available()`
   re-scanned PATH (stat per directory) on every git query — up to N times
   per footer refresh for N panes. Result now cached in a
   `std::sync::OnceLock`. Trade-off: a mid-process git install/uninstall
   takes effect on next restart; all path validation and error taxonomy
   untouched. Not re-runnable here (no cargo toolchain in this environment);
   existing Rust `git::tests` cover `get_git_info` behavior.

## Investigated, deliberately left alone

- **Indexing (cold/incremental/large):** dominated by per-file
  `realpathSync`+`statSync` syscalls and the security boundary checks, which
  must not be weakened. A compiled-regex cache for ignore globs was tried
  and showed no measurable delta (381 → 366–406 ms on a 100-pattern stress
  list, inside run noise), so it was reverted to keep the diff minimal.
- **Git status:** cold cost is two `git` spawns (~85–100 ms on Windows);
  the 30 s TTL cache + in-flight dedup + normalized keys make steady-state
  cost ~1.5 µs/hit. Backend spawn collapsing (e.g. via `status -b`) would
  risk the detached-HEAD/unborn-repo taxonomy — not attempted.
- **Context assembly double render:** the final refresh pass is load-bearing
  (the token-metrics footer renders the previous pass's numbers), so the two
  passes stay. Its components got faster via (2)–(5) instead.
- **Startup / MCP plumbing / shutdown:** 4–8 ms / sub-ms /
  ~110 ms (temp-dir removal) with zero stray `.tmp` files — sufficiently
  fast, no change.
- **Concurrent sessions:** `retrieveContext` is synchronous CPU+FS work, so
  4× parallel ≈ 4× single; no shared lock to relieve. PTY-level concurrency
  was already fixed earlier (per-session writer locks, throttled cwd probes).

## Correctness

- `src/__tests__/perf_step9_regression.test.ts` (13 tests): ignore-matcher
  parity, classifier goldens + determinism, truncation budget/prefix/golden
  boundary/near-maximal fill, staleness fresh-vs-modified, symbol-cap
  bounds + determinism + exact-hit ranking, buffer order/cap/surrogate/flood.
- Full suite: 381 passed; the only 5 failures are pre-existing Windows
  `symlinkSync` EPERM environment failures, confirmed identical on the
  unmodified tree.
- `npm run typecheck` clean. No new mandatory dependencies, no database,
  no cloud service, no validation/security weakened.

## Addendum — React render inspection (Step 9 gap closure)

The "unnecessary React renders" inspection was code-review only in the first
pass, so it is closed out here explicitly:

- Expensive derivations are already memoized where it matters
  (`GitChangesModal` unified-diff parsing via `useMemo`, stable callbacks
  via `useCallback` in `TabBar`/`AiCliPanel`).
- `App.tsx` state updates that fire on every keystroke path are
  equality-guarded: per-directory git entries compare branch/dirty/root
  before `setState` (no re-render when the probe result is identical),
  `codeModeProject` and `modeDisplay` only update on actual transitions.
- `TerminalView` re-render cost is bounded by construction: effects are
  keyed on `sessionId`/`visible` (settings-only changes never respawn the
  PTY), and the hot paths (keystroke forwarding, output batching at up to
  64 KB per xterm write, resize debounce) all bypass React state.
- No render-loop pathology was found, so no code was changed (per the
  "already fast → leave alone" rule). Empirical render profiling
  (React DevTools profiler, pane-switch and flood scenarios) still needs a
  running desktop build and is recorded as follow-up work, not as a claim.
