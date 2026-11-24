/**
 * Starts `tauri-driver` for the end-to-end run and stops it afterwards (CI-04).
 *
 * Isolation (the run must never touch a real Kai on the same machine):
 * - The app under test is built with src-tauri/tauri.e2e.conf.json, which gives it its own
 *   identifier: its own WebView2 / WebKit profile (settings, saved layout) and its own
 *   single-instance lock, so a Kai that is already running is neither used nor disturbed.
 * - HOME / USERPROFILE point at a fresh temporary folder for the driver and everything it starts,
 *   so `~/.kai` (credentials, projects, metrics) is a throwaway copy.
 *
 * Environment:
 *   KAI_E2E_APP     the app binary (default: src-tauri/target/debug/kai[.exe])
 *   TAURI_DRIVER    the tauri-driver binary (default: `tauri-driver` on PATH)
 *   KAI_E2E_NATIVE_DRIVER  WebView2: path to msedgedriver; Linux: WebKitWebDriver (optional)
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const DRIVER_URL = "http://127.0.0.1:4444";

let driver: ChildProcess | undefined;
let home: string | undefined;

export function appPath(): string {
  const exe = process.platform === "win32" ? "kai.exe" : "kai";
  return resolve(process.env.KAI_E2E_APP ?? join("src-tauri", "target", "debug", exe));
}

async function driverReady(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${DRIVER_URL}/status`);
      if (res.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`tauri-driver did not start listening on ${DRIVER_URL}`);
}

export async function setup(): Promise<void> {
  const app = appPath();
  if (!existsSync(app)) {
    throw new Error(
      `App under test not found: ${app}. Build it with ` +
        "`npx tauri build --debug --no-bundle --config src-tauri/tauri.e2e.conf.json` " +
        "or set KAI_E2E_APP."
    );
  }
  home = mkdtempSync(join(tmpdir(), "kai-e2e-home-"));
  const args: string[] = [];
  if (process.env.KAI_E2E_NATIVE_DRIVER)
    args.push("--native-driver", process.env.KAI_E2E_NATIVE_DRIVER);
  driver = spawn(process.env.TAURI_DRIVER ?? "tauri-driver", args, {
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });
  driver.on("error", (err) => {
    console.error(`[e2e] tauri-driver could not start: ${err.message}`);
  });
  await driverReady(30_000);
}

export async function teardown(): Promise<void> {
  driver?.kill();
  driver = undefined;
  if (home) {
    try {
      rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // A process may still hold a file for a moment; the folder is in the temp dir anyway.
    }
  }
}
