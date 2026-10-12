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
  execSync("npm run build:cli", { cwd: repoRoot, stdio: "inherit", shell: true });
  if (!fs.existsSync(bundledCli)) {
    console.error("[kai setup] Build did not produce " + bundledCli);
    process.exit(1);
  }
}

function onPath(dir) {
  const entries = (process.env.PATH || "").split(path.delimiter).map((s) => s.toLowerCase());
  return entries.includes(dir.toLowerCase());
}

/** Persistent per-user PATH entries (registry on Windows), not just this
 * process's copy — the installer may run in a shell started before PATH
 * was updated. */
function persistedPathContainsWindows(dir) {
  try {
    const out = execSync(
      `powershell -NoProfile -NonInteractive -Command "[Environment]::GetEnvironmentVariable('Path','User')"`,
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    );
    return out.split(";").some((s) => s.trim().toLowerCase() === dir.toLowerCase());
  } catch {
    return onPath(dir);
  }
}

/** Ensure `dir` is on the user's PATH automatically (no manual step).
 * Returns true when a terminal restart is needed to pick it up. */
function ensurePathWindows(dir) {
  if (onPath(dir) || persistedPathContainsWindows(dir)) return false;
  try {
    // Update the User-level PATH via PowerShell so it persists for all
    // future terminals. Idempotent: appends only when missing.
    const ps =
      `$p=[Environment]::GetEnvironmentVariable('Path','User');` +
      `if(($p -split ';') -notcontains '${dir}'){` +
      `[Environment]::SetEnvironmentVariable('Path',($p.TrimEnd(';')+';${dir}'),'User');'CHANGED'}` +
      `else{'PRESENT'}`;
    const out = execSync(`powershell -NoProfile -NonInteractive -Command "${ps}"`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (out.includes("CHANGED")) {
      console.log("[kai setup] Added to your user PATH automatically: " + dir);
    } else {
      console.log("[kai setup] Already on PATH.");
      return false;
    }
    return true;
  } catch {
    console.log("[kai setup] Could not update PATH automatically. Run once:");
    console.log(`  setx PATH "%PATH%;${dir}"`);
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

function setupUnix() {
  const targetDir = path.join(os.homedir(), ".local", "bin");
  fs.mkdirSync(targetDir, { recursive: true });
  const linkPath = path.join(targetDir, "kai");
  const shim = `#!/bin/sh\nexec "${process.execPath}" "${binShim}" "$@"\n`;
  try {
    if (fs.existsSync(linkPath)) fs.rmSync(linkPath, { force: true });
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
  const restartNeeded = ensurePathUnix(targetDir);
  if (!restartNeeded) console.log("[kai setup] Already on PATH.");
  else console.log("[kai setup] Restart your terminal, then run: kai --version");
  console.log("[kai setup] Verify: kai --version");
}

ensureBuild();
if (process.platform === "win32") setupWindows();
else setupUnix();
