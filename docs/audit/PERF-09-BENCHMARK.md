# PERF-09 benchmark: is a binary output channel worth it?

Question: PTY output reaches the webview as Tauri events, each one a JavaScript source string the
webview compiles and runs, with the output as a JSON string literal inside
(`tauri/src/event/mod.rs`, `emit_js_script`). Would a binary channel make the terminal faster?

Measured 2026-11-24 on the development machine (Windows 11, ConPTY, WebView2 157, cmd.exe as the
flooding shell). Three runs each.

| Measure | Run 1 | Run 2 | Run 3 |
|---|---|---|---|
| B1 backend alone: shell → ConPTY → Rust reader, 2.4 MB `type` flood (PTY integration test 24) | 1.32 MB/s | 1.36 MB/s | 1.33 MB/s |
| B2 transport: compile and run 256 Tauri-shaped event scripts of 64 KiB each (16 MiB of terminal-like text with escapes) in the real webview | 5.3 ms/MiB | 6.2 ms/MiB | 4.1 ms/MiB |
| B3 end to end in the real app: shell → PTY → events → xterm (DOM renderer), 30,000 coloured lines, until the last line is on screen | 0.84 MB/s | 0.89 MB/s | 1.01 MB/s |

How to reproduce: B1 `cargo test --no-default-features --manifest-path src-tauri/Cargo.toml --test pty_integration_tests test_24 -- --nocapture`; B2 and B3 `KAI_E2E_BENCH=1 npx vitest run -c vitest.e2e.config.ts e2e/output.bench.e2e.ts` (with the end-to-end setup from `e2e/globalSetup.ts`; results land in `test-results/perf09-*.json`).

## Reading

- At about 1 MB/s end to end a megabyte takes about 1,000 ms; the transport's compile-and-run
  part is about 5 ms of it (0.5 %). Removing it entirely could not make the terminal noticeably
  faster.
- B2 runs `eval` inside the page, so it leaves out the cross-process hop of WebView2's
  `ExecuteScript`. Even at three times the measured cost the transport stays under 2 %.
- The gap between B1 and B3 (about 0.4 s per MB) is mostly xterm parsing and DOM rendering (the
  WebGL renderer, the default, is lighter; the benchmark uses the DOM renderer because only it
  exposes the text), plus the measurement itself (typing the command, polling every 50 ms).

## Decision

Not worthwhile now: no binary channel. Revisit if the backend becomes an order of magnitude
faster (a PTY that delivers 10 MB/s or more would raise the transport's share towards 5 %), or if
a profile of a real session shows the event scripts as a hot spot. Not measured: Linux and macOS
(their PTYs are faster than ConPTY, so the share there would be larger; the benchmark runs on
those platforms through the same end-to-end setup on Linux).
