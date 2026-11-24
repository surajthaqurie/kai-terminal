# Implementation Status

The state of every finding in [EXECUTIVE-SUMMARY](EXECUTIVE-SUMMARY.md) after the implementation work (phases 1 to 5). The audit documents describe the code as it was at `50f4c8c`; this file says what has happened to each finding since. Nothing here is committed: it is all in the working tree.

Statuses: **FIXED** (changed, with a test that fails when the bug is put back), **PARTIALLY FIXED** (part done; the rest is stated), **VERIFIED NOT APPLICABLE**, **BLOCKED**, **NOT STARTED** (with the reason it was left).

Only Windows (windows-gnu, ConPTY) was run. Code that only exists on Linux or macOS was compiled and linted for `x86_64-unknown-linux-gnu` and `x86_64-apple-darwin` but its tests have not executed; "Unix: not run" below marks those.

## Findings

### Security
| ID | Status | Note |
|---|---|---|
| SEC-01 Windows cwd binary planting | FIXED | `NoDefaultCurrentDirectoryInExePath` set in the process itself; system tools by absolute path |
| SEC-02 updater without integrity check | PARTIALLY FIXED | Ed25519-signed checksums verified before launch. Needs the `UPDATE_SIGNING_KEY` secret added to GitHub; until then releases install by hand |
| SEC-03 repo `core.fsmonitor` | FIXED | |
| SEC-04 commands not capability-gated | FIXED | per-window ACL, tested against the real capability files |
| SEC-05 symlink alias to a credential file | PARTIALLY FIXED | target is checked everywhere; the end-to-end link tests need Developer Mode on Windows, so they skipped here (Unix: not run) |
| SEC-06 typed lines recorded | FIXED | recorder deleted |
| SEC-07 CSP | FIXED | `connect-src` narrowed; `frame-src http://localhost:*` and `style-src 'unsafe-inline'` remain, documented |
| SEC-08 agent config | FIXED | the command no longer has a launcher argument at all (the page cannot send one; a test checks the request), first backup kept, mode preserved (mode test: Unix: not run) |
| SEC-09 PATH edits | FIXED | Windows writes the registry, keeps `REG_EXPAND_SZ`; Unix rc block appended (Unix: not run) |
| SEC-10 git locks / pathspecs | FIXED | |
| SEC-11 forged session kill | FIXED | |
| SEC-12 untrusted OSC 7 | FIXED | host and folder checked in the backend; the page only treats OSC as a signal. A WSL shell with a custom host name keeps working (Linux paths are exempt) |
| SEC-13 secret nits | PARTIALLY FIXED | DPAPI secret on stdin (checked live), clipboard hold expires after 60 s. The silent fallback to a `0600` file is documented, not shown in the UI |
| SEC-14 documentation drift | FIXED | plus a doc-drift item in the release checklist |

### Reliability
| ID | Status | Note |
|---|---|---|
| REL-01 global lock held across slow work | FIXED | |
| REL-02 resize under the global lock | FIXED | |
| REL-03 spurious exit after close | FIXED | |
| REL-04 Unix close sends only SIGHUP | PARTIALLY FIXED | 500 ms grace then SIGKILL; test written, Unix: not run |
| REL-05 read `Interrupted` ends output | FIXED | |
| REL-06 split character after an invalid byte | FIXED | |
| REL-07 login-shell PATH hang | PARTIALLY FIXED | bounded read; Unix: not run |
| REL-08 hand-off rough edges | PARTIALLY FIXED | orphaned moved shell on Retry, double exit. The 60 ms settle and the 4,000-row snapshot cap are unchanged |
| REL-09 spawn before listeners | FIXED | |
| REL-10 `set_var` from a thread | PARTIALLY FIXED | the login-shell PATH is applied first thing in `run()`, before other threads; the CLI helper no longer calls `set_var` on Unix |
| REL-11 tab shells not in a Job Object | FIXED | documented as intended |
| REL-12 mutex across pipe I/O | FIXED | |

### Performance
| ID | Status | Note |
|---|---|---|
| PERF-01 no backpressure | FIXED | credit/ack flow control |
| PERF-02 silent output drops | FIXED | |
| PERF-03 cwd event storm | FIXED | |
| PERF-04 output to every window | FIXED | routed to the owner |
| PERF-05 blocking work on async workers | FIXED | |
| PERF-06 undebounced refits | FIXED | |
| PERF-07 settings repaint | FIXED | |
| PERF-08 WebGL budget / re-attach | PARTIALLY FIXED | bounded re-attach and a smaller budget in extra windows; two windows with 8 panes each not tried |
| PERF-09 JSON-in-eval transport | NOT STARTED | needs a binary `Channel` and a change on both sides; unmeasured, low severity |
| PERF-10 cold PowerShell at launch | FIXED | registry read; the PowerShell PATH write is gone too |
| PERF-11 font gate, eager addons | PARTIALLY FIXED | Search, Serialize and Image are fetched on first use (search bar opened, tab moved to another window, right after the pane is up). The font gate is kept: it protects the first cell measurement. The WebGL add-on (66 kB gzip) stays eager, because the first paint of a pane must not switch renderers. No cold-start trace was taken, so the gain is in bytes, not milliseconds |
| PERF-12 cwd polling | PARTIALLY FIXED | the 5 s poll is kept but quiet (never causes a git probe); macOS `lsof` cadence unchanged, Unix: not run |

### Resources
| ID | Status | Note |
|---|---|---|
| RES-01 call watcher always on | FIXED | |
| RES-02 `kai mcp` git per poll; LSP probes | FIXED | |
| RES-03 stale bundled Node | FIXED | pinned, checksum-verified, weekly update PR (the workflow has not run on GitHub) |
| RES-04 no bundle budget | FIXED | CI gate |
| RES-05 unused `tokio` | FIXED | |
| RES-06 release profile | VERIFIED NOT APPLICABLE | informational |
| RES-07 launch-time network contacts | FIXED | YouTube hint only when the player opens; privacy text corrected |
| RES-08 npm package contents | FIXED | |
| RES-09 `reqwest` root store | FIXED | the update download and YouTube search also trust the OS certificate store (`rustls-tls-native-roots`), with the bundled Mozilla roots kept as a fallback; +13,824 bytes on the release binary (+0.24%). Update integrity still rests on the signed checksums, not TLS. Not tried behind a TLS-inspecting proxy |
| RES-10 scrollback memory | FIXED | shown in Settings |

### Functional
| ID | Status | Note |
|---|---|---|
| FUNC-01 search shortcut | FIXED | |
| FUNC-02 confirm destructive actions | FIXED | closing tabs, panes, the window (button, Alt+F4, taskbar) and loading a workspace confirm when work is running; quitting from the macOS menu or Cmd+Q does not. The Alt+F4 path has not been tried in a running window |
| FUNC-03 close jumps to last tab | FIXED | |
| FUNC-04 git badge stale | FIXED | |
| FUNC-05 first tab ignores shell | FIXED | |
| FUNC-06 settings not synced | FIXED | |
| FUNC-07 persistence gaps | PARTIALLY FIXED | 30 tabs, active tab, debounced; other windows and torn-off tabs are not restored |
| FUNC-08 spinner forever | FIXED | |
| FUNC-09 exit status lost | FIXED | a failed shell (non-zero or unknown status) keeps its pane open with the output, the exit code (hex too for Windows statuses) and Restart / Close; a clean exit still closes; the last pane failing no longer quits the app; crash-loop and instant-death guards unchanged and also apply after Restart |
| FUNC-10 key and clipboard edges | FIXED | AltGr, denied clipboard. Focus after a palette action: switching tabs already handed focus to the new pane; closing a pane (shortcut, palette, or after the close confirmation) left focus on nothing, and now hands it to the pane that is left |
| FUNC-11 absent terminal features | NOT STARTED | optional, each needs a stated user problem |
| FUNC-12 spawn validation | FIXED | a folder as shell refused; when the backend opens the shell in the parent of a missing folder, the pane says so |
| FUNC-13 tab-strip details | FIXED | the tab context menu takes focus and works with Up/Down/Left/Right/Home/End, Escape returns focus to the tab; an interrupted drag (`pointercancel`: the browser taking a touch over, the system interrupting a pen) is now cancelled instead of committing the drop slot it stopped over; once a touch hold has lifted a tab, finger moves are kept from turning into a scroll that would cancel the drag. Not tried on a real touch screen or pen. Releasing a tab in the tear-off zone opens the new window at once with no confirmation: decided by the maintainer and pinned by a test; pointer capture was not added (the window-level listeners already receive the events, and capture does not prevent a cancel) |

### Architecture
| ID | Status | Note |
|---|---|---|
| ARCH-01 optional surfaces | PARTIALLY FIXED | call watcher gated; "what runs while idle" table added (read from code, not measured) |
| ARCH-02 four cwd mechanisms | PARTIALLY FIXED | shell reports are now a signal and the backend value is used; the mechanisms are not merged |
| ARCH-03 `TerminalView` too large | PARTIALLY FIXED | real-component tests cover startup order, keys, rendering, flow control, hand-off and search; the key handler moved to `services/terminalKeyHandler.ts` (13 direct tests) the WebGL renderer attach/detach/budget to `components/gpuRenderer.ts` (8 direct tests), and the output buffering, per-frame chunked writes and acknowledgement accounting to `services/terminalOutputPipeline.ts` (14 direct tests), and working-directory tracking to `services/paneCwdTracker.ts` (13 direct tests, plus 2 component tests for the probes after `cd`; probes still pending when a pane closes are now cancelled), and search to `hooks/useTerminalSearch.ts` with a shared lazy add-on slot (13 direct tests; closing search by the shortcut or palette now clears the highlights too, and a failed add-on load is retried), and the shell start and attach sequences to `services/paneSpawn.ts` (14 direct tests, plus 5 component tests written against the old code first: the folder fallback, a spawn failure, a failure in the default folder too, Retry, and a spawn overtaken by Retry). The file is 1,374 lines (was 1,778). What stays: the launch orchestration (sequence numbers, React state, the go-live and failure steps both paths share), the input filter for stray mouse/focus reports, paste and the settings effects |
| ARCH-04 dead code | FIXED | autocomplete, typed-line recorder, `tokio` and `redact_secrets` removed; `interrupt_pty` is used by the tests and kept |
| ARCH-05 two runtimes | PARTIALLY FIXED | Node updated and automated; size unchanged |
| ARCH-06 drift | PARTIALLY FIXED | doc-drift checklist and a test that fails when the version differs between `package.json`, the lock files, `tauri.conf.json` and `Cargo.toml`; it is still edited in each by hand |

### CI and tests
| ID | Status | Note |
|---|---|---|
| CI-01 GUI feature not built in CI | PARTIALLY FIXED | clippy and the GUI-feature tests run in CI; not yet run on a CI runner |
| CI-02 release gate not tied to CI | FIXED | the gate requires a green `ci.yml` run for the tagged commit (not yet exercised on GitHub) |
| CI-03 supply-chain gates | FIXED (not yet run on GitHub) | `npm audit` and `cargo audit` job, weekly dependabot PRs (npm, cargo, actions), every action pinned to a commit SHA (a test guards it); CI, release and the Docker image build with one exact Rust version (`scripts/rust-toolchain-version.txt`, a test keeps them in agreement; local builds are not forced onto it); every release attaches CycloneDX SBOMs for the npm packages (bundled devDependencies and the Node runtime included) and the Rust crates and every installer and SBOM gets a GitHub-signed build-provenance attestation (`gh attestation verify`); a test keeps the attested and uploaded file lists identical. None of the release steps has run on GitHub yet. The pinned SHAs were taken from the GitHub API and have not run in Actions yet |
| CI-04 no end-to-end UI test | PARTIALLY FIXED | `npm run test:e2e` drives the built app through tauri-driver with a small W3C WebDriver client (no new dependency): a command runs in a real shell, new tab, split, find, command palette, and a failed shell keeping its pane then Restart. The app under test has its own identifier (own profile and single-instance lock) and a throwaway home, so a running Kai is never touched. Passed 3 of 3 runs on Windows here (about 81 s). CI job `e2e` on Linux (Xvfb) and Windows is written but has not run on GitHub. macOS cannot be driven: there is no WebDriver for WKWebView |
| CI-05 PTY test depth | PARTIALLY FIXED | churn, byte-exact flood, stalled consumer, busy sessions, child observes resize, close semantics added; the default Windows test shell is still `cmd.exe` |
| CI-06 performance not gated | PARTIALLY FIXED | bundle size and a PTY throughput floor (a prompt consumer must keep above 260 kB/s; measured 0.97 to 1.24 MB/s here) are gated; no latency, cold-start or memory gate |
| CI-07 duplicate work, no safeguards | FIXED | concurrency, timeouts, read-only permissions |
| CI-08 lint is only `tsc` | BLOCKED | `typescript-eslint` does not support TypeScript 7.0 |
| CI-09 Docker harness drift | FIXED | Node 24, and the same pinned Rust as CI (the image has not been rebuilt here: Docker was not run) |

## What was measured

Windows, ConPTY, before = the audit baseline or the code before the change, after = the working tree. Nothing is claimed that is not in this table.

| Measure | Before | After |
|---|---|---|
| `pty-cwd` events for two `cd` commands | 101 | 3 |
| Output in flight, slow consumer | 2.66 MiB | 1.00 MiB (bounded) |
| Stalled consumer | 6.5 MB and growing | 1 MiB, then the producer stops |
| Key-to-shell latency with background workers busy | 1.35 s | 86 µs |
| Reading the User PATH at launch | 306 ms (PowerShell) | 82 µs (registry) |
| Fast-consumer throughput | about 1.3 MB/s | unchanged |
| `kai.exe` (default features, release) | 5,502,464 bytes | 5,716,480 bytes (+3.89%); of that, the OS certificate store (RES-09) is 13,824 bytes (5,702,656 without it, same tree) |
| App chunk loaded at every launch (gzip, Vite report) | 198.4 kB | 169.8 kB (-28.6 kB); the three add-ons now load on first use (4.8 + 9.8 + 18.6 kB) |
| Frontend tests | 2,703 | 3,084 (+27 skipped), plus 6 end-to-end workflows |
| Rust lib tests | 270 | 310 |
| PTY integration tests | 19 | 28 |
| GUI-feature tests | 0 | 28 |

Not measured at all: cold start, idle CPU and wake-ups, memory per pane, frame time, installer size. The audit's baseline procedures for those (TEST-AND-BENCHMARK-PLAN section 3) have not been run. They need a second Kai instance, and the single-instance rule hands a second launch to the one already running, so measuring on a machine that is using Kai would open a window in the user's own session; run them on a clean machine or after closing Kai.

## Open risks and decisions for the maintainer

1. Add the `UPDATE_SIGNING_KEY` GitHub secret (then delete the local key file); until then in-app updates fall back to the release page.
2. Run CI on Linux, macOS and Windows-MSVC once: the Unix-only code and tests, the weekly Node-update workflow, the release gate's CI check and the new bundle-budget step have never run on GitHub.
3. Open the music player in a packaged build once: the narrowed CSP was checked by tests, not by playing a track.
4. Accepted as they are: `style-src 'unsafe-inline'`, `frame-src http://localhost:*`, the 60 ms hand-off settle, JSON-in-eval output transport, the font gate.
5. Test runs on a loaded machine: twice, a full `vitest run` left out `appShell.test.tsx` (102 tests) entirely and still reported success with zero failures; the file passes on its own and in the next full run. CI and release now run `npm run test:ci`, which fails, naming the files, when any test file Vitest selects has no results (`scripts/check-test-run.mjs`; checked against the report of that bad run, where it names `appShell.test.tsx`). A timing threshold in `lspDetection.test.ts` that failed under load was loosened to what still separates a blocked event loop from a busy one.
6. Larger items left for a separate effort: running the end-to-end job on GitHub for the first time (CI-04), performance gates (CI-06), further `TerminalView.tsx` reduction (ARCH-03: the input filter and launch orchestration remain; diminishing returns), a binary output channel (PERF-09).
