/**
 * Starts `tauri-driver` for the end-to-end run and stops it afterwards (CI-04).
 *
 * Isolation (the run must never touch a real Kai on the same machine):
 * - The app under test is built with src-tauri/tauri.e2e.conf.json, which gives it its own
 *   identifier: its own WebView2 / WebKit profile (settings, saved layout) and its own
 *   single-instance lock, so a Kai that is already running is neither used nor disturbed.
 * - It is built into its own folder (src-tauri/target/e2e), because other builds write
 *   target/debug/kai(.exe): `cargo test` compiles the windowless helper there. And the binary
 *   is refused unless it carries the e2e identifier, so the real app can never be launched.
 * - HOME / USERPROFILE point at a fresh temporary folder for the driver and everything it starts,
 *   so `~/.kai` (credentials, projects, metrics) is a throwaway copy.
 *
 * Environment:
 *   KAI_E2E_APP     the app binary (default: src-tauri/target/e2e/debug/kai[.exe])
 *   TAURI_DRIVER    the tauri-driver binary (default: `tauri-driver` on PATH)
 *   KAI_E2E_NATIVE_DRIVER  WebView2: path to msedgedriver; Linux: WebKitWebDriver (optional)
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Session, killApp } from "./webdriver";

export const DRIVER_URL = "http://127.0.0.1:4444";

/** Identifier the app under test must carry (src-tauri/tauri.e2e.conf.json). */
export const E2E_IDENTIFIER = "com.kai.terminal.e2e";

/**
 * How to build the app under test (also in the CI workflow). The target folder is relative on
 * purpose: the Tauri CLI runs cargo from src-tauri/, so it lands in src-tauri/target/e2e on every
 * platform and shell (an absolute path written by a POSIX shell is not one on Windows).
 */
export const BUILD_COMMAND =
  "CARGO_TARGET_DIR=target/e2e npx tauri build --debug --no-bundle --config src-tauri/tauri.e2e.conf.json";

let driver: ChildProcess | undefined;
let home: string | undefined;

export function appPath(): string {
  const exe = process.platform === "win32" ? "kai.exe" : "kai";
  return resolve(process.env.KAI_E2E_APP ?? join("src-tauri", "target", "e2e", "debug", exe));
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
      `App under test not found: ${app}. Build it with \`${BUILD_COMMAND}\` or set KAI_E2E_APP.`
    );
  }
  // Never launch a build with the real identifier: it would use the real profile and could hand
  // the launch to a Kai the developer is running.
  if (!readFileSync(app).includes(Buffer.from(E2E_IDENTIFIER))) {
    throw new Error(
      `${app} is not the end-to-end build (it does not carry ${E2E_IDENTIFIER}). ` +
        `Build it with \`${BUILD_COMMAND}\`.`
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
  await warmUp(app);
}

/**
 * Starts and quits the app once before any test. The very first launch on a fresh machine (a CI
 * runner) is the slow one: the WebView2 / WebKit runtime and the large debug binary are read from
 * a cold disk and scanned. Taking it here keeps it out of the first test's time limit. If the app
 * cannot start even with this long allowance, the run stops now with that reason instead of
 * failing every test the same way.
 */
async function warmUp(app: string): Promise<void> {
  const started = Date.now();
  try {
    const s = await Session.create(DRIVER_URL, app, 2, 150_000);
    await s.quit().catch(() => {});
    console.log(`[e2e] the app started and quit (warm-up) in ${Date.now() - started} ms`);
  } catch (err) {
    await teardown();
    const reason = err instanceof Error ? err.message : String(err);
    // `cause` keeps the original error (the project's lib is ES2020, before Error's options).
    throw Object.assign(new Error(`[e2e] the app under test never started (warm-up): ${reason}`), {
      cause: err,
    });
  } finally {
    killApp(app);
  }
}

export async function teardown(): Promise<void> {
  killApp(appPath());
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
