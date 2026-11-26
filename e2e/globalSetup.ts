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
 *   and KAI_HOME at its `.kai`, so `~/.kai` (credentials, projects, metrics) is a throwaway copy.
 *   Exception: on a Windows CI runner USERPROFILE stays the runner's own (see testEnv).
 *
 * Environment:
 *   KAI_E2E_APP     the app binary (default: src-tauri/target/e2e/debug/kai[.exe])
 *   TAURI_DRIVER    the tauri-driver binary (default: `tauri-driver` on PATH)
 *   KAI_E2E_NATIVE_DRIVER  WebView2: path to msedgedriver; Linux: WebKitWebDriver (optional)
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
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

/**
 * Whether USERPROFILE is replaced by the throwaway home. Not on a Windows CI runner: the WebView2
 * browser msedgedriver starts inherits it, and with a brand-new, empty profile it never opened its
 * DevTools port there ("DevToolsActivePort file doesn't exist" on every attempt, even after a
 * priming launch). The runner is discarded after the job, and KAI_HOME still sends `~/.kai` to
 * the throwaway folder. Locally (no CI variable) the full isolation stays.
 */
function replacesUserProfile(): boolean {
  return !(process.platform === "win32" && process.env.CI);
}

/** Environment for the driver and every app launch: the throwaway home (see the header). */
function testEnv(dir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: dir,
    ...(replacesUserProfile() ? { USERPROFILE: dir } : {}),
    KAI_HOME: join(dir, ".kai"),
  };
}

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
    env: testEnv(home),
  });
  driver.on("error", (err) => {
    console.error(`[e2e] tauri-driver could not start: ${err.message}`);
  });
  await driverReady(30_000);
  if (process.platform === "win32" && replacesUserProfile()) await primeProfile(app);
  await warmUp(app);
}

/**
 * Windows: runs the app once without a driver before the first WebDriver session. The first
 * launch with a brand-new USERPROFILE (the throwaway home above) does per-profile first-run work
 * (Windows identity cache, WinINet, PowerShell caches), and while it does, the WebView2 browser
 * that msedgedriver starts never opens its DevTools port: the session fails after 60 s with
 * "DevToolsActivePort file doesn't exist", on a slow CI runner on every attempt. Once one launch
 * has run with the profile, sessions attach in about a second. KAI_E2E_PRIME_MS sets how long the
 * priming launch runs (default 45 s).
 */
async function primeProfile(app: string): Promise<void> {
  const ms = Number(process.env.KAI_E2E_PRIME_MS) || 45_000;
  const started = Date.now();
  const result = await probeDirectLaunch(app, ms);
  console.log(
    `[e2e] primed the profile with a direct launch (${Date.now() - started} ms): ${result}`
  );
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
  // Windows: while the attempts run, keep the latest picture of the WebView2 browser the driver
  // started, so a failure says why (no debugging switch, no DevToolsActivePort, no browser).
  let snapshot = "";
  const watch =
    process.platform === "win32"
      ? setInterval(() => {
          const now = webviewSnapshot();
          if (now) snapshot = now;
        }, 10_000)
      : undefined;
  try {
    // Up to three attempts (msedgedriver gives each 60 s); see primeProfile for why a first
    // launch on Windows can fail to attach.
    const s = await Session.create(DRIVER_URL, app, 3, 150_000);
    await s.quit().catch(() => {});
    console.log(`[e2e] the app started and quit (warm-up) in ${Date.now() - started} ms`);
  } catch (err) {
    if (watch) clearInterval(watch);
    if (process.platform === "win32") {
      console.warn(`[e2e] WebView2 browser during the attempts:\n${snapshot || "(none seen)"}`);
      console.warn(`[e2e] msedgedriver log:\n${driverLogDigest()}`);
    }
    console.warn(`[e2e] launched directly: ${await probeDirectLaunch(app)}`);
    await teardown();
    const reason = err instanceof Error ? err.message : String(err);
    // `cause` keeps the original error (the project's lib is ES2020, before Error's options).
    throw Object.assign(new Error(`[e2e] the app under test never started (warm-up): ${reason}`), {
      cause: err,
    });
  } finally {
    if (watch) clearInterval(watch);
    killApp(app);
  }
}

/**
 * Windows: the browser process msedgedriver's launch produced (its profile is a `scoped_dir`
 * temp folder): full command line and the files in its profile. Empty when there is none.
 */
function webviewSnapshot(): string {
  const script = [
    "Get-CimInstance Win32_Process -Filter \"Name='msedgewebview2.exe'\" |",
    "  Where-Object { $_.CommandLine -match 'scoped_dir' -and $_.CommandLine -notmatch '--type=' } |",
    "  ForEach-Object {",
    '    "browser pid $($_.ProcessId), parent $($_.ParentProcessId)"',
    '    "command line: $($_.CommandLine)"',
    "    $d = [regex]::Match($_.CommandLine, 'user-data-dir=\"?([^\"]+)').Groups[1].Value",
    "    \"profile ${d}: \" + ((Get-ChildItem -Force -LiteralPath $d -ErrorAction SilentlyContinue | ForEach-Object Name) -join ', ')",
    "  }",
  ].join("\n");
  // -EncodedCommand (UTF-16LE base64): the script's quotes reach PowerShell unmangled.
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const r = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
    { encoding: "utf8", timeout: 20_000 }
  );
  return (r.stdout ?? "").trim();
}

/** The lines of the msedgedriver log (KAI_E2E_DRIVER_LOG, set in CI) that show each launch. */
function driverLogDigest(): string {
  const path = process.env.KAI_E2E_DRIVER_LOG;
  if (!path || !existsSync(path))
    return "(no log: set KAI_E2E_DRIVER_LOG to msedgedriver's --log-path)";
  const keep =
    /Starting Microsoft Edge WebDriver|WEBVIEW2_|Launching|DevTools|Failed|RESPONSE InitSession|ERROR/;
  const lines = readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter((l) => keep.test(l))
    .map((l) => l.slice(0, 1200));
  return lines.slice(-40).join("\n") || "(log has no matching lines)";
}

/**
 * Starts the app without any driver for `watchMs` and reports whether it stays up or exits, with
 * its code and output. Primes the profile on Windows (primeProfile), and diagnoses a warm-up that
 * failed: staying up means the driver cannot attach to its webview, exiting means the app itself
 * fails to start on this machine.
 */
async function probeDirectLaunch(app: string, watchMs = 20_000): Promise<string> {
  killApp(app);
  const child = spawn(app, [], {
    stdio: ["ignore", "pipe", "pipe"],
    env: home ? testEnv(home) : process.env,
  });
  let output = "";
  const keep = (chunk: Buffer) => {
    output = (output + chunk.toString()).slice(-4000);
  };
  child.stdout?.on("data", keep);
  child.stderr?.on("data", keep);
  const result = await new Promise<string>((done) => {
    const timer = setTimeout(() => done(`still running after ${watchMs} ms`), watchMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      done(`could not start: ${e.message}`);
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      done(`exited within ${watchMs} ms (code ${code}, signal ${signal})`);
    });
  });
  child.kill();
  killApp(app);
  return `${result}${output.trim() ? `\n--- app output ---\n${output.trim()}` : ""}`;
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
