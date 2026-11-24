# Implementation Status

The state of every finding in [EXECUTIVE-SUMMARY](EXECUTIVE-SUMMARY.md) after the implementation work (phases 1 to 5). The audit documents describe the code as it was at `50f4c8c`; this file says what has happened to each finding since. All of it is committed on the `audit/remaining-tasks` branch.

Statuses: **FIXED** (changed, with a test that fails when the bug is put back), **PARTIALLY FIXED** (part done; the rest is stated), **VERIFIED NOT APPLICABLE**, **BLOCKED** (the rest needs the maintainer, a GitHub run or a manual check; the step is named), **ACCEPTED** (the rest is deliberately not done; the reason is stated), **NOT STARTED** (with the reason it was left).

**Phase 36 closed the work.** No finding is left PARTIALLY FIXED or NOT STARTED: each is FIXED, VERIFIED NOT APPLICABLE, ACCEPTED, or BLOCKED on a step only the maintainer can take (item 8 under *Open risks and decisions* below).

Locally only Windows (windows-gnu, ConPTY) was run. The first CI runs on GitHub (commit `667bcc8`, 2026-11-24) passed on Linux x86_64 and ARM64, macOS Apple Silicon and Intel, and Windows x86_64 and ARM64, including the Rust unit, PTY integration, GUI-feature and frontend steps on each, so the Linux/macOS-only code and tests marked "Unix: passed in CI" below have executed there (per-test logs were not read: they need a GitHub login). Commits after `667bcc8` have not been through CI.

## Findings

### Security
| ID | Status | Note |
|---|---|---|
| SEC-01 Windows cwd binary planting | FIXED | `NoDefaultCurrentDirectoryInExePath` set in the process itself; system tools by absolute path |
| SEC-02 updater without integrity check | BLOCKED (maintainer) | Ed25519-signed checksums verified before launch. Needs the `UPDATE_SIGNING_KEY` secret added to GitHub; until then releases install by hand. The secret's format is documented (RELEASE_GUIDE 1.3a: unencrypted PKCS#8 PEM, whole file) and the signing script now rejects a passphrase-protected key (it used to wait for a passphrase on a terminal), an OpenSSH key, a non-PEM value and a PEM with lost line breaks, each with its own message and never echoing the key; tested with throwaway keys. No local copy of the real private key was found (file-name search of the home folder); no released app embeds the public key yet, so a new pair can still be generated safely. **Phase 36:** nothing more can be done in the code. The remaining step is the maintainer's: generate the key pair, add `UPDATE_SIGNING_KEY` to the GitHub secrets, ship the public key in a release (RELEASE_GUIDE 1.3a) |
| SEC-03 repo `core.fsmonitor` | FIXED | |
| SEC-04 commands not capability-gated | FIXED | per-window ACL, tested against the real capability files |
| SEC-05 symlink alias to a credential file | FIXED (Windows run needs Developer Mode) | target is checked everywhere; the end-to-end link tests need Developer Mode on Windows, so they skipped here (Unix: passed in CI). **Phase 36:** the code path is the same on every OS and passed in CI on Linux and macOS; on Windows the link tests run once Developer Mode is on (without it they skip, they do not pass) |
| SEC-06 typed lines recorded | FIXED | recorder deleted |
| SEC-07 CSP | FIXED | `connect-src` narrowed; `frame-src http://localhost:*` and `style-src 'unsafe-inline'` remain, documented; `script-src` gained only `'wasm-unsafe-eval'` (inline images), with page `eval` still blocked (checked end to end) |
| SEC-08 agent config | FIXED | the command no longer has a launcher argument at all (the page cannot send one; a test checks the request), first backup kept, mode preserved (mode test: Unix: passed in CI) |
| SEC-09 PATH edits | FIXED | Windows writes the registry, keeps `REG_EXPAND_SZ`; Unix rc block appended (Unix: passed in CI) |
| SEC-10 git locks / pathspecs | FIXED | |
| SEC-11 forged session kill | FIXED | |
| SEC-12 untrusted OSC 7 | FIXED | host and folder checked in the backend; the page only treats OSC as a signal. A WSL shell with a custom host name keeps working (Linux paths are exempt) |
| SEC-13 secret nits | FIXED | DPAPI secret on stdin (checked live), clipboard hold expires after 60 s. The silent fallback to a `0600` file is documented, not shown in the UI. **Phase 36:** the fallback is now shown where it happens: a sign-in from the Integrations panel (Azure DevOps, browser or token) or the Teams card that went to the private file says so (`components/secretFileNote.ts`); `storedIn` travels from the secret store through the RPC to the UI. Tests: core (`loginWithBrowser` reports `file` when any copy fell back), Teams RPC, UI service, both cards; the card tests fail without the change |
| SEC-14 documentation drift | FIXED | plus a doc-drift item in the release checklist |

### Reliability
| ID | Status | Note |
|---|---|---|
| REL-01 global lock held across slow work | FIXED | |
| REL-02 resize under the global lock | FIXED | |
| REL-03 spurious exit after close | FIXED | |
| REL-04 Unix close sends only SIGHUP | FIXED | 500 ms grace then SIGKILL; test written, Unix: passed in CI |
| REL-05 read `Interrupted` ends output | FIXED | |
| REL-06 split character after an invalid byte | FIXED | |
| REL-07 login-shell PATH hang | FIXED | bounded read; Unix: passed in CI |
| REL-08 hand-off rough edges | FIXED | orphaned moved shell on Retry, double exit. The 60 ms settle and the 4,000-row snapshot cap are unchanged. **Phase 36:** the 4,000-row cap dropped the oldest 6,000 rows of the default 10,000-row scrollback on every move. The whole scrollback now goes along; only a pane whose snapshot is over 3 M characters gives up its oldest rows (halving), so a tab of six panes stays under the 32 MB window limit instead of being refused (`services/handoffSnapshot.ts`, 4 direct tests; the component test fails on the old code). The 60 ms settle is kept on purpose: the hand-off is an ordered protocol with an 8 MiB hold gate, and no lost output was seen in the end-to-end runs |
| REL-09 spawn before listeners | FIXED | |
| REL-10 `set_var` from a thread | FIXED | the login-shell PATH is applied first thing in `run()`, before other threads; the CLI helper no longer calls `set_var` on Unix. **Phase 36:** the login-shell probe's reader thread is joined before `set_var`, so the call runs before any other thread exists, which is the audit's fix. The only other production `set_var` is Windows-only (`kai_cli.rs`), where the environment API is thread-safe; on Unix that path records the folder for each child instead. `rustSetVarGuard.test.ts` fails if a new production `set_var`/`remove_var` appears, if the Windows one loses its `cfg`, or if the PATH step stops being the first statement of `run()` |
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
| PERF-08 WebGL budget / re-attach | BLOCKED (manual check) | bounded re-attach and a smaller budget in extra windows; two windows with 8 panes each not tried. **Phase 36:** what is left is a hands-on check, not code: two windows with eight panes each in a packaged build, watching for blank panes after switching |
| PERF-09 JSON-in-eval transport | VERIFIED NOT APPLICABLE | benchmarked first ([PERF-09-BENCHMARK](PERF-09-BENCHMARK.md)): the transport costs about 5 ms per MiB against about 1,000 ms per MB end to end (0.5 %), so a binary channel cannot make output noticeably faster on Windows/ConPTY; revisit if the backend gets an order of magnitude faster. Linux and macOS not measured |
| PERF-10 cold PowerShell at launch | FIXED | registry read; the PowerShell PATH write is gone too |
| PERF-11 font gate, eager addons | ACCEPTED | Search, Serialize and Image are fetched on first use (search bar opened, tab moved to another window, right after the pane is up). The font gate is kept: it protects the first cell measurement. The WebGL add-on (66 kB gzip) stays eager, because the first paint of a pane must not switch renderers. No cold-start trace was taken, so the gain is in bytes, not milliseconds. **Phase 36:** closed as is: the eager WebGL add-on and the font gate are deliberate (see above); a cold-start trace is a measurement for a GUI machine, not a change |
| PERF-12 cwd polling | ACCEPTED | the 5 s poll is kept but quiet (never causes a git probe); macOS `lsof` cadence unchanged, Unix: passed in CI. **Phase 36:** the macOS `lsof` cadence needs a Mac to measure; the poll is already quiet (no git probe) |

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
| FUNC-07 persistence gaps | FIXED | 30 tabs, active tab, debounced; every other terminal window (New window or a dragged-out tab) now saves its tabs under its label, a window closed while others stay open forgets them, and the next launch offers all windows open at quit ("N tabs in M windows"); Load reopens the others with their tabs. Unit tests plus an end-to-end test in the real app (real window list and labels). Not observable end to end: the disk write across a real quit, because WebDriver gives every session a fresh profile |
| FUNC-08 spinner forever | FIXED | |
| FUNC-09 exit status lost | FIXED | a failed shell (non-zero or unknown status) keeps its pane open with the output, the exit code (hex too for Windows statuses) and Restart / Close; a clean exit still closes; the last pane failing no longer quits the app; crash-loop and instant-death guards unchanged and also apply after Restart |
| FUNC-10 key and clipboard edges | FIXED | AltGr, denied clipboard. Focus after a palette action: switching tabs already handed focus to the new pane; closing a pane (shortcut, palette, or after the close confirmation) left focus on nothing, and now hands it to the pane that is left |
| FUNC-11 absent terminal features | ACCEPTED | optional, each needs a stated user problem. **Phase 36:** closed: each missing feature waits for a stated user problem, as the audit recommends |
| FUNC-12 spawn validation | FIXED | a folder as shell refused; when the backend opens the shell in the parent of a missing folder, the pane says so |
| FUNC-13 tab-strip details | FIXED | the tab context menu takes focus and works with Up/Down/Left/Right/Home/End, Escape returns focus to the tab; an interrupted drag (`pointercancel`: the browser taking a touch over, the system interrupting a pen) is now cancelled instead of committing the drop slot it stopped over; once a touch hold has lifted a tab, finger moves are kept from turning into a scroll that would cancel the drag. Not tried on a real touch screen or pen. Releasing a tab in the tear-off zone opens the new window at once with no confirmation: decided by the maintainer and pinned by a test; pointer capture was not added (the window-level listeners already receive the events, and capture does not prevent a cancel) |

### Architecture
| ID | Status | Note |
|---|---|---|
| ARCH-01 optional surfaces | ACCEPTED | call watcher gated; "what runs while idle" table added (read from code, not measured). **Phase 36:** the optional surfaces are gated and listed; measuring their idle cost needs a GUI profiling run |
| ARCH-02 four cwd mechanisms | ACCEPTED | shell reports are now a signal and the backend value is used; the mechanisms are not merged. **Phase 36:** the four mechanisms serve different sources (shell reports, the backend, polling, `cd` probes) and now agree on one value; merging them is a refactor with no bug behind it |
| ARCH-03 `TerminalView` too large | ACCEPTED | real-component tests cover startup order, keys, rendering, flow control, hand-off and search; the key handler moved to `services/terminalKeyHandler.ts` (13 direct tests) the WebGL renderer attach/detach/budget to `components/gpuRenderer.ts` (8 direct tests), and the output buffering, per-frame chunked writes and acknowledgement accounting to `services/terminalOutputPipeline.ts` (14 direct tests), and working-directory tracking to `services/paneCwdTracker.ts` (13 direct tests, plus 2 component tests for the probes after `cd`; probes still pending when a pane closes are now cancelled), and search to `hooks/useTerminalSearch.ts` with a shared lazy add-on slot (13 direct tests; closing search by the shortcut or palette now clears the highlights too, and a failed add-on load is retried), and the shell start and attach sequences to `services/paneSpawn.ts` (14 direct tests, plus 5 component tests written against the old code first: the folder fallback, a spawn failure, a failure in the default folder too, Retry, and a spawn overtaken by Retry). The file is 1,374 lines (was 1,778). What stays: the launch orchestration (sequence numbers, React state, the go-live and failure steps both paths share), the input filter for stray mouse/focus reports, paste and the settings effects. **Phase 36:** seven extractions, each with direct tests; what stays is the launch orchestration that ties them together. Further splitting has no bug behind it |
| ARCH-04 dead code | FIXED | autocomplete, typed-line recorder, `tokio` and `redact_secrets` removed; `interrupt_pty` is used by the tests and kept |
| ARCH-05 two runtimes | ACCEPTED | Node updated and automated; size unchanged. **Phase 36:** the bundled Node.js runs the `kai` CLI; its size is the price of not requiring Node on the user's machine |
| ARCH-06 drift | FIXED | doc-drift checklist and a test that fails when the version differs between `package.json`, the lock files, `tauri.conf.json` and `Cargo.toml`; it is still edited in each by hand. **Phase 36:** `npm run version:sync` copies the version from `package.json` (which `npx changeset version` bumps) to the lock file, `tauri.conf.json`, `Cargo.toml`, `Cargo.lock`, the website's package files and the installer names and tags in README/INSTALL; `-- --check` lists what differs. `syncVersion.test.ts` runs it on a copy of the real files; the release guide says to run it. The dev-only YouTube mirror in `vite.config.ts` stays (documented) |

### CI and tests
| ID | Status | Note |
|---|---|---|
| CI-01 GUI feature not built in CI | BLOCKED (GitHub run) | clippy and the GUI-feature tests run in CI; not yet run on a CI runner. **Phase 36:** done in the workflow; it needs the branch pushed so GitHub runs it |
| CI-02 release gate not tied to CI | FIXED | the gate requires a green `ci.yml` run for the tagged commit (not yet exercised on GitHub) |
| CI-03 supply-chain gates | BLOCKED (GitHub run) | `npm audit` and `cargo audit` job, weekly dependabot PRs (npm, cargo, actions), every action pinned to a commit SHA (a test guards it); CI, release and the Docker image build with one exact Rust version (`scripts/rust-toolchain-version.txt`, a test keeps them in agreement; local builds are not forced onto it); every release attaches CycloneDX SBOMs for the npm packages (bundled devDependencies and the Node runtime included) and the Rust crates and every installer and SBOM gets a GitHub-signed build-provenance attestation (`gh attestation verify`); a test keeps the attested and uploaded file lists identical. None of the release steps has run on GitHub yet. The pinned SHAs were taken from the GitHub API and have not run in Actions yet. **Phase 36:** needs a push to run |
| CI-04 no end-to-end UI test | BLOCKED (GitHub run) | `npm run test:e2e` drives the built app through tauri-driver with a small W3C WebDriver client (no new dependency): a command runs in a real shell, new tab, split, find, command palette, and a failed shell keeping its pane then Restart. The app under test has its own identifier (own profile and single-instance lock) and a throwaway home, so a running Kai is never touched. Passed 3 of 3 runs on Windows here (about 81 s). CI job `e2e` on Linux (Xvfb) and Windows is written but has not run on GitHub. macOS cannot be driven: there is no WebDriver for WKWebView. **Phase 36:** the `e2e` job needs a push to run for the first time |
| CI-05 PTY test depth | FIXED | churn, byte-exact flood, stalled consumer, busy sessions, child observes resize, close semantics added; the default Windows test shell is still `cmd.exe`. **Phase 36:** `test_25` runs PowerShell (the default shell on Windows): a command's output, and a resize seen by `$Host.UI.RawUI` |
| CI-06 performance not gated | FIXED | bundle size and a PTY throughput floor (a prompt consumer must keep above 260 kB/s; measured 0.97 to 1.24 MB/s here) are gated; no latency, cold-start or memory gate. **Phase 36:** keystroke-to-echo latency is gated (`test_26`: 25 keystrokes; median 6 to 8 ms and worst about 20 ms here, in 4 runs; limits 150 ms / 1.5 s, deliberately loose until CI numbers exist; not mutation-tested). Cold start and memory per pane stay ungated (ACCEPTED): they need a GUI runner |
| CI-07 duplicate work, no safeguards | FIXED | concurrency, timeouts, read-only permissions |
| CI-08 lint is only `tsc` | FIXED | ESLint now runs from an isolated `tools/lint` (ESLint 10.15.0, typescript-eslint 8.74.0 `recommended`, React hooks rules, its own TypeScript 6.0.3 and lockfile; maintainer's decision), `npm run lint:eslint` with no warnings allowed, CI job `lint`, weekly dependabot updates. Of the 66 first findings, 62 were intended (`_`-prefixed unused names, `any` in tests) and are allowed by config; the rest were fixed (2 `prefer-const`, 8 hook dependency lists in `App.tsx` and `TerminalView.tsx`, 8 stale `eslint-disable` comments). A conditional hook fails the gate. ESLint's core `recommended` rules were then enabled one at a time (phase 31): 30 dead stores removed (none was a bug), 17 empty `catch` blocks now say why ignoring the failure is safe, 4 test files that wrote Windows paths with single backslashes (which JavaScript silently drops, so the paths were never tested) now use real ones and still pass, 21 deliberate control-character regexes (terminal escape sequences, sanitizers) carry a reasoned per-line exception, and 3 single findings fixed. Then three type-aware rules that catch real bugs (phase 32: `no-floating-promises`, `no-misused-promises`, `await-thenable`; not the stylistic type-checked set): 35 findings, two real fixes (the command palette's Copy went straight to `navigator.clipboard`, so a denied clipboard failed silently with an unhandled rejection: it now uses the same fallback copy as the keyboard; a failing maximize-state read on resize was an unhandled rejection), a benchmark that called synchronous code 'concurrent requests', and React test helpers made `async` so their types match React 19's `act` (which is awaitable either way). Then four more (phase 33: `no-base-to-string`, `restrict-template-expressions`, `no-redundant-type-constituents`, `switch-exhaustiveness-check` with a `default` counting as exhaustive): a shared agent's output or a remote host's event with a non-text field (an object `model`, tool name or error message) showed as "[object Object]"; such fields now fall back to a plain default, and an object tool argument is shown as JSON. Azure DevOps pull-request fields are read the same way. YouTube player commands are now a closed type (`setVolume` was missing, so the type had been widened to any string and a misspelt command would have been ignored silently). The switch rule found nothing; it guards new union members. Read and not enabled: `only-throw-error` and `prefer-promise-reject-errors` (Tauri's `invoke` rejects with strings; every hit rethrew a caught value) and `return-await` (all 15 hits were style, none a promise returned unawaited inside a `try`). Then phase 34: `unbound-method` (off in tests, where `expect(mock.method)` is the idiom), `no-deprecated`, `no-misused-spread`, `use-unknown-in-catch-callback-variable`. No production bug: the flagged methods were closures that never use `this`, now typed as function properties (`close: () => void`), and integration write-method checks say `typeof ... === "function"`. Moved off deprecated APIs: `act` from `react` instead of `react-dom/test-utils` (9 test files), `RefObject` for `MutableRefObject`, `SubmitEvent` for `FormEvent`, vitest `toThrow`; `document.execCommand` stays as the clipboard fallback with a reasoned exception. A test mock spread the `PtyService` class, which copies nothing (static methods are not enumerable); it now states the one method it provides. Typing caught errors `unknown` showed three integration tests that read a 'rejection' without checking one happened; they now require an `IntegrationError`. Phase 35 closed the lint work: every remaining rule of the strict and stylistic type-checked sets was run and is either enabled or recorded as not enabled with its reason (table in [CI-08-LINT-INVESTIGATION](CI-08-LINT-INVESTIGATION.md)). Enabled: the `no-unsafe-*` rules for production code (113 findings; `any` came from `JSON.parse`, now typed `unknown` and narrowed, with one `ProjectMeta` shape check replacing five copies in the registry) and seven rules for code that does nothing. Real fixes: the MCP stdio server stopped answering for good after a line that is JSON but not an object (`null`), because reading `.method` threw out of its read loop; LSP definitions were cut from `file://` URIs as strings, so on Windows every path came out as `../../C:/...` and any space stayed `%20`, and requests sent `file://C:\...`; a `kai` config file holding `null` or a list broke `kai config get`. Not enabled after a trial: `no-unnecessary-condition`, `no-unnecessary-type-conversion`, `no-unnecessary-boolean-literal-compare` (their fixes remove runtime checks on data whose type is stronger than reality; reverted), `require-await`, `prefer-nullish-coalescing` and the style rules. Why it is isolated: TypeScript 7.0 has no classic compiler API, so typescript-eslint cannot run on it (upstream support targets the 7.1 native API). A separate TypeScript 6.0 used only by the linter works today: 462 files, 0 parse errors, 66 findings with the recommended rules. Recommended setup and numbers: [CI-08-LINT-INVESTIGATION](CI-08-LINT-INVESTIGATION.md); not installed, because it adds dev dependencies and a rule set |
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
| Keystroke-to-echo latency (`test_26`, 25 keystrokes) | not measured | median 6 to 8 ms, worst about 20 ms |
| `kai.exe` (default features, release) | 5,502,464 bytes | 5,716,480 bytes (+3.89%); of that, the OS certificate store (RES-09) is 13,824 bytes (5,702,656 without it, same tree) |
| App chunk loaded at every launch (gzip, Vite report) | 198.4 kB | 169.8 kB (-28.6 kB); the three add-ons now load on first use (4.8 + 9.8 + 18.6 kB) |
| Frontend tests | 2,703 | 3,141 (+27 skipped), plus 8 end-to-end workflows; ESLint (core, typescript-eslint, React hooks, and every type-aware rule chosen in phases 32 to 35) with no warnings |
| Rust lib tests | 270 | 310 |
| PTY integration tests | 19 | 30 (Windows; `test_25` is Windows-only) |
| GUI-feature tests | 0 | 28 |

Not measured at all: cold start, idle CPU and wake-ups, memory per pane, frame time, installer size. The audit's baseline procedures for those (TEST-AND-BENCHMARK-PLAN section 3) have not been run. They need a second Kai instance, and the single-instance rule hands a second launch to the one already running, so measuring on a machine that is using Kai would open a window in the user's own session; run them on a clean machine or after closing Kai.

## Open risks and decisions for the maintainer

1. Add the `UPDATE_SIGNING_KEY` GitHub secret (then delete the local key file); until then in-app updates fall back to the release page.
2. CI has run on GitHub and passed on all six platforms (with the Unix-only tests and the bundle-budget step). Still never run there: the weekly Node-update workflow, the release workflow (gate, SBOM, provenance, signed checksums) and the new end-to-end job (`e2e`), which needs a push.
3. Open the music player in a packaged build once: the narrowed CSP was checked by tests, not by playing a track.
4. Accepted as they are: `style-src 'unsafe-inline'`, `frame-src http://localhost:*`, the 60 ms hand-off settle, JSON-in-eval output transport, the font gate.
5. Found by the end-to-end tests and fixed: the app banners (session restore, split refused, shell keeps exiting) were painted under the terminal and their buttons took no clicks, because the terminal area became absolutely positioned in `187eb8a`; banners now have their own layer (`--z-banner`) and the end-to-end test checks the restore button is hit-test on top. Also found: the inline-image add-on (`@xterm/addon-image`) failed to start in the packaged app because the CSP `script-src` did not allow WebAssembly. Fixed on the maintainer's decision by adding only `'wasm-unsafe-eval'`; a unit test pins `script-src` to exactly `'self' 'wasm-unsafe-eval'`, and the end-to-end suite checks in the real app that WebAssembly compiles and page `eval` is still blocked (that check failed against the old build).
6. Noticed while removing dead stores, not changed (it would change behaviour): in `src/core/codeModeWorkflow.ts` the index-freshness checks treat a *failed* persistence-consistency check differently. Two places (`getValidatedFreshness`, the crash-recovery check before `indexProject`) count a failed check as consistent, so a result can still read `fresh`; another (the narrow-refresh path) counts it as a mismatch and rebuilds, with a comment that a torn snapshot "must never be reported as fresh". Worth deciding which is intended.
7. Test runs on a loaded machine: twice, a full `vitest run` left out `appShell.test.tsx` (102 tests) entirely and still reported success with zero failures; the file passes on its own and in the next full run. CI and release now run `npm run test:ci`, which fails, naming the files, when any test file Vitest selects has no results (`scripts/check-test-run.mjs`; checked against the report of that bad run, where it names `appShell.test.tsx`). A timing threshold in `lspDetection.test.ts` that failed under load was loosened to what still separates a blocked event loop from a busy one. One more timing-dependent test was found by running the full suite repeatedly (6 idle runs clean; under load, two suites at once, 1 failure in 4): the REL-09 startup test in `terminalViewStartup.test.tsx` relied on a 300 ms timer outlasting a 200 ms wait. Its listener is now released by the test itself; it still fails when the shell start stops waiting for the listener, and passed 15 of 15 runs under load.
8. What only the maintainer can do now (phase 36 ended the code work), in order:
   1. Push `audit/remaining-tasks` so CI runs it (CI-01, CI-03, CI-04 and every commit after `667bcc8`), and read the `test_26` latency numbers from the PTY step on each platform; tighten its limits if they allow.
   2. Add the `UPDATE_SIGNING_KEY` secret (SEC-02, item 1).
   3. In a packaged build: two windows with eight panes each (PERF-08), and play a track in the music player (item 3).
   4. On Windows with Developer Mode on, run the symlink tests once (SEC-05).
   5. Decide item 6 (which freshness rule `codeModeWorkflow.ts` should follow).
