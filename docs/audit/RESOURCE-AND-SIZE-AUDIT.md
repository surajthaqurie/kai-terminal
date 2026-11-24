# Resource and Size Audit

Repository `kai-terminal` @ `50f4c8c`, audited 2026-11-23. No tracked file was changed. Builds ran into scratch directories; the one side effect is that `npm pack --dry-run` re-created the gitignored `dist/cli/`.
Host: Windows 11 (build 26300), 16 cores, cargo 1.99, node 24.21. **Live RAM/CPU of the running app was not measured** (no GUI session); see [TEST-AND-BENCHMARK-PLAN](TEST-AND-BENCHMARK-PLAN.md) for the procedure.

## 1. Measured sizes

### 1.1 Rust binary (`cargo build --release --locked`, scratch target dirs)

| Variant | `kai.exe` bytes | vs baseline | Wall time | Note |
|---|---|---|---|---|
| Baseline (committed profile: `opt-level="s"`, fat LTO, `codegen-units=1`, `strip`, `panic="abort"`) | **5,502,464 (5.25 MiB)** | — | 6 m 25 s cold, effectively solo | includes the embedded 1.49 MiB frontend |
| `opt-level=3` | 7,624,704 (7.27 MiB) | +2,122,240 B (**+38.6 %**) | 8 m 10 s | ran concurrently with another build — **not like-for-like** |
| Direct `tokio` dependency removed | 5,495,296 | −7,168 B (**−0.13 %**) | 7 m 21 s | concurrent — build time not comparable |

The user's own `src-tauri/target` contains no `release/kai.exe` and no installers (only `debug/kai.exe`, 26.5 MB, and stale cross-target dirs). **Installer sizes were not measured** (nothing was packaged).

### 1.2 Bundled Node runtime and CLI (what ships as `resources`)

| Item | Raw | Gzip | Note |
|---|---|---|---|
| `src-tauri/resources/node/node.exe` (Node 22.12.0) | **82,818,704 B (79.0 MiB)** | 31.7 MB (`gzip -9` proxy) | ~15× the Rust binary; release builds only (`tauri.bundled-node.conf.json`) |
| `dist/cli` total | 4,309,072 B | ~1.69 MB | 84 % is the two lazy-loaded OpenAI BPE vocabularies (`o200k_base` 2.43 MB, `cl100k_base` 1.16 MB) |
| npm tarball (`npm pack --dry-run --ignore-scripts`) | 2,259,264 B (5.9 MB unpacked, 47 files) | — | ships the web `dist/` the CLI never uses |

### 1.3 Frontend (`npx vite build`, Vite 8.3.4, 30 s, 1,694 modules; `tsc --noEmit` 8.6 s clean)

| Chunk | Raw kB | Gzip kB | Loaded |
|---|---|---|---|
| `App-*.js` | 716.50 | 196.86 | dynamic `import("./App")` fired immediately from `main.tsx` — it *is* the app |
| `index-*.js` (react-dom 83 %, react 2.6 %) | 236.27 | 74.20 | eager |
| AiCliPanel / MusicPanel / applyTheme / SettingsModal / GitChangesModal / SharedAgentChat | 89.7 / 42.5 / 35.3 / 27.8 / 19.8 / 12.0 | 24.8 / 11.8 / 11.4 / 8.3 / 5.2 / 4.7 | lazy |
| All 30 JS files | **1,229,505 B** | **352,747 B** | |
| CSS (all) | 139,407 B | 23,058 B | 135 kB eager |
| 4 × variable woff2 | 188,924 B | — | `unicode-range` ⇒ ≈88.6 kB fetched at startup (Latin only) |
| Whole `dist/` | **1,561,444 B (1.49 MiB)** | | |

App-chunk composition (unminified sourcemap attribution — **proportions only**): xterm core 38.0 %, addon-webgl 13.5 %, app components 10.1 %, addon-image 6.6 %, app services 4.9 %, hooks 4.4 %, addon-search 4.2 %, addon-unicode11 3.4 %, addon-serialize 1.8 %, lucide-react 0.8 % ⇒ **~72 % of the App chunk is xterm + addons**.

Assets: `docs/` PNG screenshots 597 kB are doc-only and not bundled; Tauri icons total ~100 kB. No unused npm dependency was found (every `dependencies` entry is imported; dev tools all used).

### 1.4 Dependencies
- Rust: 368 unique crates in the resolved tree on this host. Duplicates (`cargo tree -d`): base64, bitflags, cpufeatures, getrandom ×3, hashbrown, indexmap, miniz_oxide, png, syn, **thiserror 1.0 (owned by this crate) vs 2.0 (tauri)**; all but thiserror come from tauri/wry/tao.
- `reqwest 0.12`: `default-features=false, rustls-tls, stream` ⇒ rustls + ring + **bundled webpki roots**; no OpenSSL/native-tls (good).
- `npm audit --omit=dev`: **0 vulnerabilities**. Full `npm audit`: 1 high (`undici` via `jsdom`, test-only). `kai-website/` (separate package): 2 (next, postcss) — not in CI. `cargo audit`/`cargo deny` are **not installed**; Rust advisories were **not checked**.

## 2. Findings

### RES-01 — Call watcher spawns `reg.exe` every 3 s from launch until exit, ungated
- **Resource / Medium (High if you weigh idle wake-ups heavily) / Confirmed (code + measurement).**
- **Location:** `src-tauri/src/call_watch.rs:308-326` (`spawn_call_watcher`, loop `:319-324`, `POLL_INTERVAL_SECS = 3` `:108`, `is_call_active` `:224-262`); started unconditionally at `src-tauri/src/lib.rs:831`. Only consumer: `useCallPause`, mounted solely inside `MusicPanel.tsx:636`.
- **Root cause:** the thread starts at app start, never stops and is gated on neither the music feature, focus/visibility, nor battery. Windows runs a recursive `reg query HKCU\…\ConsentStore\microphone /s /v LastUsedTimeStop`; Linux runs `pactl list source-outputs`; macOS reads CoreAudio and sometimes `ps`.
- **Repro:** Process Monitor (filter `reg.exe`) or `Get-WinEvent` process-creation events for 10 minutes with the music panel never opened.
- **Impact:** user — avoidable wake-ups all day, even when minimised; measured cost per spawn 43 ms wall / 15.6 ms child CPU ⇒ ≈1,200 spawns/h ≈ 19 s of child CPU per hour (~0.5 % of one core) plus Defender/ETW noise (not measured). It also contradicts the project's own rule at `useTerminalConfig.ts:100-106` (no child process around first PTY spawn): `reg.exe` is the first thing `setup()` launches. Technical — startup process churn alongside the `reg`/`cmd /c ver` probe and the PowerShell in PERF-10.
- **Fix (S gating / M native):** start/stop from the frontend only while music is *playing* (`call_watch_set(enabled)`); back off to 15–30 s when idle; on Windows prefer `RegNotifyChangeKeyValue` on the consent-store key or one `RegQueryValueEx` through `windows-sys`; use absolute `System32\reg.exe`.
- **Verify:** zero `reg.exe` children while no music is playing; same process-creation count method before/after.

### RES-02 — Every `kai mcp` server runs a synchronous `git rev-parse` every 2 s for the whole agent session
- **Resource / Medium (High in combination with SEC-01) / Confirmed (code); latency observed in the local metrics file.**
- **Location:** `src/core/mcp.ts:849,909-923` (`TOOL_LIST_POLL_MS = 2000`) → `integrations/tools.ts:340-357` → `config.ts:126-139` (`execFileSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], {timeout: 5000})`).
- **Root cause:** polling a rarely-changing integration binding recomputes the project root by spawning git synchronously on each tick; the guard only checks `clientInitialized`, so it runs for the life of every MCP process, including when the agent is idle.
- **Impact:** user — ≈1,800 git spawns/h per MCP server (50–200 ms each on Windows with Defender) block the Node event loop (≈2.5–10 %), so MCP requests queue behind them; several agent sessions multiply it; technical — also visible in `~/.kai/metrics.jsonl`: `kai_get_lsp_status` took 4,064 ms because `detectInstalledLspServers()` (`lspBridge.ts:128-150`) runs up to four serial `execSync("<server> --version")` calls on the same loop.
- **Fix (S):** cache the root/binding for the process lifetime and watch the single binding file by `mtimeMs`/`fs.watch`, or drop the poll and signal `list_changed` after `kai integration` commands; make LSP probes async, parallel and cached.
- **Verify:** count `git` process creations from a running `kai mcp` for 5 minutes (0 idle); MCP round-trip p95 before/after.

### RES-03 — The bundled Node.js runtime dominates installer size and is pinned stale
- **Resource / Medium / Confirmed (size), Likely (security).**
- **Location:** `scripts/fetch-node.mjs` (`KAI_NODE_VERSION` default 22.12.0, Dec 2024), `src-tauri/tauri.bundled-node.conf.json`, `release.yml` "Fetch Node.js for the bundle".
- **Root cause:** ships an official Node binary (82.8 MB raw / ≈31.7 MB gzip proxy) so the `kai` CLI/MCP works without system Node (~15× the Rust binary); nothing bumps it (no dependabot/renovate); macOS needs JIT entitlements on it.
- **Impact:** user — ≈+30 MB compressed / +79 MiB installed per platform (×6 CI targets); technical — an unpatched JS runtime executing project-derived data and MCP traffic.
- **Fix:** (a) **do now (S):** bump to the current LTS and automate (a script/renovate rule that checks `nodejs.org/dist/index.json`), no size change; (b) lazy download with checksum on first CLI use — smaller installer but needs network and complicates offline/enterprise; (c) SEA/`pkg` — little gain; (d) move the hot MCP path to Rust — largest win, L. Trade-off summary: (a) size 0, startup 0, runtime 0, build 0, debug 0 but removes known CVEs; (b) size −30 MB compressed, first-use latency + failure mode.
- **Verify:** build installer with and without overlay; compare `node --version` of the bundle with latest LTS.

### RES-04 — No bundle-size budget; the App chunk is 716 kB (197 kB gz), ~72 % xterm + addons
- **Resource / Medium / Confirmed (numbers); startup effect Needs measurement.**
- **Location:** `vite.config.ts`, `src/components/TerminalView.tsx:11-18`, `src/main.tsx`.
- **Root cause:** all seven addons are statically imported, so Search/Image/Serialize/Unicode11 are parsed before the first terminal paints; the default 500 kB `chunkSizeWarningLimit` only warns.
- **Impact:** WebView cold start parses ≈958 kB eager JS (≈273 kB gz). Lazy-loading Search + Image (+ Serialize) would defer ≈11–13 % of the App chunk (≈70–90 kB minified, **estimated from proportions, not measured**).
- **Fix (S):** (1) CI size gate on gzip sizes of `index`/`App` (e.g. 215/85 kB); (2) `import()` Image/Search/Serialize on first use; (3) set `build.target` to the minimum supported WebView (low gain on Vite 8). Impact: size ↓ slightly; startup ↑ by an unmeasured amount; runtime unchanged; build time unchanged; debugging slightly harder (async addon load order).
- **Verify:** `npx vite build` before/after plus a WebView2 Performance trace.

### RES-05 — `tokio = { features = ["full"] }` is an unused direct dependency
- **Resource / Low / Confirmed (†).**
- **Location:** `src-tauri/Cargo.toml:15`.
- **Root cause:** no `tokio::` reference anywhere in `src-tauri/src` or tests (lead re-grep returned nothing). Tauri/reqwest already pull tokio with `rt-multi-thread, net, time, fs, io-util, sync`; `full` additionally forces `process, signal, macros, parking_lot, io-std, tokio-macros`.
- **Impact:** measured −7,168 B (−0.13 %); fewer proc-macro crates to compile. Hygiene only. **Trade-offs:** size −0.1 %, startup 0, runtime 0, build slightly faster, debugging 0.
- **Fix (S):** delete the line (builds fine on a scratch copy). **Verify:** release build + `cargo test --no-default-features --lib` + PTY tests; compare `cargo tree -i tokio -e features`.

### RES-06 — Release profile is already size-tuned; `opt-level=3` costs +38.6 % size (informational, no action)
- **Resource / Low / Confirmed.**
- **Location:** `src-tauri/Cargo.toml [profile.release]`.
- **Analysis / trade-offs for switching `"s"`→`3`:** size +2.1 MB (+38.6 % of the binary, only ≈+1.5 % of an installer dominated by Node); startup not measured (likely neutral — dominated by webview init); runtime gain small because the Rust side is I/O-bound (the heavy work is in the webview); build time +25 % or more (contended measurement); debugging unchanged (`strip=true` either way). **Recommendation: keep `"s"`.** If a PTY benchmark ever shows the reader/coalescer CPU-bound, use a per-package override (`[profile.release.package.portable-pty] opt-level = 3`) instead. `lto = "thin"` would cut CI build time at a small size cost (not measured). `panic = "abort"` means any panic in a PTY thread kills the app and every shell; panic hygiene in audited files is good (RELIABILITY-AND-SECURITY §6).
- **Verify:** only with the PTY flood benchmark (test plan §3).

### RES-07 — Outbound contacts at every launch are not stated next to the "no telemetry" claim
- **Resource/Privacy / Low / Confirmed.**
- **Location:** `index.html:5` (`<link rel="preconnect" href="https://www.youtube-nocookie.com">`, unconditional), `src/hooks/useAppUpdates.ts` (default-on update check, 24 h throttle, `api.github.com`), `src/App.tsx:250`.
- **Impact:** a TLS handshake to YouTube at cold start even if music is never used; the README's "no account and no telemetry" stays technically true (`src/core/telemetry.ts` is a local `~/.kai/metrics.jsonl` writer, no HTTP) but the two launch-time contacts are undocumented there.
- **Fix (S):** inject the preconnect when the Music panel opens; document the update check next to the privacy claim (consider a first-run choice).
- **Verify:** `netstat`/Wireshark at launch with updates off.

### RES-08 — npm package contents and dependency placement
- **Resource / Low / Confirmed.**
- **Location:** `package.json`.
- **Root cause / fix (S):** `gpt-tokenizer` is a runtime `dependency` but is fully bundled into `dist/cli` (`ssr.noExternal`) and unused by the frontend → move to `devDependencies`; `files: ["bin","dist"]` publishes the 1.49 MiB web `dist/` the CLI never uses → restrict to `dist/cli`; no `engines` field although the bundle targets Node 20 → add `"engines": {"node": ">=20"}`.
- **Impact:** every `npm i -g kai-terminal` downloads an unnecessary dependency and ~1.5 MB; **Verify:** `npm pack --dry-run --ignore-scripts`.

### RES-09 — `reqwest` trusts bundled Mozilla roots, not the OS store
- **Resource/Reliability / Low / Likely.**
- **Location:** `src-tauri/Cargo.toml` reqwest `rustls-tls`; used by `updater.rs` and `shell.rs` (YouTube search).
- **Impact:** the Rust-side update download fails behind TLS-intercepting corporate proxies whose CA is only in the OS store, while webview-side requests work. **Fix (S):** `rustls-tls-native-roots`. Size effect not measured. **Verify:** test behind a MITM proxy with its CA in the OS store.

### RES-10 — Memory per pane scales with scrollback; default is moderate, maximum is not
- **Resource / Low / Needs measurement (derived).**
- **Location:** `src/services/settingsService.ts:183,316` (default 10,000, clamp 1,000–100,000); xterm `BufferLine = Uint32Array(3·cols)`.
- **Estimate (derived, not measured):** ≈14.4 MB per pane at 10k × 120 cols once full, ≈144 MB at 100k × 120 (×8 panes ≈ 1.15 GB). Lines allocate lazily; an idle pane that once printed a lot keeps the cost. The settings UI accepts >100,000 until save (clamped in `normalize`).
- **Fix (S):** document the cost next to the setting; consider a soft warning above ~50k lines; measure with the memory-per-pane benchmark. **Verify:** WebView private bytes with 1 vs 8 panes after `seq 1 200000` each.

## 3. Optimisation guidance (what to do, what not to do)

| Proposal | Size | Startup | Runtime | Build time | Debugging | Recommendation |
|---|---|---|---|---|---|---|
| Bump + automate bundled Node (RES-03a) | 0 | 0 | 0 | 0 | 0 | **Do** (security) |
| Lazy-download Node (RES-03b) | −30 MB compressed | 0 / first-use delay | 0 | 0 | more failure modes | Only if size is a product goal |
| Lazy-load Search/Image/Serialize addons (RES-04) | −70–90 kB (est.) | + (unmeasured) | 0 | 0 | async order | Do after measuring |
| CI bundle budget (RES-04) | 0 | 0 | 0 | +seconds | 0 | **Do** |
| Remove direct `tokio` (RES-05) | −7 kB | 0 | 0 | slight ↓ | 0 | Do (hygiene) |
| `opt-level=3` (RES-06) | +2.1 MB | unknown | small | +25 %+ | 0 | **Don't** (use per-crate if needed) |
| `lto="thin"` | small ↑ | ~0 | ~0 | big ↓ | 0 | Only for CI iteration builds |
| Drop YouTube preconnect (RES-07) | 0 | + (one socket) | 0 | 0 | 0 | Do |
| `native-roots` (RES-09) | unknown | 0 | 0 | 0 | 0 | Do if corp-proxy users exist |
| Remove fonts/images | — | — | — | — | — | **Nothing to remove**: fonts already `unicode-range`-split, screenshots not bundled |

Already good: panel code-splitting + idle prefetch, `unicode-range` fonts, tree-shaken `lucide-react`, no sourcemaps, single minified CLI with lazy tokenizer vocabularies, `strip`/LTO/`panic=abort`, no OpenSSL.
