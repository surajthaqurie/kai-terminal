#!/usr/bin/env node
/* Cross-platform `kai` PATH installer.
 *
 * Usage: npm run setup:cli
 *
 * What it does (Windows / Linux / macOS):
 *  1. Builds the CLI bundle if missing (`vite build --config vite.cli.config.ts`).
 *  2. Installs a `kai` launcher onto a user-level bin dir that is (or can be)
 *     on PATH:
 *     - Windows: %USERPROFILE%\.kai\bin\kai.cmd (+ kai.ps1 shim)
 *     - Linux/macOS: $HOME/.local/bin/kai (symlink or shell shim, chmod +x)
 *  3. Adds the bin dir to your user PATH automatically (Windows: User PATH
 *     registry entry; Linux/macOS: marked line in shell rc files) and prints
 *     the restart-terminal follow-up.
 *
 * Idempotent and never touches system dirs (no sudo/admin needed).
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execSync } = require("child_process");

const repoRoot = path.resolve(__dirname, "..");
const bundledCli = path.join(repoRoot, "dist", "cli", "index.js");
const binShim = path.join(repoRoot, "bin", "kai.js");

function newestSourceMtime(dirs) {
  let newest = 0;
  const walk = (d) => {
    let entries = [];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|js|json)$/.test(e.name)) {
        try {
          const t = fs.statSync(p).mtimeMs;
          if (t > newest) newest = t;
        } catch {}
      }
    }
  };
  for (const d of dirs) walk(d);
  return newest;
}

function ensureBuild() {
  // Skip flag for environments where the bundle is prebuilt (CI, re-runs).
  if (process.argv.includes("--skip-build") || process.argv.includes("--no-build")) {
    if (!fs.existsSync(bundledCli)) {
      console.error("[kai setup] --skip-build given but " + bundledCli + " is missing.");
      console.error("[kai setup] Re-run without the flag to build it.");
      process.exit(1);
    }
    console.log("[kai setup] Skipping build (--skip-build).");
    return;
  }
  // Fast path: rebuild only when sources are newer than the bundle.
  if (fs.existsSync(bundledCli)) {
    try {
      const bundleTime = fs.statSync(bundledCli).mtimeMs;
      const srcTime = newestSourceMtime([
        path.join(repoRoot, "src", "cli"),
        path.join(repoRoot, "src", "core"),
        path.join(repoRoot, "bin"),
      ]);
      if (bundleTime >= srcTime) {
        console.log("[kai setup] CLI bundle is up to date — skipping build.");
        return;
      }
    } catch {}
    console.log("[kai setup] Sources changed — rebuilding (npm run build:cli)...");
  } else {
    console.log("[kai setup] CLI bundle missing — building (npm run build:cli)...");
  }
  console.log("[kai setup] First build can take a minute; progress is below...");
  const startedAt = Date.now();
  try {
    execSync("npm run build:cli", {
      cwd: repoRoot,
      stdio: "inherit",
      shell: true,
      timeout: 10 * 60 * 1000,
    });
  } catch (err) {
    if (err && err.code === "ETIMEDOUT") {
      console.error("[kai setup] Build timed out after 10 minutes.");
      console.error(
        "[kai setup] Likely causes: antivirus/OneDrive locking dist/, or a stalled vite worker."
      );
      console.error(
        "[kai setup] Retry after pausing AV sync on this folder, or build with: npm run build:cli"
      );
    }
    process.exit(1);
  }
  console.log(`[kai setup] Build finished in ${((Date.now() - startedAt) / 1000).toFixed(1)}s.`);
  if (!fs.existsSync(bundledCli)) {
    console.error("[kai setup] Build did not produce " + bundledCli);
    process.exit(1);
  }
}

function onPath(dir) {
  const entries = (process.env.PATH || "").split(path.delimiter).map((s) => s.toLowerCase());
  return entries.includes(dir.toLowerCase());
}

const PS_TIMEOUT_MS = 15000;

/**
 * Run a PowerShell snippet with a hard timeout. Prefers `pwsh`
 * (PowerShell 7, faster cold start) and falls back to Windows
 * PowerShell 5.1. Returns stdout, or null when PowerShell is
 * missing, blocked, or hung — callers must degrade to manual
 * instructions instead of hanging the install forever.
 */
function runPowerShell(script, timeoutMs = PS_TIMEOUT_MS) {
  const candidates = [];
  try {
    const where = execSync("where pwsh", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    })
      .trim()
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    for (const w of where) candidates.push(`"${w}"`);
  } catch {
    // pwsh not on PATH — fall back to Windows PowerShell below.
  }
  candidates.push("powershell");
  for (const bin of candidates) {
    const last = bin === candidates[candidates.length - 1];
    try {
      return execSync(`${bin} -NoProfile -NonInteractive -Command "${script}"`, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: timeoutMs,
      });
    } catch (err) {
      if (!last) continue; // timed-out pwsh: try Windows PowerShell next.
      return null; // hung/blocked shell: caller prints manual steps.
    }
  }
  return null;
}

/** Persistent per-user PATH entries (registry on Windows), not just this
 * process's copy — the installer may run in a shell started before PATH
 * was updated. */
function persistedPathContainsWindows(dir) {
  const out = runPowerShell(`[Environment]::GetEnvironmentVariable('Path','User')`);
  if (out == null) return onPath(dir);
  return out.split(";").some((s) => s.trim().toLowerCase() === dir.toLowerCase());
}

/** Ensure `dir` is on the user's PATH automatically (no manual step).
 * Returns true when a terminal restart is needed to pick it up. */
function ensurePathWindows(dir) {
  if (onPath(dir) || persistedPathContainsWindows(dir)) return false;
  try {
    // Update the User-level PATH via PowerShell so it persists for all
    // future terminals. Idempotent: appends only when missing.
    // Bounded by a timeout: a hung shell (slow .NET JIT, AV hook,
    // constrained-language policy) must not freeze the whole install.
    const ps =
      `$p=[Environment]::GetEnvironmentVariable('Path','User');` +
      `if(($p -split ';') -notcontains '${dir}'){` +
      `[Environment]::SetEnvironmentVariable('Path',($p.TrimEnd(';')+';${dir}'),'User');'CHANGED'}` +
      `else{'PRESENT'}`;
    const out = runPowerShell(ps, 20000);
    if (out == null) {
      console.log("[kai setup] PowerShell did not respond (timed out).");
      console.log("[kai setup] Add to PATH manually (one-time), then open a NEW terminal.");
      console.log('[kai setup] NOTE: do NOT use `setx PATH "%PATH%;..."` — setx silently');
      console.log("[kai setup] truncates values over 1024 chars and can corrupt your PATH.");
      console.log("[kai setup] Run this in PowerShell instead:");
      console.log(
        `[kai setup]   powershell -NoProfile -Command "[Environment]::SetEnvironmentVariable('Path', ([Environment]::GetEnvironmentVariable('Path','User').TrimEnd(';') + ';${dir}'), 'User')"`
      );
      return true;
    }
    if (out.includes("CHANGED")) {
      console.log("[kai setup] Added to your user PATH automatically: " + dir);
    } else {
      console.log("[kai setup] Already on PATH.");
      return false;
    }
    return true;
  } catch {
    console.log("[kai setup] Could not update PATH automatically. Run once in PowerShell:");
    console.log(
      `  powershell -NoProfile -Command "[Environment]::SetEnvironmentVariable('Path', ([Environment]::GetEnvironmentVariable('Path','User').TrimEnd(';') + ';${dir}'), 'User')"`
    );
    console.log('[kai setup] (Avoid `setx PATH "%PATH%;..."` — setx truncates over 1024 chars.)');
    return true;
  }
}

const KAI_RC_MARK = "# kai-terminal: kai CLI on PATH";

function ensurePathUnix(dir) {
  if (onPath(dir)) return false;
  const line = `export PATH="$HOME/.local/bin:$PATH"`;
  const home = os.homedir();
  const shell = (process.env.SHELL || "").toLowerCase();
  const targets = shell.includes("fish")
    ? [path.join(home, ".config", "fish", "config.fish")]
    : [path.join(home, ".bashrc"), path.join(home, ".zshrc"), path.join(home, ".profile")];
  let touched = false;
  for (const rc of targets) {
    try {
      let cur = "";
      try {
        cur = fs.readFileSync(rc, "utf8");
      } catch {
        cur = "";
      }
      if (cur.includes(KAI_RC_MARK) || cur.includes("$HOME/.local/bin")) continue;
      const block = rc.endsWith("config.fish")
        ? `\n${KAI_RC_MARK}\nfish_add_path ~/.local/bin\n`
        : `\n${KAI_RC_MARK}\n${line}\n`;
      fs.mkdirSync(path.dirname(rc), { recursive: true });
      fs.appendFileSync(rc, block, "utf8");
      touched = true;
      console.log("[kai setup] Added to PATH automatically in: " + rc);
    } catch {
      // ignore unwritable rc files; fall through to manual hint
    }
  }
  if (!touched) {
    console.log("[kai setup] Add to PATH manually (one-time):");
    console.log(`  ${line}`);
  }
  return true;
}

function setupWindows() {
  const targetDir = path.join(os.homedir(), ".kai", "bin");
  fs.mkdirSync(targetDir, { recursive: true });
  const cmdPath = path.join(targetDir, "kai.cmd");
  const ps1Path = path.join(targetDir, "kai.ps1");
  const nodeExe = process.execPath.includes(" ") ? `"${process.execPath}"` : process.execPath;
  fs.writeFileSync(cmdPath, `@echo off\r\n${nodeExe} "${binShim}" %*\r\n`, "utf8");
  fs.writeFileSync(
    ps1Path,
    `& "${process.execPath}" "${binShim}" @args\r\nexit $LASTEXITCODE\r\n`,
    "utf8"
  );
  console.log("[kai setup] Installed launcher: " + cmdPath);
  const restartNeeded = ensurePathWindows(targetDir);
  if (!restartNeeded) console.log("[kai setup] Already on PATH.");
  else console.log("[kai setup] Restart your terminal, then run: kai --version");
  console.log("[kai setup] Verify: kai --version");
}

function isDesktopBinaryCollision(linkPath) {
  // True when ~/.local/bin/kai exists but is NOT our Node CLI shim —
  // typically a symlink left by a desktop .deb/RPM/AppImage install
  // (e.g. -> /usr/bin/kai or /usr/bin/cross-platform-terminal-backend),
  // which makes `kai code .` open a NEW window instead of running the CLI.
  try {
    if (!fs.existsSync(linkPath)) return { collision: false };
    let real = null;
    try {
      real = fs.realpathSync(linkPath);
    } catch {}
    if (real && (real.endsWith("kai.js") || real.endsWith("dist/cli/index.js"))) {
      return { collision: false };
    }
    try {
      const st = fs.statSync(linkPath);
      if (st.isFile() && st.size <= 8192) {
        const head = fs.readFileSync(linkPath, "utf8").slice(0, 4096);
        if (head.includes("kai.js") || head.includes("dist/cli/index.js")) {
          return { collision: false };
        }
      }
    } catch {}
    return { collision: true, real };
  } catch {
    return { collision: false };
  }
}

function setupUnix() {
  const targetDir = path.join(os.homedir(), ".local", "bin");
  fs.mkdirSync(targetDir, { recursive: true });
  const linkPath = path.join(targetDir, "kai");
  const shim = `#!/bin/sh\nexec "${process.execPath}" "${binShim}" "$@"\n`;
  // Never blindly delete: a desktop-installer symlink at the same path
  // is the "kai code . opens a new terminal window" bug on Linux/macOS.
  // Back it up so the desktop GUI stays launchable under another name.
  const probe = isDesktopBinaryCollision(linkPath);
  if (probe.collision) {
    const backup = `${linkPath}.desktop-bak`;
    try {
      if (fs.existsSync(backup)) fs.rmSync(backup, { force: true });
      fs.renameSync(linkPath, backup);
      console.log("[kai setup] Found desktop binary shadowing the CLI at: " + linkPath);
      if (probe.real) console.log("[kai setup]   (was -> " + probe.real + ")");
      console.log("[kai setup] Backed it up to: " + backup);
    } catch {
      try {
        if (fs.existsSync(linkPath)) fs.rmSync(linkPath, { force: true });
      } catch {}
    }
  } else if (fs.existsSync(linkPath)) {
    try {
      fs.rmSync(linkPath, { force: true });
    } catch {}
  }
  try {
    fs.symlinkSync(binShim, linkPath);
    console.log("[kai setup] Symlinked: " + linkPath + " -> " + binShim);
  } catch {
    fs.writeFileSync(linkPath, shim, { mode: 0o755 });
    try {
      fs.chmodSync(linkPath, 0o755);
    } catch {}
    console.log("[kai setup] Installed shim: " + linkPath);
  }
  if (!onPath(targetDir)) {
    console.log("[kai setup] NOTE: ~/.local/bin is not on PATH in this shell.");
  }
  // PATH-order check (Linux/macOS): ~/.local/bin must come BEFORE
  // /usr/bin & /usr/local/bin, or the desktop /usr/bin/kai keeps winning
  // and every `kai code .` opens a new window. Works the same on macOS
  // (CLI shim) vs /Applications bundle (GUI never on PATH by default).
  try {
    const { execSync: ex } = require("child_process");
    const whichAll = ex("which -a kai 2>/dev/null || which kai 2>/dev/null", {
      encoding: "utf8",
    })
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (whichAll.length > 1) {
      console.log("[kai setup] NOTE: multiple `kai` on PATH (first wins):");
      for (const w of whichAll) console.log("[kai setup]   - " + w);
      if (whichAll[0] !== linkPath) {
        console.log("[kai setup] WARNING: " + whichAll[0] + " shadows " + linkPath);
        console.log(
          "[kai setup] Fix: put ~/.local/bin BEFORE /usr/bin on PATH, then restart the terminal."
        );
      }
    }
  } catch {}
  const restartNeeded = ensurePathUnix(targetDir);
  if (!restartNeeded) console.log("[kai setup] Already on PATH.");
  else console.log("[kai setup] Restart your terminal, then run: kai --version");
  console.log("[kai setup] Verify: kai --version  (should print `kai v...`, not open a window)");
}

ensureBuild();
if (process.platform === "win32") setupWindows();
else setupUnix();
