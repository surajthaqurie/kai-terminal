/**
 * PERF-09 benchmark: is the event transport (PTY output as JSON inside a script the webview
 * compiles and runs) worth replacing with a binary channel? Opt-in: KAI_E2E_BENCH=1.
 *
 * B2 transport: scripts of exactly the shape Tauri emits (tauri/src/event/mod.rs emit_js_script),
 *    each carrying a unique 64 KiB chunk of terminal-like output, compiled and run in the real
 *    webview. In-page `eval` leaves out the cross-process hop, so this is the compile/run part.
 * B3 end to end: a real flood through the app (shell, PTY, transport, xterm DOM renderer), timed
 *    until its last line is on screen. Compared with B1, the backend alone (PTY integration
 *    test 24, the same 30,000-line `type`/`cat` flood).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";
import { DRIVER_URL, appPath } from "./globalSetup";
import { Key, Session, waitFor } from "./webdriver";

const VISIBLE = '.tab-content[style*="block"]';
const enabled = process.env.KAI_E2E_BENCH === "1";

/** Results go to test-results/ (Vitest does not always show console output of e2e runs). */
function record(name: string, result: Record<string, unknown>, line: string) {
  mkdirSync("test-results", { recursive: true });
  writeFileSync(
    join("test-results", `perf09-${name}.json`),
    JSON.stringify({ ...result, line }, null, 2)
  );
  console.log(line);
}

describe.skipIf(!enabled)("PERF-09 output transport benchmark", () => {
  let s: Session;
  let dir: string;

  beforeAll(async () => {
    s = await Session.create(DRIVER_URL, appPath());
    await waitFor(
      "the first terminal",
      async () =>
        (await s.execute<number>(
          "return document.querySelectorAll('.xterm-rows, .xterm-screen').length;"
        )) > 0,
      60_000
    );
    await s.execute(
      "localStorage.clear(); localStorage.setItem('kai_renderer', 'dom'); location.reload();"
    );
    await waitFor(
      "the terminal after reload",
      async () =>
        (await s.execute<number>("return document.querySelectorAll('.xterm-rows').length;")) > 0,
      60_000
    );
    dir = mkdtempSync(join(tmpdir(), "kai-bench-"));
  });

  afterAll(async () => {
    await s?.quit().catch(() => {});
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("B2: transport cost per MiB (compile + run of event scripts)", async () => {
    const result = await s.execute<{ mib: number; ms: number; perMiB: number; chunks: number }>(`
      const CHUNK = 64 * 1024, CHUNKS = 256;
      let line = '';
      // Terminal-like text: colour escapes, CRLF, the characters JSON must escape.
      for (let i = 0; line.length < CHUNK; i++) line += '\\u001b[32mL' + String(i).padStart(7, '0') + '\\u001b[0m path\\\\to\\\\"file" ok\\r\\n';
      let received = 0;
      window.__kaiBench = (e) => { received += e.payload.data.length; };
      const scripts = [];
      for (let c = 0; c < CHUNKS; c++) {
        const data = c + ':' + line.slice(0, CHUNK - 8); // unique per chunk: no compile cache hits
        scripts.push("(function () { const fn = window['__kaiBench']; fn && fn({event: 'pty-output', payload: " +
          JSON.stringify({ id: 'pty-1', data }) + "}, [1]) })()");
      }
      const t0 = performance.now();
      for (const src of scripts) (0, eval)(src);
      const ms = performance.now() - t0;
      const mib = received / (1024 * 1024);
      return { mib, ms, perMiB: ms / mib, chunks: CHUNKS };
    `);
    record(
      "b2",
      result,
      `[PERF-09] B2 transport: ${result.mib.toFixed(1)} MiB in ${result.ms.toFixed(0)} ms = ` +
        `${result.perMiB.toFixed(1)} ms per MiB (${result.chunks} scripts of 64 KiB)`
    );
  });

  it("B3: a real flood through the app, end to end", async () => {
    const LINES = 30_000;
    let body = "";
    for (let i = 1; i <= LINES; i++)
      body += `\x1b[32mL${String(i).padStart(7, "0")}\x1b[0m the quick brown fox jumps over the lazy dog\r\n`;
    body += "KAI-BENCH-END\r\n";
    const file = join(dir, "flood.txt");
    writeFileSync(file, body);
    const bytes = Buffer.byteLength(body);
    const command =
      process.platform === "win32"
        ? `cmd /c type "${file}"`
        : `cat '${file.replace(/'/g, "'\\''")}'`;

    const input = (await s.findAll(`${VISIBLE} .xterm-helper-textarea`))[0];
    await waitFor(
      "a prompt",
      async () =>
        (
          (await s.execute<string>(
            "const r = document.querySelector(arguments[0] + ' .xterm-rows'); return r ? r.textContent : '';",
            VISIBLE
          )) ?? ""
        ).trim().length > 0,
      30_000
    );
    const started = Date.now();
    await s.type(input, `${command}${Key.Enter}`);
    // The marker is only in the file (not in the typed command), so one sighting means done.
    await waitFor(
      "the end of the flood",
      async () => {
        const text = await s.execute<string>(
          "const r = document.querySelector(arguments[0] + ' .xterm-rows'); return r ? r.textContent : '';",
          VISIBLE
        );
        return text.includes("KAI-BENCH-END");
      },
      120_000,
      50
    );
    const elapsed = (Date.now() - started) / 1000;
    record(
      "b3",
      { bytes, seconds: elapsed, mbPerSec: bytes / elapsed / 1e6, platform: process.platform },
      `[PERF-09] B3 end to end: ${(bytes / 1e6).toFixed(2)} MB in ${elapsed.toFixed(2)} s = ` +
        `${(bytes / elapsed / 1e6).toFixed(2)} MB/s (DOM renderer, ${process.platform})`
    );
  });
});
