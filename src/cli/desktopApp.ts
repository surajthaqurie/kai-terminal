import path from "path";
import fs from "fs";
import os from "os";
import { execSync, spawn } from "child_process";
import { fileURLToPath } from "url";

/**
 * Locate the installed Kai Terminal desktop executable.
 *
 * The desktop binary has shipped under several names across releases and
 * platforms (`kai`, `cross-platform-terminal-backend`, `kai-terminal`).
 * All known names are probed so `kai code .` can launch the GUI regardless
 * of which package (deb/rpm/AppImage/dmg/nsis) installed it.
 */
export function findKaiAppBinary(): string | null {
  const home = os.homedir();
  let baseDir = process.cwd();
  try {
    baseDir = path.dirname(fileURLToPath(import.meta.url));
  } catch {
    // fallback to process.cwd()
  }

  const candidates: string[] = [
    // Linux — `kai` is the current product name; older builds used the
    // Cargo package name. NOTE: `~/.local/bin/kai` is ALSO the default
    // location of the Node CLI shim (`npm run setup:cli`). It is probed
    // here for convenience but isKaiCliShim() below guarantees a CLI
    // shim is never mistaken for the desktop GUI (the "kai code ."
    // opens a new window bug when the desktop .deb/RPM claimed the same
    // path and shadowed the CLI).
    path.join(home, ".local/bin/kai"),
    path.join(home, ".local/bin/cross-platform-terminal-backend"),
    path.join(home, ".local/bin/kai-terminal"),
    "/usr/local/bin/kai",
    "/usr/local/bin/cross-platform-terminal-backend",
    "/usr/bin/kai",
    "/usr/bin/cross-platform-terminal-backend",
    // Linux sandboxed / distro-specific locations (all OS-safe to probe;
    // existsSync is false elsewhere).
    "/snap/bin/kai",
    "/var/lib/flatpak/exports/bin/com.kai.terminal",
    path.join(home, ".local/share/flatpak/exports/bin/com.kai.terminal"),
    // macOS
    ...(process.platform === "darwin"
      ? [
          "/Applications/Kai Terminal.app/Contents/MacOS/kai",
          "/Applications/Kai Terminal.app/Contents/MacOS/cross-platform-terminal-backend",
          "/Applications/Kai Terminal.app/Contents/MacOS/kai-terminal",
          path.join(home, "Applications/Kai Terminal.app/Contents/MacOS/kai"),
          path.join(
            home,
            "Applications/Kai Terminal.app/Contents/MacOS/cross-platform-terminal-backend"
          ),
        ]
      : []),
    // Windows — NSIS installs under the product name; keep legacy names.
    ...(process.platform === "win32"
      ? [
          path.join(process.env.LOCALAPPDATA || "", "KaiTerminal", "kai.exe"),
          path.join(
            process.env.LOCALAPPDATA || "",
            "KaiTerminal",
            "cross-platform-terminal-backend.exe"
          ),
          path.join(process.env.PROGRAMFILES || "", "KaiTerminal", "kai.exe"),
          path.join(
            process.env.PROGRAMFILES || "",
            "KaiTerminal",
            "cross-platform-terminal-backend.exe"
          ),
        ]
      : []),
    // Dev builds
    path.resolve(baseDir, "../../src-tauri/target/debug/kai"),
    path.resolve(baseDir, "../../src-tauri/target/release/kai"),
    path.resolve(baseDir, "../../src-tauri/target/debug/kai.exe"),
    path.resolve(baseDir, "../../src-tauri/target/release/kai.exe"),
    path.resolve(baseDir, "../../src-tauri/target/debug/cross-platform-terminal-backend"),
    path.resolve(baseDir, "../../src-tauri/target/release/cross-platform-terminal-backend"),
  ];

  for (const c of candidates) {
    try {
      if (c && fs.existsSync(c)) {
        try {
          if (!fs.statSync(c).isFile()) continue;
        } catch {
          continue;
        }
        // Never treat the Node CLI shim as the desktop GUI — the shim
        // may live at the same path (e.g. ~/.local/bin/kai) depending on
        // install order / PATH precedence on Linux, macOS, and Windows.
        if (isKaiCliShim(c)) continue;
        return c;
      }
    } catch {
      // ignore
    }
  }

  // PATH lookup for every known binary name (covers custom install
  // prefixes, distro renames, and `npm i -g` shims on PATH). `which -a`
  // / `where` can return several lines — every line is probed so a CLI
  // shim shadowing the desktop binary (or vice versa) on any OS does not
  // hide the real GUI binary behind the first result.
  const binNames =
    process.platform === "win32"
      ? ["kai.exe", "cross-platform-terminal-backend.exe", "kai-terminal.exe", "kai"]
      : ["kai", "cross-platform-terminal-backend", "kai-terminal"];
  for (const name of binNames) {
    let lines: string[] = [];
    try {
      const cmd = process.platform === "win32" ? `where ${name}` : `which -a ${name}`;
      const out = execSync(cmd, { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
      lines = out
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
    } catch {
      // Fallback for minimal `which` implementations without `-a`.
      try {
        const cmd = process.platform === "win32" ? `where ${name}` : `which ${name}`;
        const out = execSync(cmd, { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
        lines = out
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter(Boolean);
      } catch {
        continue; // ignore — name not on PATH
      }
    }
    for (const found of lines) {
      try {
        if (!found || !fs.existsSync(found)) continue;
        if (!fs.statSync(found).isFile()) continue;
        if (isKaiCliShim(found)) continue;
        return found;
      } catch {
        // ignore this candidate
      }
    }
  }

  return null;
}

/**
 * True when `candidate` is the Node `kai` CLI launcher rather than the
 * Tauri desktop GUI binary. The CLI ships as `bin/kai.js` (Node) plus a
 * compiled bundle at `dist/cli/index.js`; user-level launchers are either
 * a symlink to `bin/kai.js` or a small shell/cmd shim that execs node with
 * that path. Those must never be treated as the desktop app or
 * `kai code .` would try to "launch" the CLI as if it were the GUI.
 *
 * Works on Linux, macOS, and Windows (checks symlink target realpath AND
 * text-shim content, since the `setup:cli` fallback writes a shell shim
 * whose realpath does NOT end in kai.js).
 */
export function isKaiCliShim(candidate: string): boolean {
  try {
    try {
      const real = fs.realpathSync(candidate);
      if (real.endsWith("kai.js") || real.endsWith("index.js")) return true;
    } catch {
      // not a resolvable symlink — fall through to content probe
    }
    try {
      const st = fs.statSync(candidate);
      if (!st.isFile()) return false;
      // Only sniff small text launchers; never read a multi-MB ELF.
      if (st.size > 8192) return false;
      const head = fs.readFileSync(candidate, "utf-8").slice(0, 4096);
      if (head.includes("kai.js") || head.includes("dist/cli/index.js")) return true;
      if (head.startsWith("#!") && head.toLowerCase().includes("node")) {
        // Generic node shebang launcher — treat as CLI shim only when it
        // lives alongside the repo's bin/ layout is unknown, so require
        // the kai.js marker above; plain node scripts are NOT shims.
      }
    } catch {
      // unreadable — not provably a shim
    }
  } catch {
    // ignore
  }
  return false;
}

/**
 * Environment for the spawned GUI. Code Mode travels ONLY through
 * `active_project.json` (written before launch, cleared by `kai stop code`
 * or the end of an agent run); an env var would be frozen into the app
 * process and pin Code Mode on for its lifetime, so stale ones inherited
 * from an older Kai tab are dropped too.
 */
function launchEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.KAI_ACTIVE_PROJECT;
  delete env.KAI_MODE;
  return env;
}

/**
 * Launch the Kai Terminal desktop GUI for a Code Mode project.
 *
 * Cross-OS behavior (only ever called by `kai code`, never by
 * `agent setup` / `status` / `query` / etc.):
 *   Linux   : detached spawn of the GUI binary with stdio ignored, so the
 *             caller's terminal is never blocked and no extra terminal
 *             window appears — the GUI opens as its own OS window.
 *   macOS   : direct spawn of `Kai Terminal.app/Contents/MacOS/kai` when
 *             found; otherwise `open -a "Kai Terminal" <path>` so the app
 *             bundle (not a stray Unix terminal) receives the open event.
 *   Windows : detached spawn with `windowsHide: true` so no ghost conhost
 *             window flashes alongside the GUI.
 *
 * Returns true when a launch was attempted.
 */
export function launchKaiApp(appBinary: string, projectPath: string): boolean {
  try {
    if (process.platform === "darwin" && appBinary.endsWith(".app/Contents/MacOS/kai")) {
      // Prefer the bundle open path when the raw Mach-O binary cannot be
      // spawned directly (quarantine / translocation edge cases).
      try {
        const child = spawn("open", ["-a", "Kai Terminal", projectPath], {
          detached: true,
          stdio: "ignore",
          env: launchEnv(),
        });
        child.unref();
        return true;
      } catch {
        // fall through to direct spawn
      }
    }
    const child = spawn(appBinary, [projectPath], {
      detached: true,
      stdio: "ignore",
      // Windows: never flash a ghost conhost window when
      // launching the desktop app from the CLI.
      windowsHide: true,
      env: launchEnv(),
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}
