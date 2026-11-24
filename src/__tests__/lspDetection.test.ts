import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * RES-02 (second half): `kai_get_lsp_status` probed every installed language server one after
 * another with a blocking `execSync(... --version)` (2 s timeout each): 4 s observed in the
 * local metrics, with the event loop blocked for all of it. It now probes them all at once,
 * asynchronously, and remembers the answer for a few minutes.
 */
const PROBE_MS = 250;
const probes = { started: 0, running: 0, peak: 0, commands: [] as string[] };

vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  return {
    ...actual,
    exec: ((command: string, _options: unknown, callback: (e: null, out: string) => void) => {
      probes.started += 1;
      probes.running += 1;
      probes.peak = Math.max(probes.peak, probes.running);
      probes.commands.push(command);
      setTimeout(() => {
        probes.running -= 1;
        callback(null, `${command.split(" ")[0]} 9.9.9\nsecond line\n`);
      }, PROBE_MS);
      return {};
    }) as unknown as typeof actual.exec,
  };
});

import {
  KNOWN_LSP_SERVERS,
  LSP_DETECTION_TTL_MS,
  detectInstalledLspServersAsync,
  detectInstalledLspServersCached,
  resetLspDetectionCache,
} from "../core/lspBridge";

let binDir = "";
let savedPath: string | undefined;

beforeEach(() => {
  // Every catalog server "installed": an empty executable per command on PATH.
  binDir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-lsp-bin-"));
  for (const entry of KNOWN_LSP_SERVERS) {
    const file = path.join(binDir, entry.command + (process.platform === "win32" ? ".cmd" : ""));
    fs.writeFileSync(file, "");
    fs.chmodSync(file, 0o755);
  }
  savedPath = process.env.PATH;
  process.env.PATH = binDir;
  if (process.platform === "win32") process.env.PATHEXT = ".CMD;.EXE";
  Object.assign(probes, { started: 0, running: 0, peak: 0, commands: [] });
  resetLspDetectionCache();
});

afterEach(() => {
  process.env.PATH = savedPath;
  fs.rmSync(binDir, { recursive: true, force: true });
  resetLspDetectionCache();
});

describe("language server detection", () => {
  it("probes every installed server at the same time, not one after another", async () => {
    const started = Date.now();
    const detected = await detectInstalledLspServersAsync();
    const elapsed = Date.now() - started;

    expect(detected).toHaveLength(KNOWN_LSP_SERVERS.length);
    expect(detected.every((d) => d.isAvailable && d.version === `${d.command} 9.9.9`)).toBe(true);
    expect(probes.peak).toBe(KNOWN_LSP_SERVERS.length); // all in flight together
    // Serial would take PROBE_MS per server; parallel takes about one.
    expect(elapsed).toBeLessThan(PROBE_MS * KNOWN_LSP_SERVERS.length * 0.75);
  });

  it("does not block the event loop while it probes", async () => {
    let ticks = 0;
    const timer = setInterval(() => (ticks += 1), 10);
    await detectInstalledLspServersAsync();
    clearInterval(timer);
    // ~250 ms of probing. A blocked loop records at most one tick (a timer can only fire once the
    // block ends); a free one records ~25 when idle, and 8 was seen with the whole suite loading the
    // machine. More than 2 tells the two apart without depending on how busy the machine is.
    expect(ticks).toBeGreaterThan(2);
  });

  it("reports servers that are not installed without probing them", async () => {
    process.env.PATH = os.tmpdir() + path.delimiter + "/definitely/not/here";
    // (os.tmpdir() holds none of the catalog commands.)
    const detected = await detectInstalledLspServersAsync();
    const missing = detected.filter((d) => !d.isAvailable);
    expect(missing.length).toBeGreaterThan(0);
    for (const d of missing) {
      expect(d.version).toBeUndefined();
      expect(d.installHint).toBeTruthy();
    }
    expect(probes.commands.some((c) => c.startsWith("gopls"))).toBe(false);
  });

  it("remembers the answer for a few minutes, then probes again", async () => {
    const t0 = 1_000_000;
    await detectInstalledLspServersCached(t0);
    const first = probes.started;
    expect(first).toBe(KNOWN_LSP_SERVERS.length);

    await detectInstalledLspServersCached(t0 + 60_000);
    expect(probes.started).toBe(first); // served from memory: no process at all

    await detectInstalledLspServersCached(t0 + LSP_DETECTION_TTL_MS + 1);
    expect(probes.started).toBe(first * 2); // stale: probed again
  });

  it("calls that arrive while a probe is running share it", async () => {
    const [a, b, c] = await Promise.all([
      detectInstalledLspServersCached(),
      detectInstalledLspServersCached(),
      detectInstalledLspServersCached(),
    ]);
    expect(probes.started).toBe(KNOWN_LSP_SERVERS.length); // one probe, not three
    expect(b).toBe(a);
    expect(c).toBe(a);
  });
});
