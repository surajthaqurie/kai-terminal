import path from "path";
import fs from "fs";
import os from "os";
import { spawn, execSync } from "child_process";
import {
  registerProject,
  getProjectMeta,
  loadProjectIndex,
  deleteProjectData,
  ensureKaiDirectories,
  getProjectStorageDir,
  getSessionsDir,
  getCacheDir,
  getKaiHomeDir,
  checkPersistenceConsistency,
  listRegisteredProjects,
  resolveCanonicalPath,
} from "../core/registry";
import { indexProject, detectStaleIndexEntries } from "../core/indexer";
import { startMcpServer } from "../core/mcp";
import { runBenchmarks } from "../core/benchmarks";
import { getTelemetrySummary, clearMetricsLog } from "../core/telemetry";
import { detectInstalledLspServers } from "../core/lspBridge";
import {
  AGENT_REGISTRY,
  AgentDefinition,
  applyAgentSetup,
  autoSetupDetectedAgents,
  buildAgentSetup,
  detectInstalledAgentsSync,
  findDynamicAgentBinary,
  findBinaryOnPath,
  buildDynamicAgentSetup,
  listAgentIds,
  removeAgentSetup,
} from "../core/agents";
import {
  detectChangedFilesFromDisk,
  runCodeTaskWithAutoSync,
  runExternalAgentCommand,
  needsShellForCommand,
} from "../core/codeModeWorkflow";
import { installCommitMsgHook, hookStatus } from "../core/githooks";
import packageJson from "../../package.json";

export const KAI_VERSION: string = packageJson.version ?? "0.1.0";

/**
 * Persist active project info and sync SQLite localStorage for WebKitGTK/Tauri
 * so that when Kai opens (or gains focus), it automatically selects this project in Code Mode.
 */
export function saveActiveProjectState(
  projectPath: string,
  projectName: string,
  projectId: string,
  mode: string = "code"
): void {
  try {
    ensureKaiDirectories();
    const activeFile = path.join(getKaiHomeDir(), "active_project.json");
    fs.writeFileSync(
      activeFile,
      JSON.stringify(
        {
          id: projectId,
          name: projectName,
          path: projectPath,
          mode,
          timestamp: Date.now(),
        },
        null,
        2
      ),
      { mode: 0o600, encoding: "utf-8" }
    );
  } catch {
    // ignore
  }
}

/**
 * Clear Code Mode: removes the persisted active project so the desktop app
 * falls back to plain terminal mode. Never touches the project index data
 * (use `unregister` for that) or the repository itself.
 */
export function clearActiveProjectState(): void {
  try {
    ensureKaiDirectories();
    const activeFile = path.join(getKaiHomeDir(), "active_project.json");
    if (fs.existsSync(activeFile)) {
      fs.unlinkSync(activeFile);
    }
  } catch {
    // ignore
  }
}

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
 * Process names the Kai Terminal desktop app may run under. The current
 * release runs as `kai` (Tauri productName); older builds ran as
 * `cross-platform-terminal-backend` / `kai-terminal`. All must be detected
 * on every OS or `kai code .` spawns a duplicate window while Kai is
 * already running (the reported "new terminal opens on Linux" bug).
 */
const KAI_APP_PROCESS_NAMES = ["kai", "cross-platform-terminal-backend", "kai-terminal"] as const;

/** True when a `ps` output line belongs to the Kai desktop app (not the CLI). */
export function isKaiDesktopProcessLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  // The `kai` CLI itself runs as `node .../kai.js ...` — never treat the
  // Node CLI / MCP server as the desktop GUI.
  if (trimmed.includes("kai.js") || trimmed.includes("dist/cli")) return false;
  if (
    trimmed.includes("cross-platform-terminal-backend") ||
    trimmed.includes("cross-platform-") ||
    trimmed.includes("kai-terminal")
  ) {
    return true;
  }
  // Bare `kai` binary: match exact comm field or a path/command token, so
  // `opencode`, `ssh kai@host`, or `kaiman` never false-positive.
  // Both `/` (POSIX) and `\` (Windows) separators are accepted.
  if (trimmed === "kai" || trimmed === "kai.exe") return true;
  if (/(^|[/\\])kai(\.exe)?(\s|$)/.test(trimmed)) return true;
  const tokens = trimmed.split(/\s+/);
  if (
    tokens.some(
      (t) =>
        t === "kai" ||
        t === "kai.exe" ||
        t.endsWith("/kai") ||
        t.endsWith("\\kai") ||
        t.endsWith("/kai.exe") ||
        t.endsWith("\\kai.exe")
    )
  )
    return true;
  return false;
}

/**
 * Check if the Kai Terminal desktop app process is already running.
 *
 * Cross-platform strategy (first hit wins):
 *   Windows : `tasklist` scanned with word-boundary matching for every
 *             known exe name (a loose substring check false-positives on
 *             e.g. `opencode` tooling or `kaiman` utilities).
 *   Unix    : `pgrep -x` for short names (macOS + Linux) + `pgrep -f` for
 *             names longer than the kernel's 15-char comm limit
 *             (`cross-platform-terminal-backend` is 30 chars, so
 *             `pgrep -x` can NEVER match it — must match the full command
 *             line) → `pidof` (Linux only, macOS lacks it) → `ps` fallback
 *             scanning the full command line (`args`, not just `comm`,
 *             which the kernel truncates to 15 chars).
 */
export function isKaiAppRunning(): boolean {
  if (process.platform === "win32") {
    try {
      const out = execSync("tasklist", {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      const lines = out.split(/\r?\n/);
      const patterns = KAI_APP_PROCESS_NAMES.map(
        (n) => new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\.exe)?\\b`, "i")
      );
      return lines.some((line) => patterns.some((re) => re.test(line)));
    } catch {
      return false;
    }
  }

  // pgrep exists on both Linux and macOS (unlike pidof, which macOS lacks).
  // NOTE: `pgrep -x` matches the kernel comm field (max 15 chars). Long
  // legacy names MUST use `pgrep -f` (full command line) instead.
  for (const name of KAI_APP_PROCESS_NAMES) {
    const useFullMatch = name.length > 15;
    try {
      const cmd = useFullMatch ? `pgrep -f ${name}` : `pgrep -x ${name}`;
      const out = execSync(cmd, {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (out) {
        // `pgrep -f` can match its own invocation or the Node CLI string
        // containing the name (e.g. `node .../kai.js` probing). Verify via
        // the strict line classifier before trusting it.
        if (!useFullMatch) return true;
        try {
          const detail = execSync(`ps -o args= -p ${out.split(/\s+/)[0]}`, {
            encoding: "utf-8",
            stdio: ["ignore", "pipe", "ignore"],
          });
          if (isKaiDesktopProcessLine(detail)) return true;
          // Even if the first PID was a false positive, other PIDs from
          // the same pgrep output may be the real GUI — fall through to
          // the ps fallback scan below which classifies every line.
        } catch {
          return true; // pgrep matched but detail probe failed — trust it
        }
      }
    } catch {
      // no match for this name — try the next one
    }
  }

  try {
    const pids = execSync("pidof kai cross-platform-terminal-backend kai-terminal", {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (pids) return true;
  } catch {
    // pidof may not be installed or no match
  }

  // Fallback: full command lines. `comm` alone is unreliable — e.g. Linux
  // reports the running app as comm=`kai` while older checks only looked
  // for `cross-platform-`, so every `kai code .` spawned a duplicate window.
  for (const args of ["ps -A -o args", "ps -A -o pid,comm,args", "ps -A -o pid,comm"]) {
    try {
      const out = execSync(args, {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      for (const line of out.split("\n")) {
        if (isKaiDesktopProcessLine(line)) return true;
      }
      // `ps` ran fine but found nothing — don't try weaker variants.
      return false;
    } catch {
      // `ps` flag unsupported on this OS — try the next variant.
    }
  }

  return false;
}

/**
 * Build the verified MCP configuration snippet for an external agent.
 * Pure function (takes kaiBin explicitly) so Windows-style paths can be
 * unit-tested on any OS. Paths are JSON-escaped: interpolating a raw
 * Windows path (`C:\tools\...`) into the snippet would emit invalid JSON
 * (`\t` parses as a tab escape).
 *
 * Supported agents are defined in `src/core/agents.ts` (single source of
 * truth shared with dynamic system detection). Unknown ids return null.
 */
export const SUPPORTED_AGENTS: readonly string[] = listAgentIds();

export { buildAgentSetup, AGENT_REGISTRY };

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
          env: {
            ...process.env,
            KAI_ACTIVE_PROJECT: projectPath,
            KAI_MODE: "code",
          },
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
      env: {
        ...process.env,
        KAI_ACTIVE_PROJECT: projectPath,
        KAI_MODE: "code",
      },
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

export function isInsideKaiTerminal(): boolean {
  if (process.env.KAI_TERMINAL === "1") return true;
  if (process.env.TERM_PROGRAM === "kai") return true;
  if (process.env.VITEST || process.env.NODE_ENV === "test") return true;
  return false;
}

export const EXTERNAL_COMMANDS = new Set([
  "open",
  "close",
  "mcp",
  "help",
  "--help",
  "-h",
  "version",
  "--version",
  "-v",
]);

export function printHelp(): void {
  console.log(`
Kai Terminal — Project Intelligence & CLI (v${KAI_VERSION})
Lightweight terminal-first project intelligence tool for external AI coding agents.

Usage:
  kai <command> [options]

External Commands (Run outside or inside Kai Terminal):
  open [path]             Open or focus Kai Terminal for a project directory (defaults to .)
  close                   Close active Kai Terminal instances

Internal Commands (Run inside Kai Terminal):
  <agent> [path]          Launch an AI agent (claude, cursor, codex, gemini, opencode, aider, etc.)
  setup <agent|all>       Auto-wire Kai MCP into an agent's configuration (or all agents)
  list [options]          Inspect system resources:
                            -a, --agent     List AI agents & MCP status (default)
                            -i, --index     List indexed projects
                            -s, --session   List active session and cache files
                            -c, --config    List current configuration
  remove [options]        Remove resources:
                            -i, --index <path|id>   Delete project index (repo untouched)
                            -a, --agent <name>      Remove Kai MCP from an agent
                            -s, --session [target]  Delete session cache files
  graph <init|update|status> [path]
                          Manage project dependency graph & symbol index
  status [path]           Show project registration, health, and commit-hook status
  stop                    Clear Code Mode and return to plain terminal mode
  doctor                  Run environment & install diagnostics
  lsp                     Probe locally installed Language Server Protocol (LSP) servers
  metrics [clear]         Display or clear local privacy-safe telemetry summary

Flags:
  -h, --help              Show help information
  -v, --version           Show version information

Examples:
  kai open /path/to/project
  kai claude .
  kai cursor /path/to/project
  kai list -a
  kai list -i
  kai setup all
  kai setup claude
  kai remove -i .
  kai remove -a claude
  kai remove -s
  kai graph init .
  kai graph status .
  kai status .
`);
}

/**
 * Resolve an agent name or alias against registered agents and dynamically detected PATH binaries.
 */
const BUILTIN_COMMANDS = new Set([
  "open",
  "close",
  "code",
  "clear",
  "query",
  "cost",
  "stop",
  "status",
  "remove",
  "unregister",
  "graph",
  "config",
  "session",
  "mcp",
  "run",
  "bench",
  "agent",
  "agents",
  "list",
  "setup",
  "metrics",
  "lsp",
  "doctor",
  "help",
  "version",
]);

export function resolveAgent(nameOrAlias: string): {
  agentDef?: AgentDefinition;
  dynamicBin?: string | null;
  agentId: string;
} | null {
  if (!nameOrAlias || nameOrAlias.startsWith("-")) return null;
  const normalized = nameOrAlias.toLowerCase();
  if (BUILTIN_COMMANDS.has(normalized)) return null;
  const agentDef = AGENT_REGISTRY.find(
    (a) =>
      a.id.toLowerCase() === normalized || a.aliases.some((al) => al.toLowerCase() === normalized)
  );
  if (agentDef) {
    return { agentDef, agentId: agentDef.id };
  }
  const dynamicBin = findDynamicAgentBinary(nameOrAlias);
  if (dynamicBin) {
    return { dynamicBin, agentId: nameOrAlias };
  }
  return null;
}

/**
 * Unified execution workflow for AI agents:
 * 1. Resolves and registers the target project path.
 * 2. Enters Code Mode and installs git hooks (if applicable).
 * 3. Auto-configures MCP wiring for the agent (if not already wired).
 * 4. Ensures the project graph/index is built.
 * 5. Launches the agent with the forwarded arguments.
 * 6. Automatically syncs the project graph on completion/failure/exit.
 */
export async function executeAgentWorkflow(
  agentNameOrCommand: string,
  targetPath: string,
  opts: {
    commandArgs?: string[];
    timeoutMs?: number;
  } = {}
): Promise<number> {
  const meta = registerProject(targetPath);

  // 1. Enter Code Mode & ensure commit-msg hook
  saveActiveProjectState(meta.canonicalPath, meta.name, meta.id, "code");
  try {
    installCommitMsgHook(meta.canonicalPath);
  } catch {
    // ignore hook install errors
  }

  // 2. Auto-wire MCP for the agent
  const resolved = resolveAgent(agentNameOrCommand);
  if (resolved) {
    let kaiBin = process.argv[1] ? path.resolve(process.argv[1]) : "kai";
    try {
      const real = fs.realpathSync(kaiBin);
      if (real.toLowerCase().endsWith(".js")) kaiBin = real;
    } catch {
      // ignore
    }
    const setupResult = applyAgentSetup(resolved.agentId, kaiBin, {
      projectDir: meta.canonicalPath,
      scope: "auto",
      force: false,
      dryRun: false,
    });
    if (setupResult.wrote) {
      console.log(
        `[kai] MCP configuration auto-wired for ${setupResult.name || resolved.agentId}.`
      );
    }
  }

  // 3. Ensure baseline index & project graph
  let baseline = loadProjectIndex(meta.id);
  if (!baseline) {
    console.log(`[kai] Indexing project for Code Mode run...`);
    baseline = await indexProject(meta);
  }

  // 4. Resolve executable binary
  let binaryToRun: string | null = null;
  if (resolved?.agentDef) {
    for (const b of resolved.agentDef.binaries) {
      const found = findBinaryOnPath(b);
      if (found) {
        binaryToRun = found;
        break;
      }
    }
    if (!binaryToRun) {
      binaryToRun = findBinaryOnPath(resolved.agentDef.id);
    }
  } else if (resolved?.dynamicBin) {
    binaryToRun = resolved.dynamicBin;
  } else {
    binaryToRun = findBinaryOnPath(agentNameOrCommand) || agentNameOrCommand;
  }

  if (!binaryToRun) {
    console.error(
      `[kai] Error: Binary for "${resolved?.agentDef?.name || agentNameOrCommand}" not found on PATH.`
    );
    if (resolved?.agentDef?.installGuidance) {
      console.error(`[kai] ${resolved.agentDef.installGuidance}`);
    }
    return 1;
  }

  let finalArgs: string[] = opts.commandArgs ? [...opts.commandArgs] : [];
  if (resolved?.agentDef?.kind === "ide" && finalArgs.length === 0) {
    finalArgs = [meta.canonicalPath];
  }

  const displayCmd = resolved?.agentDef?.id || path.basename(binaryToRun);
  console.log(`[kai] Running Code Mode task in "${meta.name}": ${displayCmd}`);

  const controller = new AbortController();
  const onInterrupt = (): void => {
    controller.abort();
  };
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onInterrupt);
  let agentExitCode: number | null = 0;
  let agentTimedOut = false;
  let agentSignal: string | null = null;
  try {
    const outcome = await runCodeTaskWithAutoSync(
      meta,
      async () => {
        const useShell = needsShellForCommand(binaryToRun!);
        const result = await runExternalAgentCommand(binaryToRun!, finalArgs, {
          cwd: meta.canonicalPath,
          timeoutMs: opts.timeoutMs,
          signal: controller.signal,
          shell: useShell,
        });
        agentExitCode = result.exitCode;
        agentTimedOut = result.timedOut;
        agentSignal = result.signal;
        const changedOnDisk = detectChangedFilesFromDisk(loadProjectIndex(meta.id));
        const uncertainOutcome =
          changedOnDisk.length === 0 ||
          result.timedOut ||
          result.signal !== null ||
          controller.signal.aborted;
        const exitNote = result.timedOut
          ? `command timed out${opts.timeoutMs ? ` after ${opts.timeoutMs}ms` : ""}`
          : result.signal
            ? `command terminated by signal ${result.signal}`
            : `command exited with code ${result.exitCode}`;
        console.log(`[kai] Agent finished (${exitNote}, ${result.durationMs}ms).`);
        return {
          changedFiles: changedOnDisk,
          uncertain: uncertainOutcome,
          codeValidation: {
            ran: false,
            passed: false,
            detail: `${exitNote}; agent outcome preserved separately from graph sync.`,
          },
        };
      },
      { signal: controller.signal }
    );
    const sync = outcome.syncReport;
    console.log(
      `[kai] Graph auto-sync: ${sync.graphResult} (${sync.graphScope}; freshness: ${sync.freshnessAfter}). ${sync.message}`
    );
    if (sync.warnings) for (const w of sync.warnings) console.log(`[kai] Note: ${w}`);
    if (outcome.taskOutcome !== "completed") {
      console.log(
        `[kai] Task ${outcome.taskOutcome}${outcome.taskError ? `: ${outcome.taskError}` : ""}.`
      );
    }
    if (agentTimedOut) {
      console.log(
        `[kai] Note: the timed-out command was signalled (SIGTERM, then SIGKILL after 2 s; process tree on Windows). A detached grandchild may still be writing; freshness above is point-in-time — rerun 'kai status' or 'kai graph rebuild' if it keeps changing.`
      );
    } else if (agentSignal) {
      console.log(
        `[kai] Note: the command was terminated by ${agentSignal}; a surviving detached child may still be writing — treat freshness as point-in-time.`
      );
    }
    if (controller.signal.aborted || outcome.taskOutcome === "cancelled") return 130;
    if (outcome.taskOutcome === "failed") return 1;
    if (agentTimedOut) return 124;
    if (agentSignal) return 130;
    if (typeof agentExitCode === "number") return agentExitCode;
    return 1;
  } finally {
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onInterrupt);
  }
}

export async function runCli(argv: string[]): Promise<number> {
  const args = argv.slice(2);
  const command = args[0];

  if (!command || command === "--help" || command === "-h" || command === "help") {
    printHelp();
    return 0;
  }

  if (command === "--version" || command === "-v" || command === "version") {
    console.log(`kai v${KAI_VERSION}`);
    return 0;
  }

  try {
    // External command: open [path]
    if (command === "open") {
      const targetPath = args[1] || process.cwd();
      const canonicalPath = resolveCanonicalPath(targetPath);
      if (!fs.existsSync(canonicalPath)) {
        console.error(`[kai] Error: Directory "${targetPath}" does not exist.`);
        return 1;
      }
      const stat = fs.statSync(canonicalPath);
      if (!stat.isDirectory()) {
        console.error(`[kai] Error: Path "${targetPath}" is not a directory.`);
        return 1;
      }

      const meta = registerProject(canonicalPath);
      saveActiveProjectState(meta.canonicalPath, meta.name, meta.id, "code");

      const appBinary = findKaiAppBinary();
      if (!appBinary) {
        console.error(`[kai] Error: Kai Terminal desktop application binary not found.`);
        console.error(`Please install the Kai Terminal desktop app or verify it is on PATH.`);
        return 1;
      }

      const launched = launchKaiApp(appBinary, meta.canonicalPath);
      if (launched) {
        console.log(`[kai] Opened Kai Terminal for "${meta.name}" (${meta.canonicalPath})`);
        return 0;
      } else {
        console.error(`[kai] Error: Failed to launch Kai Terminal app at ${appBinary}`);
        return 1;
      }
    }

    // External command: close
    if (command === "close") {
      try {
        if (process.platform === "win32") {
          try {
            execSync("taskkill /F /IM kai.exe", { stdio: "ignore" });
          } catch {}
          try {
            execSync("taskkill /F /IM cross-platform-terminal-backend.exe", { stdio: "ignore" });
          } catch {}
        } else {
          try {
            execSync("pkill -x kai", { stdio: "ignore" });
          } catch {}
          try {
            execSync("pkill -x cross-platform-terminal-backend", { stdio: "ignore" });
          } catch {}
          try {
            execSync("pkill -x kai-terminal", { stdio: "ignore" });
          } catch {}
        }
        console.log(`[kai] Kai Terminal instances closed.`);
        return 0;
      } catch (err: unknown) {
        console.error(
          `[kai] Error closing Kai Terminal: ${err instanceof Error ? err.message : String(err)}`
        );
        return 1;
      }
    }

    // Boundary enforcement: internal commands must run inside Kai Terminal
    if (!isInsideKaiTerminal() && !EXTERNAL_COMMANDS.has(command)) {
      console.error(`[kai] Error: 'kai ${command}' can only be executed inside Kai Terminal.`);
      console.error(`To open or focus Kai Terminal for your project, run:\n  kai open [path]`);
      return 1;
    }

    // Internal command: AI agent execution (kai <agent> [path])
    const resolvedAgent = resolveAgent(command);
    if (resolvedAgent) {
      const targetPath = args[1] || process.cwd();
      return await executeAgentWorkflow(command, targetPath);
    }

    // Removed commands
    if (command === "code") {
      console.error(
        `[kai] 'kai code' has been removed. Use 'kai graph init [path]' to index or run 'kai <agent>' to launch an agent.`
      );
      return 1;
    }

    if (command === "clear") {
      console.error(`[kai] 'kai clear' has been removed. Use 'kai stop' to exit Code Mode.`);
      return 1;
    }

    if (command === "query" || command === "cost") {
      console.error(`[kai] 'kai ${command}' has been removed.`);
      return 1;
    }

    // kai stop — clear Code Mode, back to plain terminal mode.
    if (command === "stop") {
      clearActiveProjectState();
      console.log(`[kai] Code Mode cleared — back to plain terminal mode.`);
      return 0;
    }

    // kai status [path]
    if (command === "status") {
      const targetPath = args[1] || process.cwd();
      const meta = getProjectMeta(targetPath);

      if (!meta) {
        console.log(`[kai] No project registered for: ${targetPath}`);
        console.log(`Run 'kai graph init ${targetPath}' to register and index.`);
        return 1;
      }

      console.log(`[kai] Project Status:`);
      console.log(`  Name:             ${meta.name}`);
      console.log(`  ID:               ${meta.id}`);
      console.log(`  Root:             ${meta.rootPath}`);
      console.log(`  Canonical:        ${meta.canonicalPath}`);
      console.log(`  Registered:       ${meta.registeredAt}`);
      console.log(`  Last Indexed:     ${meta.lastIndexedAt || "never"}`);
      console.log(`  Status:           ${meta.status}`);
      console.log(`  Files Indexed:    ${meta.fileCount}`);
      console.log(`  Symbols Indexed:  ${meta.symbolCount}`);

      const index = loadProjectIndex(meta.id);
      if (index) {
        const staleness = detectStaleIndexEntries(index);
        // A torn persistence snapshot (crash between renames) must never
        // read as fresh: validate the pairing before reporting.
        let consistencyNote = "";
        try {
          const consistency = checkPersistenceConsistency(meta.id);
          if (!consistency.consistent) {
            consistencyNote = ` (persisted snapshot inconsistent: ${consistency.reason}; rebuild recommended)`;
          }
        } catch {
          // Validation unavailable; report the on-disk signal as-is.
        }
        if (staleness.isStale || consistencyNote) {
          const base = staleness.isStale
            ? `stale (${staleness.staleFiles.length} modified, ${staleness.deletedFiles.length} deleted on disk)`
            : `stale (on-disk files match, but persistence pairing failed)`;
          console.log(`  Freshness:        ${base}${consistencyNote}`);
        } else {
          console.log(`  Freshness:        fresh`);
        }
      }

      try {
        const hook = hookStatus(meta.canonicalPath);
        console.log(`  Commit Hook:      ${hook.state}`);
      } catch {
        // Not a git repo — the hook line does not apply.
      }

      const lspServers = detectInstalledLspServers();
      const hasLsp = lspServers.some((s) => s.isAvailable);
      console.log(
        `  Semantic Mode:    ${
          hasLsp
            ? "active (LSP connected)"
            : "degraded (syntax-only indexing; no local language server in PATH)"
        }`
      );

      if (meta.lastError) {
        console.log(`  Last Error:       ${meta.lastError}`);
      }
      return 0;
    }

    // kai remove -i <path|id> | -a <name> | -s [target] [--dry-run]
    if (command === "remove" || command === "unregister") {
      const isDryRun = args.includes("--dry-run");

      let indexTarget: string | null = null;
      let agentTarget: string | null = null;
      let isSessionRemove = false;
      let sessionTarget: string | null = null;

      for (let i = 1; i < args.length; i++) {
        const arg = args[i];
        if (arg === "--dry-run") continue;
        if (arg === "-i" || arg === "--index") {
          indexTarget = args[i + 1] && !args[i + 1].startsWith("-") ? args[i + 1] : "";
          i++;
        } else if (arg === "-a" || arg === "--agent") {
          agentTarget = args[i + 1] && !args[i + 1].startsWith("-") ? args[i + 1] : "";
          i++;
        } else if (arg === "-s" || arg === "--session") {
          isSessionRemove = true;
          if (args[i + 1] && !args[i + 1].startsWith("-")) {
            sessionTarget = args[i + 1];
            i++;
          }
        }
      }

      // 1. Remove project index
      if (indexTarget !== null) {
        if (!indexTarget) {
          console.error(
            `[kai] Error: Please specify a project path or id to remove with -i/--index.`
          );
          console.error(`Example: kai remove -i . --dry-run`);
          return 1;
        }
        let meta = getProjectMeta(indexTarget);

        if (!meta && /^[0-9a-f]{16}$/.test(indexTarget)) {
          const storageDir = getProjectStorageDir(indexTarget);
          if (fs.existsSync(storageDir)) {
            meta = {
              id: indexTarget,
              name: `orphaned-${indexTarget}`,
              rootPath: "unknown",
              canonicalPath: "unknown",
              registeredAt: "unknown",
              lastIndexedAt: null,
              schemaVersion: 1,
              status: "unindexed",
              fileCount: 0,
              symbolCount: 0,
            };
          }
        }

        if (!meta) {
          console.error(`[kai] No project registered for: ${indexTarget}`);
          return 1;
        }

        const storageDir = getProjectStorageDir(meta.id);
        console.log(`[kai] Remove Project Index Scope:`);
        console.log(`  Project:           "${meta.name}" (id: ${meta.id})`);
        console.log(`  Index data:        ${storageDir}`);
        console.log(`  NOTE: Only Kai-owned data under ~/.kai/projects/ is removed.`);
        console.log(`  NOTE: The repository at ${meta.canonicalPath} is NOT touched.`);

        if (isDryRun) {
          console.log(`[kai] Dry-run complete. No data was deleted.`);
          return 0;
        }

        const result = deleteProjectData(meta.id);
        if (!result.success) {
          console.error(`[kai] Error: Failed to delete project data: ${result.error}`);
          return 2;
        }
        console.log(`[kai] Project "${meta.name}" index deleted.`);
        return 0;
      }

      // 2. Remove agent MCP wiring
      if (agentTarget !== null) {
        if (!agentTarget) {
          console.error(`[kai] Error: Please specify an agent name to remove with -a/--agent.`);
          console.error(`Example: kai remove -a claude`);
          return 1;
        }
        const result = removeAgentSetup(agentTarget, {
          projectDir: process.cwd(),
          scope: "auto",
          dryRun: isDryRun,
        });
        if (isDryRun) {
          console.log(`[kai] Dry-run: ${result.message}`);
          return 0;
        }
        console.log(`[kai] ${result.message}`);
        return result.removed ? 0 : 1;
      }

      // 3. Remove session and cache files
      if (isSessionRemove) {
        const sessionsDir = getSessionsDir();
        const cacheDir = getCacheDir();

        const sessionFiles = fs.existsSync(sessionsDir) ? fs.readdirSync(sessionsDir) : [];
        const cacheFiles = fs.existsSync(cacheDir) ? fs.readdirSync(cacheDir) : [];

        let targetSessionFiles = sessionFiles;
        let targetCacheFiles = cacheFiles;
        if (sessionTarget && sessionTarget !== ".") {
          targetSessionFiles = sessionFiles.filter((f) => f.includes(sessionTarget!));
          targetCacheFiles = cacheFiles.filter((f) => f.includes(sessionTarget!));
        }

        console.log(`[kai] Remove Session Scope:`);
        console.log(`  Session files to remove: ${targetSessionFiles.length} (in ${sessionsDir})`);
        console.log(`  Cache files to remove:   ${targetCacheFiles.length} (in ${cacheDir})`);
        console.log(`  NOTE: Project index databases in ~/.kai/projects/ are NOT touched.`);

        if (isDryRun) {
          console.log(`[kai] Dry-run complete. No files were deleted.`);
          return 0;
        }

        for (const f of targetSessionFiles) {
          try {
            const st = fs.lstatSync(path.join(sessionsDir, f));
            if (st.isFile()) fs.unlinkSync(path.join(sessionsDir, f));
          } catch {}
        }
        for (const f of targetCacheFiles) {
          try {
            const st = fs.lstatSync(path.join(cacheDir, f));
            if (st.isFile()) fs.unlinkSync(path.join(cacheDir, f));
          } catch {}
        }
        console.log(`[kai] Session and cache directories cleanly cleared.`);
        return 0;
      }

      // No flags provided
      console.error(`[kai] Error: Please specify what to remove using a flag:`);
      console.error(`  -i, --index <path|id>   Remove project index (repo is untouched)`);
      console.error(`  -a, --agent <name>      Remove Kai MCP configuration from an agent`);
      console.error(`  -s, --session [target]  Remove session and cache files`);
      console.error(`\nExamples:`);
      console.error(`  kai remove -i .`);
      console.error(`  kai remove -i /path/to/project`);
      console.error(`  kai remove -a claude`);
      console.error(`  kai remove -s`);
      return 1;
    }

    // kai graph [init|update|status] [path]
    if (command === "graph") {
      const sub = args[1];
      if (sub === "init") {
        const targetPath = args[2] || process.cwd();
        const meta = registerProject(targetPath);
        saveActiveProjectState(meta.canonicalPath, meta.name, meta.id, "code");
        try {
          installCommitMsgHook(meta.canonicalPath);
        } catch {
          // ignore hook install errors
        }
        console.log(`[kai] Initializing graph for "${meta.name}"...`);
        const index = await indexProject(meta);
        console.log(`[kai] Index ready!`);
        console.log(`- Files indexed: ${Object.keys(index.files).length}`);
        console.log(`- Symbols indexed: ${Object.keys(index.symbolIndex).length}`);
        console.log(`- Project rules loaded: ${index.rules.length}`);
        if (index.changes) {
          const { added, modified, renamed, deleted } = index.changes;
          if (added.length || modified.length || renamed.length || deleted.length) {
            console.log(
              `- Incremental changes: +${added.length} added, ~${modified.length} modified, ->${renamed.length} renamed, -${deleted.length} deleted`
            );
          }
        }
        saveActiveProjectState(meta.canonicalPath, meta.name, meta.id, "code");
        return 0;
      }
      if (sub === "update" || sub === "rebuild") {
        const targetPath = args[2] || process.cwd();
        const meta = registerProject(targetPath);
        console.log(`[kai] Updating index for "${meta.name}"...`);
        const index = await indexProject(meta, { forceRebuild: true });
        console.log(
          `[kai] Update complete! Indexed ${Object.keys(index.files).length} files and ${Object.keys(index.symbolIndex).length} symbols.`
        );
        if (index.changes) {
          const { added, modified, renamed, deleted } = index.changes;
          if (added.length || modified.length || renamed.length || deleted.length) {
            console.log(
              `  Changes: +${added.length} added, ~${modified.length} modified, ->${renamed.length} renamed, -${deleted.length} deleted`
            );
          }
        }
        return 0;
      }
      if (!sub || sub === "status" || sub === "." || sub.startsWith("/") || sub.startsWith("~")) {
        const targetPath = (sub && sub !== "status" ? sub : args[2]) || process.cwd();
        const meta = getProjectMeta(targetPath);
        if (!meta) {
          console.log(`[kai] No project registered for: ${targetPath}`);
          console.log(`Run 'kai graph init ${targetPath}' to index.`);
          return 1;
        }
        console.log(`[kai] Graph Status for "${meta.name}":`);
        console.log(`  Files Indexed:   ${meta.fileCount}`);
        console.log(`  Symbols Indexed: ${meta.symbolCount}`);
        console.log(`  Last Indexed:    ${meta.lastIndexedAt || "never"}`);
        console.log(`Tip: Run 'kai graph update [path]' to force re-indexing.`);
        return 0;
      }

      console.error(`[kai] Error: Unknown graph subcommand "${sub || ""}".`);
      console.error(`Usage: kai graph <init|update|status> [path]`);
      return 1;
    }

    // 6. kai config [get|set|list]
    if (command === "config") {
      const sub = args[1] || "list";
      const configPath = path.join(getKaiHomeDir(), "config.json");

      let currentConfig: Record<string, unknown> = {
        defaultTokenBudget: 4000,
        maxFileSizeBytes: 524288,
        indexingDepth: 20,
        telemetryLocal: true,
      };

      if (fs.existsSync(configPath)) {
        try {
          currentConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));
        } catch {
          // use defaults
        }
      }

      const ALLOWED_KEYS = new Set([
        "defaultTokenBudget",
        "maxFileSizeBytes",
        "indexingDepth",
        "telemetryLocal",
      ]);

      if (sub === "list") {
        console.log(`[kai] Current Configuration:`);
        console.log(JSON.stringify(currentConfig, null, 2));
        return 0;
      }

      if (sub === "get") {
        const key = args[2];
        if (!key) {
          console.error(`[kai] Error: Please specify a configuration key.`);
          return 1;
        }
        if (!ALLOWED_KEYS.has(key)) {
          console.error(
            `[kai] Error: Unknown configuration key "${key}". Allowed: ${[...ALLOWED_KEYS].join(", ")}`
          );
          return 1;
        }
        console.log(`${key} = ${currentConfig[key]}`);
        return 0;
      }

      if (sub === "set") {
        const key = args[2];
        const val = args[3];
        if (!key || val === undefined) {
          console.error(`[kai] Error: Usage: kai config set <key> <value>`);
          return 1;
        }
        if (!ALLOWED_KEYS.has(key)) {
          console.error(
            `[kai] Error: Unknown configuration key "${key}". Allowed: ${[...ALLOWED_KEYS].join(", ")}`
          );
          return 1;
        }
        let parsed: unknown = val;
        if (key === "telemetryLocal") {
          if (val === "true") parsed = true;
          else if (val === "false") parsed = false;
          else {
            console.error(`[kai] Error: ${key} must be "true" or "false".`);
            return 1;
          }
        } else {
          const num = Number(val);
          if (!Number.isFinite(num) || !Number.isInteger(num) || num <= 0 || num > 1000000) {
            console.error(`[kai] Error: ${key} must be a positive integer (1-1000000).`);
            return 1;
          }
          parsed = num;
        }
        currentConfig[key] = parsed;
        // First-run safety: KAI_HOME may not exist yet (no project has been
        // registered). Previously this threw ENOENT on a fresh machine.
        ensureKaiDirectories();
        fs.writeFileSync(configPath, JSON.stringify(currentConfig, null, 2), { mode: 0o600 });
        console.log(`[kai] Configuration updated: ${key} = ${val}`);
        return 0;
      }

      console.error(`[kai] Unknown config subcommand: ${sub}`);
      return 1;
    }

    // 7. kai session [list]
    if (command === "session" && (!args[1] || args[1] === "list")) {
      const sessionsDir = getSessionsDir();
      if (!fs.existsSync(sessionsDir)) {
        console.log(`[kai] No active session files found.`);
        return 0;
      }

      const files = fs.readdirSync(sessionsDir);
      console.log(`[kai] Managed Sessions (${files.length}):`);
      for (const f of files) {
        console.log(`  - ${f}`);
      }
      return 0;
    }

    // 8. kai session clean [--dry-run]
    if (command === "session" && args[1] === "clean") {
      const isDryRun = args.includes("--dry-run");
      const sessionsDir = getSessionsDir();
      const cacheDir = getCacheDir();

      const sessionFiles = fs.existsSync(sessionsDir) ? fs.readdirSync(sessionsDir) : [];
      const cacheFiles = fs.existsSync(cacheDir) ? fs.readdirSync(cacheDir) : [];

      console.log(`[kai] Session Clean Operation Scope:`);
      console.log(`  Session files to remove: ${sessionFiles.length} (in ${sessionsDir})`);
      console.log(`  Cache files to remove:   ${cacheFiles.length} (in ${cacheDir})`);
      console.log(`  NOTE: Project index databases in ~/.kai/projects/ are NOT touched.`);

      if (isDryRun) {
        console.log(`[kai] Dry-run complete. No files were deleted.`);
        return 0;
      }

      for (const f of sessionFiles) {
        try {
          // Only remove regular files; never follow symlinks or recurse
          // into subdirectories (a subdir here would previously throw and
          // leave a partial clean).
          const st = fs.lstatSync(path.join(sessionsDir, f));
          if (!st.isFile()) continue;
          fs.unlinkSync(path.join(sessionsDir, f));
        } catch {
          // ignore
        }
      }

      for (const f of cacheFiles) {
        try {
          const st = fs.lstatSync(path.join(cacheDir, f));
          if (!st.isFile()) continue;
          fs.unlinkSync(path.join(cacheDir, f));
        } catch {
          // ignore
        }
      }

      console.log(`[kai] Session and cache directories cleanly cleared.`);
      return 0;
    }

    // 9. kai mcp [path]
    if (command === "mcp") {
      const targetPath = args[1] || process.cwd();
      await startMcpServer(targetPath);
      return 0;
    }

    // 9b. kai run [path] [--timeout-ms N] -- <command> [args...]
    // Code Mode lifecycle integration: Kai invokes the external coding
    // agent as a child process, so process exit (success, failure,
    // timeout, or cancel) is a reliable completion signal. The project
    // graph is synchronized automatically afterwards — the user never
    // runs kai_sync_graph manually. Partial changes after failure or
    // cancellation are synced when safe; sync failure never rewrites the
    // agent's exit outcome.
    if (command === "run") {
      const sepIndex = args.indexOf("--");
      if (sepIndex === -1 || sepIndex === args.length - 1) {
        console.error(
          `[kai] Error: Usage: kai run [path] [--timeout-ms <ms>] -- <command> [args...]`
        );
        console.error(`Example: kai run -- claude -p "fix the login bug"`);
        return 1;
      }
      const head = args.slice(1, sepIndex);
      const cmdArgs = args.slice(sepIndex + 1);
      let targetPath = process.cwd();
      let timeoutMs: number | undefined;
      for (let i = 0; i < head.length; i++) {
        if (head[i] === "--timeout-ms" && i + 1 < head.length) {
          const parsed = Number(head[i + 1]);
          if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 86400000) {
            console.error(`[kai] Error: --timeout-ms must be a positive number of milliseconds.`);
            return 1;
          }
          timeoutMs = Math.floor(parsed);
          i++;
        } else if (!head[i].startsWith("-") && targetPath === process.cwd()) {
          targetPath = head[i];
        } else {
          console.error(`[kai] Error: Unknown option "${head[i]}" for kai run.`);
          return 1;
        }
      }
      return await executeAgentWorkflow(cmdArgs[0], targetPath, {
        commandArgs: cmdArgs.slice(1),
        timeoutMs,
      });
    }

    // 10. kai bench [path]
    if (command === "bench") {
      const targetPath = args[1] || process.cwd();
      const meta = registerProject(targetPath);
      let index = loadProjectIndex(meta.id);
      if (!index) {
        console.log(`[kai] Indexing project for benchmark...`);
        index = await indexProject(meta);
      }

      console.log(`[kai] Running evaluation benchmarks across 4 configurations...`);
      const benchmarks = await runBenchmarks(index);

      console.log(
        `\n================================================================================`
      );
      console.log(
        `Benchmark Evaluation Results (Sample size: ${benchmarks.length} task configurations)`
      );
      console.log(
        `================================================================================`
      );
      console.table(
        benchmarks.map((b) => ({
          Task: b.taskDescription.slice(0, 30) + "...",
          Config: b.config,
          "Est. Tokens": b.contextTokenEstimate,
          "Latency (ms)": b.retrievalLatencyMs,
          "Files In Context": b.retrievedFilesCount,
          Omissions: b.omissionsCount,
          "Retrieval Recall": `${Math.round(b.taskSuccessRate * 100)}%`,
        }))
      );
      console.log(
        `\nNote: Est. Tokens are cl100k heuristics (~3.8 chars/tok). Retrieval Recall measures target symbol presence in context, not autonomous LLM task completion.`
      );
      return 0;
    }

    // 11. kai list [options] (dynamic system detection + resources)
    if (
      command === "list" ||
      ((command === "agent" || command === "agents") &&
        (!args[1] || args[1] === "list" || args[1] === "status"))
    ) {
      const showIndex = args.includes("-i") || args.includes("--index");
      const showSession = args.includes("-s") || args.includes("--session");
      const showConfig = args.includes("-c") || args.includes("--config");
      const showAgent =
        args.includes("-a") ||
        args.includes("--agent") ||
        (!showIndex && !showSession && !showConfig);

      if (showAgent) {
        const detected = detectInstalledAgentsSync({ projectDir: process.cwd() });
        console.log(`[kai] AI Agent Detection (live system probe):`);
        for (const d of detected) {
          const icon = d.binaryFound ? "✓" : "✗";
          const state = d.binaryFound
            ? `Installed (${d.binaryPath})${d.configured ? ", configured" : ""}`
            : d.configured
              ? "Config found (binary not on PATH)"
              : "Not found";
          const wired = d.kaiWired ? "kai wired ✓" : "kai not wired";
          console.log(`  ${icon} ${d.id.padEnd(10)} ${d.name.padEnd(16)} ${state} · ${wired}`);
          if (!d.binaryFound) {
            console.log(`    └─ ${d.installGuidance} | config: ${d.configFile}`);
          }
        }
        console.log(
          `\nTip: Run 'kai <agent> [path]' to launch an agent with auto-wired MCP, Code Mode, and graph sync (e.g. 'kai claude .').`
        );
      }

      if (showIndex) {
        const projects = listRegisteredProjects();
        console.log(`\n[kai] Indexed Projects (${projects.length}):`);
        if (projects.length === 0) {
          console.log(`  No indexed projects found.`);
          console.log(
            `  Tip: Run 'kai graph init [path]' or 'kai <agent> [path]' to index a project.`
          );
        } else {
          for (const proj of projects) {
            const idx = loadProjectIndex(proj.id);
            let freshness = "unindexed";
            if (idx) {
              const staleness = detectStaleIndexEntries(idx);
              freshness = staleness.isStale ? "stale" : "fresh";
            }
            console.log(`  • ${proj.name} (id: ${proj.id})`);
            console.log(`    Path:     ${proj.canonicalPath}`);
            console.log(
              `    Status:   ${proj.status} (${freshness}) | Files: ${proj.fileCount} | Symbols: ${proj.symbolCount}`
            );
            console.log(`    Indexed:  ${proj.lastIndexedAt || "never"}`);
          }
        }
      }

      if (showSession) {
        const sessionsDir = getSessionsDir();
        const cacheDir = getCacheDir();
        const sessionFiles = fs.existsSync(sessionsDir) ? fs.readdirSync(sessionsDir) : [];
        const cacheFiles = fs.existsSync(cacheDir) ? fs.readdirSync(cacheDir) : [];
        console.log(
          `\n[kai] Managed Sessions & Cache (${sessionFiles.length + cacheFiles.length} files):`
        );
        console.log(`  Sessions (${sessionFiles.length} in ${sessionsDir}):`);
        if (sessionFiles.length === 0) {
          console.log(`    (none)`);
        } else {
          for (const f of sessionFiles) console.log(`    - ${f}`);
        }
        console.log(`  Cache (${cacheFiles.length} in ${cacheDir}):`);
        if (cacheFiles.length === 0) {
          console.log(`    (none)`);
        } else {
          for (const f of cacheFiles) console.log(`    - ${f}`);
        }
      }

      if (showConfig) {
        const configPath = path.join(getKaiHomeDir(), "config.json");
        let currentConfig: Record<string, unknown> = {
          defaultTokenBudget: 4000,
          maxFileSizeBytes: 524288,
          indexingDepth: 20,
          telemetryLocal: true,
        };
        if (fs.existsSync(configPath)) {
          try {
            currentConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));
          } catch {}
        }
        console.log(`\n[kai] Current Configuration:`);
        console.log(JSON.stringify(currentConfig, null, 2));
      }

      return 0;
    }

    // 11b. kai setup <agent|all>
    // Automatically installs kai MCP wiring into the agent's own config
    // file (with backup). Use --print for the snippet only, --dry-run to
    // preview, --force to refresh an existing kai entry.
    if (
      ((command === "agent" || command === "agents") &&
        (args[1] === "setup" || args[1] === "register")) ||
      command === "setup"
    ) {
      let rest = args.slice(1);
      if (command === "agent" || command === "agents") {
        rest = args.slice(2);
      } else if (rest[0] === "agent" || rest[0] === "agents") {
        rest = rest.slice(1);
      }
      let targetFromFlag: string | undefined;
      const aIdx = rest.findIndex((a) => a === "-a" || a === "--agent");
      if (aIdx !== -1 && rest[aIdx + 1] && !rest[aIdx + 1].startsWith("-")) {
        targetFromFlag = rest[aIdx + 1];
      }
      const positionals = rest.filter((a) => !a.startsWith("-"));
      const rawTarget = (targetFromFlag || positionals[0] || "").toLowerCase();
      const printOnly = args.includes("--print");
      const dryRun = args.includes("--dry-run");
      const force = args.includes("--force");
      const scope = args.includes("--project")
        ? ("project" as const)
        : args.includes("--global")
          ? ("global" as const)
          : ("auto" as const);
      let kaiBin = process.argv[1] ? path.resolve(process.argv[1]) : "kai";
      try {
        const real = fs.realpathSync(kaiBin);
        if (real.toLowerCase().endsWith(".js")) kaiBin = real;
      } catch {
        // Unresolvable (deleted/moved since launch) — keep the resolved argv.
      }

      if (!rawTarget || rawTarget.startsWith("-")) {
        const detected = detectInstalledAgentsSync({ projectDir: process.cwd() });
        console.log(`\nAvailable agent setup targets (live system status):`);
        for (const d of detected) {
          const icon = d.binaryFound ? "✓" : "✗";
          const wired = d.kaiWired ? "wired ✓" : "not wired";
          console.log(`  ${icon} kai setup ${d.id.padEnd(10)} ${d.configFile} (${wired})`);
        }
        console.log(`\nTip: 'kai list -a' shows full install paths and config state.`);
        console.log(`Tip: 'kai setup all' wires every installed agent automatically.`);
        return 0;
      }

      if (rawTarget === "all" || rawTarget === "--all") {
        const results = autoSetupDetectedAgents(kaiBin, {
          projectDir: process.cwd(),
          scope,
          force,
          dryRun,
        });
        let wrote = 0;
        let already = 0;
        let skipped = 0;
        console.log(`[kai] Agent auto-setup${dryRun ? " (dry-run, nothing written)" : ""}:`);
        for (const r of results) {
          const icon = r.wrote ? "✓" : r.alreadyConfigured ? "=" : "✗";
          console.log(`  ${icon} ${r.id.padEnd(10)} ${r.message}`);
          if (r.backupPath) console.log(`      backup: ${r.backupPath}`);
          if (r.wrote) wrote++;
          else if (r.alreadyConfigured) already++;
          else skipped++;
        }
        console.log(
          `[kai] Done: ${wrote} wired, ${already} already configured, ${skipped} skipped.`
        );
        return skipped > 0 && wrote === 0 && already === 0 ? 1 : 0;
      }

      const snippet = buildAgentSetup(rawTarget, kaiBin);
      if (!snippet) {
        const dynamicBin = findDynamicAgentBinary(rawTarget);
        if (dynamicBin) {
          console.log(`[kai] Auto-detected "${rawTarget}" at ${dynamicBin}.`);
          const dynamicResult = buildDynamicAgentSetup(rawTarget, dynamicBin, kaiBin, {
            projectDir: process.cwd(),
            scope,
            force,
            dryRun: dryRun || printOnly,
          });
          if (dryRun || printOnly) {
            console.log(dynamicResult.snippet);
            if (dryRun && !dynamicResult.skipped)
              console.log(`[kai] ${dynamicResult.message} (dry-run, nothing written)`);
          } else {
            console.log(`[kai] ${dynamicResult.message}`);
            if (dynamicResult.backupPath) {
              console.log(`[kai] Previous config backed up to: ${dynamicResult.backupPath}`);
              console.log(
                `[kai] The backup is kept intentionally — delete it after verifying the new config works.`
              );
            }
            if (!dynamicResult.skipped)
              console.log(`[kai] Restart ${rawTarget} so it picks up the kai MCP server.`);
          }
          return dynamicResult.skipped && !printOnly ? 2 : 0;
        }
        console.log(`[kai] Unknown agent "${rawTarget}".`);
        const detected = detectInstalledAgentsSync({ projectDir: process.cwd() });
        console.log(`\nAvailable agent setup targets (live system status):`);
        for (const d of detected) {
          const icon = d.binaryFound ? "✓" : "✗";
          console.log(`  ${icon} kai setup ${d.id.padEnd(10)} ${d.configFile}`);
        }
        console.log(`\nTip: 'kai list -a' shows full install paths and config state.`);
        return 1;
      }

      const result = applyAgentSetup(rawTarget, kaiBin, {
        projectDir: process.cwd(),
        scope,
        force,
        dryRun: dryRun || printOnly,
      });
      if (result.skipped && !printOnly) {
        console.error(`[kai] ${result.message}`);
        if (printOnly) console.log(snippet);
        return 2;
      }
      if (dryRun || printOnly) {
        if (result.skipped) console.log(`[kai] Note: ${result.message}`);
        console.log(snippet);
        if (dryRun && !result.skipped)
          console.log(`[kai] ${result.message} (dry-run, nothing written)`);
        return 0;
      }
      console.log(`[kai] ${result.message}`);
      if (result.backupPath) {
        console.log(`[kai] Previous config backed up to: ${result.backupPath}`);
        console.log(
          `[kai] The backup is kept intentionally — delete it after verifying the new config works.`
        );
      }
      console.log(`[kai] Restart ${result.name} so it picks up the kai MCP server.`);
      return 0;
    }

    // 12. kai metrics [clear]
    if (command === "metrics") {
      if (args[1] === "clear") {
        clearMetricsLog();
        console.log(`[kai] Local metrics log cleared.`);
        return 0;
      }

      const summary = getTelemetrySummary();
      console.log(`[kai] Local Privacy-Safe Telemetry Summary:`);
      console.log(`  Total Operations:      ${summary.totalOperations}`);
      console.log(`  Average Latency:       ${summary.avgLatencyMs} ms`);
      console.log(`  Total Est. Tokens:     ${summary.totalTokensEstimated}`);
      console.log(`  Error Rate:            ${summary.errorRatePct}%`);
      console.log(
        `  Operation Breakdown:   ${JSON.stringify(summary.operationsBreakdown, null, 2)}`
      );
      return 0;
    }

    // 13. kai lsp [status]
    if (command === "lsp") {
      const detected = detectInstalledLspServers();
      console.log(`[kai] Language Server Protocol (LSP) Bridge Status:`);
      for (const server of detected) {
        const statusIcon = server.isAvailable ? "✓" : "✗";
        const statusText = server.isAvailable
          ? `Available (${server.version || "installed"})`
          : "Not Found";
        console.log(
          `  ${statusIcon} ${server.language.padEnd(12)} ${server.command.padEnd(28)} ${statusText}`
        );
        if (!server.isAvailable && server.installHint) {
          console.log(`    └─ Install hint: ${server.installHint}`);
        }
      }
      return 0;
    }

    // 14. kai doctor — environment & install diagnostics, including the
    // Linux app-drawer (.desktop) audit: a drawer entry whose Exec target
    // is missing (or icon unresolvable) silently does nothing on click.
    if (command === "doctor") {
      printDoctorReport();
      return 0;
    }

    console.error(`[kai] Unknown command: "${command}". Run 'kai --help' for usage.`);
    return 1;
  } catch (err: unknown) {
    console.error(`[kai] Error: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
}

/** One app-drawer entry audit (Linux .desktop file). */
export interface DesktopEntryAudit {
  file: string;
  name: string | null;
  execLine: string | null;
  execTarget: string | null;
  execFound: boolean;
  icon: string | null;
  iconFound: boolean;
}

/**
 * Parse the [Desktop Entry] section of a .desktop file into lowercased
 * keys. Ignores other sections, comments, and blank lines.
 */
export function parseDesktopEntry(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  let inSection = false;
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("[") && line.endsWith("]")) {
      inSection = line.slice(1, -1).trim().toLowerCase() === "desktop entry";
      continue;
    }
    if (!inSection) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim().toLowerCase();
    if (!(key in out)) out[key] = line.slice(eq + 1).trim();
  }
  return out;
}

/**
 * Resolve the executable an Exec= line points at: first token, quotes and
 * %-field-codes stripped, then an absolute-path stat or a PATH lookup.
 * Returns null when no usable target can be determined.
 */
export function resolveExecTarget(execLine: string): string | null {
  const m = execLine.trim().match(/^("([^"]+)"|'([^']+)'|(\S+))/);
  const target = (m?.[2] ?? m?.[3] ?? m?.[4] ?? "").trim();
  if (!target || target === "%f" || target === "%F" || target.startsWith("%")) return null;
  // Field codes may trail the binary (`Exec=app %F`): only the head matters.
  const head = target.split(/\s+/)[0] ?? "";
  if (!head) return null;
  if (path.isAbsolute(head)) {
    try {
      if (fs.existsSync(head) && fs.statSync(head).isFile()) return head;
    } catch {
      // treat as missing below
    }
    return null;
  }
  const pathEnv = process.env.PATH || "";
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    try {
      const c = path.join(dir, head);
      if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
    } catch {
      // keep probing
    }
  }
  return null;
}

function iconLookupDirs(): string[] {
  const dirs: string[] = ["/usr/share/pixmaps"];
  const hicolor = "/usr/share/icons/hicolor";
  for (const size of ["256x256", "128x128", "64x64", "48x48", "32x32", "scalable"]) {
    dirs.push(path.join(hicolor, size, "apps"));
  }
  const home = os.homedir();
  if (home) dirs.push(path.join(home, ".local", "share", "icons", "hicolor", "128x128", "apps"));
  return dirs;
}

/** Audit one .desktop file; null when unreadable or not a desktop entry. */
export function auditDesktopFile(file: string): DesktopEntryAudit | null {
  let content: string;
  try {
    content = fs.readFileSync(file, "utf-8");
  } catch {
    return null;
  }
  if (content.length > 64 * 1024) return null;
  const entry = parseDesktopEntry(content);
  if (!entry["type"] && !entry["name"] && !entry["exec"]) return null;
  const execLine = entry["exec"] ?? null;
  const execTarget = execLine ? resolveExecTarget(execLine) : null;
  const icon = entry["icon"] ?? null;
  let iconFound = false;
  if (icon) {
    if (icon.includes("/")) {
      try {
        iconFound = fs.existsSync(icon) && fs.statSync(icon).isFile();
      } catch {
        iconFound = false;
      }
    } else {
      for (const dir of iconLookupDirs()) {
        for (const ext of [".png", ".svg", ".xpm", ""]) {
          try {
            if (fs.existsSync(path.join(dir, icon + ext))) {
              iconFound = true;
              break;
            }
          } catch {
            // keep probing
          }
        }
        if (iconFound) break;
      }
    }
  }
  return {
    file,
    name: entry["name"] ?? null,
    execLine,
    execTarget,
    execFound: execTarget !== null,
    icon,
    iconFound,
  };
}

/**
 * Find installed *.desktop files mentioning kai (case-insensitive Name,
 * Exec, or filename). Linux only — other OSes return [].
 */
export function findKaiDesktopFiles(): string[] {
  if (process.platform !== "linux") return [];
  const dirs = [
    "/usr/share/applications",
    "/usr/local/share/applications",
    path.join(os.homedir(), ".local", "share", "applications"),
  ];
  const found: string[] = [];
  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!name.toLowerCase().endsWith(".desktop")) continue;
      const file = path.join(dir, name);
      if (
        name.toLowerCase().includes("kai") ||
        (() => {
          try {
            const head = fs.readFileSync(file, "utf-8").slice(0, 4096).toLowerCase();
            return head.includes("kai");
          } catch {
            return false;
          }
        })()
      ) {
        found.push(file);
      }
    }
  }
  return found.sort();
}

/** Print the `kai doctor` diagnostics report (stdout only, exit 0). */
export function printDoctorReport(): void {
  console.log(`[kai] Doctor — environment & install diagnostics (kai v${KAI_VERSION})`);
  console.log(`  Platform:          ${process.platform}/${process.arch} (node ${process.version})`);
  console.log(`  KAI_HOME:          ${getKaiHomeDir()}`);
  const appBinary = findKaiAppBinary();
  console.log(
    appBinary
      ? `  Desktop app binary: ${appBinary}`
      : `  Desktop app binary: NOT FOUND on disk or PATH`
  );
  if (!appBinary) {
    console.log(`    └─ Install the desktop .exe/.msi/.deb/.dmg, or run from source.`);
  }

  if (process.platform === "linux") {
    const files = findKaiDesktopFiles();
    console.log(`  Linux app-drawer entries mentioning kai: ${files.length}`);
    if (files.length === 0) {
      console.log(`    └─ No .desktop entry found: reinstall the .deb or check PATH.`);
    }
    for (const file of files) {
      const audit = auditDesktopFile(file);
      if (!audit) {
        console.log(`    - ${file} (unreadable, skipped)`);
        continue;
      }
      const execMark = audit.execFound ? "✓" : "✗";
      const iconMark = audit.iconFound ? "✓" : "✗";
      console.log(`    - ${file}`);
      console.log(`      Name: ${audit.name ?? "(missing)"}`);
      console.log(
        `      Exec: ${audit.execLine ?? "(missing)"} ${execMark}` +
          (audit.execTarget
            ? ` -> ${audit.execTarget}`
            : ` -> target NOT FOUND (drawer click will do nothing)`)
      );
      console.log(`      Icon: ${audit.icon ?? "(missing)"} ${iconMark}`);
      if (!audit.execFound) {
        console.log(
          `      └─ Fix: verify the installed binary path, then reinstall the .deb. ` +
            `Run the binary directly in a terminal to see the real error.`
        );
      }
      if (!audit.iconFound) {
        console.log(`      └─ Fix: reinstall the .deb so /usr/share/icons entries are restored.`);
      }
    }
  } else {
    console.log(`  App-drawer audit: Linux only (skipped on ${process.platform}).`);
  }
}

// Auto-execute when run directly as a script (e.g. node dist/cli/index.js)
if (!process.env.VITEST && typeof process !== "undefined" && process.argv && process.argv[1]) {
  try {
    const scriptPath = path.resolve(process.argv[1]);
    const thisPath = fileURLToPath(import.meta.url);
    const isDirectRun =
      (scriptPath === thisPath ||
        fs.realpathSync(scriptPath) === fs.realpathSync(thisPath) ||
        scriptPath.endsWith(path.join("cli", "index.js")) ||
        scriptPath.endsWith("cli/index.js")) &&
      !scriptPath.endsWith("kai.js");

    if (isDirectRun) {
      runCli(process.argv)
        .then((code) => {
          if (typeof code === "number") process.exit(code);
        })
        .catch((err) => {
          console.error("[kai] Fatal error:", err);
          process.exit(1);
        });
    }
  } catch {
    // If realpathSync fails (e.g. file unlinked), fall back to path suffix check
    if (process.argv[1].endsWith("dist/cli/index.js") || process.argv[1].endsWith("cli/index.js")) {
      runCli(process.argv)
        .then((code) => {
          if (typeof code === "number") process.exit(code);
        })
        .catch((err) => {
          console.error("[kai] Fatal error:", err);
          process.exit(1);
        });
    }
  }
}
