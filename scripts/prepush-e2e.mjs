#!/usr/bin/env node
/**
 * Pre-push: builds the end-to-end app and runs `npm run test:e2e`, the same suite as the CI `e2e`
 * job. Skipped (with the reason) where it cannot run: macOS (no WebDriver for WKWebView), no
 * `tauri-driver` on PATH, or KAI_SKIP_E2E=1. On Windows tauri-driver needs msedgedriver matching
 * the installed WebView2, on PATH or in KAI_E2E_NATIVE_DRIVER; on Linux without a display the run
 * goes through xvfb-run.
 */
import { spawnSync } from "node:child_process";

const isWin = process.platform === "win32";

function skip(reason) {
  console.warn(`[pre-push] end-to-end tests SKIPPED: ${reason}`);
  process.exit(0);
}

function onPath(cmd) {
  const r = spawnSync(isWin ? "where" : "which", [cmd], { stdio: "ignore" });
  return r.status === 0;
}

function run(cmd, args, env = process.env) {
  console.log(`[pre-push] ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, { stdio: "inherit", shell: isWin, env });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

if (process.env.KAI_SKIP_E2E === "1") skip("KAI_SKIP_E2E=1");
if (process.platform === "darwin") skip("macOS has no WebDriver for WKWebView");
if (!onPath("tauri-driver")) skip("tauri-driver not on PATH (cargo install tauri-driver --locked)");
if (isWin && !process.env.KAI_E2E_NATIVE_DRIVER && !onPath("msedgedriver")) {
  skip("msedgedriver not on PATH and KAI_E2E_NATIVE_DRIVER not set");
}

// Same build as CI (e2e/globalSetup.ts BUILD_COMMAND); incremental, so quick when nothing changed.
run("npx", ["tauri", "build", "--debug", "--no-bundle", "--config", "src-tauri/tauri.e2e.conf.json"], {
  ...process.env,
  CARGO_TARGET_DIR: "target/e2e",
});

if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
  if (!onPath("xvfb-run")) skip("no display and no xvfb-run");
  run("xvfb-run", ["-a", "-s", "-screen 0 1920x1080x24", "npm", "run", "test:e2e"]);
} else {
  run("npm", ["run", "test:e2e"]);
}
