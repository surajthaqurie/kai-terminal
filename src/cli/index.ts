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
} from "../core/registry";
import { indexProject } from "../core/indexer";
import { assembleContext } from "../core/contextAssembler";
import { startMcpServer } from "../core/mcp";
import { runBenchmarks } from "../core/benchmarks";
import { getTelemetrySummary, clearMetricsLog } from "../core/telemetry";
import { detectInstalledLspServers } from "../core/lspBridge";
import {
  AGENT_REGISTRY,
  applyAgentSetup,
  autoSetupDetectedAgents,
  buildAgentSetup,
  detectInstalledAgentsSync,
  listAgentIds,
} from "../core/agents";
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

  // Attempt to sync SQLite localStorage for WebKitGTK / WKWebView / WebView2
  // so the desktop app picks up the new active project without a restart.
  // The DB path is platform-specific: Linux uses XDG data home, macOS uses
  // Application Support, and Windows uses %APPDATA%.
  try {
    const dbPath = getTauriLocalStoragePath();
    if (dbPath && fs.existsSync(dbPath)) {
      const toHex = (str: string) => Buffer.from(str, "utf16le").toString("hex");
      const sql = `INSERT OR REPLACE INTO ItemTable (key, value) VALUES ('kai_active_project', X'${toHex(projectPath)}'); INSERT OR REPLACE INTO ItemTable (key, value) VALUES ('kai_active_mode', X'${toHex(mode)}'); INSERT OR REPLACE INTO ItemTable (key, value) VALUES ('kai_recent_projects', X'${toHex(JSON.stringify([projectPath]))}');`;
      execSync(`sqlite3 "${dbPath}" "${sql}"`, { stdio: "ignore" });
    }
  } catch {
    // ignore if sqlite3 is not available
  }
}

/**
 * Resolve the platform-specific path to the Tauri app's SQLite localStorage
 * database. Returns null when the platform is unsupported or the path cannot
 * be determined.
 *
 * Tauri stores its WebView localStorage in a platform-specific directory:
 *   Linux   : $XDG_DATA_HOME/com.kai.terminal/… or ~/.local/share/…
 *   macOS   : ~/Library/Application Support/com.kai.terminal/…
 *   Windows : %APPDATA%\com.kai.terminal\…
 */
function getTauriLocalStoragePath(): string | null {
  const APP_ID = "com.kai.terminal";
  const DB_REL = `localstorage/tauri_localhost_0.localstorage`;

  if (process.platform === "win32") {
    const appData = process.env.APPDATA;
    if (!appData) return null;
    return path.join(appData, APP_ID, DB_REL);
  }

  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", APP_ID, DB_REL);
  }

  // Linux / other Unix — prefer XDG_DATA_HOME
  const xdgData = process.env.XDG_DATA_HOME;
  if (xdgData) return path.join(xdgData, APP_ID, DB_REL);
  return path.join(os.homedir(), ".local", "share", APP_ID, DB_REL);
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

  try {
    const dbPath = getTauriLocalStoragePath();
    if (dbPath && fs.existsSync(dbPath)) {
      const toHex = (str: string) => Buffer.from(str, "utf16le").toString("hex");
      const sql = `DELETE FROM ItemTable WHERE key = 'kai_active_project'; INSERT OR REPLACE INTO ItemTable (key, value) VALUES ('kai_active_mode', X'${toHex("terminal")}');`;
      execSync(`sqlite3 "${dbPath}" "${sql}"`, { stdio: "ignore" });
    }
  } catch {
    // ignore if sqlite3 is not available
  }
}

import { fileURLToPath } from "url";

/**
 * Locate the installed Kai Terminal desktop executable.
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
    // Linux
    path.join(home, ".local/bin/cross-platform-terminal-backend"),
    path.join(home, ".local/bin/kai-terminal"),
    "/usr/local/bin/cross-platform-terminal-backend",
    "/usr/bin/cross-platform-terminal-backend",
    // macOS
    ...(process.platform === "darwin"
      ? [
          "/Applications/Kai Terminal.app/Contents/MacOS/cross-platform-terminal-backend",
          path.join(
            home,
            "Applications/Kai Terminal.app/Contents/MacOS/cross-platform-terminal-backend"
          ),
        ]
      : []),
    // Windows
    ...(process.platform === "win32"
      ? [
          path.join(
            process.env.LOCALAPPDATA || "",
            "KaiTerminal",
            "cross-platform-terminal-backend.exe"
          ),
          path.join(
            process.env.PROGRAMFILES || "",
            "KaiTerminal",
            "cross-platform-terminal-backend.exe"
          ),
        ]
      : []),
    // Dev builds
    path.resolve(baseDir, "../../src-tauri/target/debug/cross-platform-terminal-backend"),
    path.resolve(baseDir, "../../src-tauri/target/release/cross-platform-terminal-backend"),
  ];

  for (const c of candidates) {
    try {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) {
        return c;
      }
    } catch {
      // ignore
    }
  }

  try {
    const cmd =
      process.platform === "win32"
        ? "where cross-platform-terminal-backend"
        : "which cross-platform-terminal-backend";
    const found = execSync(cmd, { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] })
      .trim()
      .split("\n")[0];
    if (found && fs.existsSync(found)) {
      return found;
    }
  } catch {
    // ignore
  }

  return null;
}

/**
 * Check if the Kai Terminal desktop app process is already running.
 */
export function isKaiAppRunning(): boolean {
  if (process.platform === "win32") {
    try {
      const out = execSync('tasklist /FI "IMAGENAME eq cross-platform-terminal-backend.exe"', {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      return out.includes("cross-platform-terminal-backend");
    } catch {
      return false;
    }
  }

  try {
    const pids = execSync("pidof cross-platform-terminal-backend kai-terminal", {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (pids) return true;
  } catch {
    // pidof may not be installed or no match
  }

  try {
    const out = execSync("ps -A -o pid,comm", {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    for (const line of out.split("\n")) {
      if (line.includes("cross-platform-") || line.includes("kai-terminal")) {
        return true;
      }
    }
  } catch {
    // ignore
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

export function printHelp(): void {
  console.log(`
Kai Terminal — Project Intelligence & CLI (v${KAI_VERSION})
Lightweight terminal-first project intelligence tool for external AI coding agents.

Usage:
  kai <command> [options]

Commands:
  code [path]             Register, index, and open project in Kai Terminal (Code Mode)
  stop [code]             Clear Code Mode and return to plain terminal mode
  status [path]           Show project registration, index health, and file statistics
  unregister <path|id>    Delete a project's Kai-owned index data (repo untouched)
  graph rebuild [path]    Rebuild project symbol index and dependency graph
  query <task> [path]     Assemble task-aware context package and prompt for a task
  cost [path]             Display estimated token footprint and retrieval metrics
  config [get|set|list]   Inspect and safely manage Kai configuration
  session list            List Kai-managed temporary session cache files
  session clean           Clean Kai-owned temporary session data (use --dry-run to inspect)
  lsp [status]            Probe locally installed Language Server Protocol (LSP) servers
  mcp [path]              Start stdio JSON-RPC Model Context Protocol (MCP) server
  bench [path]            Run privacy-safe evaluation benchmark across 4 configurations
  agent setup <agent|all> Install kai MCP wiring for an agent (auto-detects system)
  agent register ...     Alias of 'agent setup' (writes config files automatically)
  agent list              Dynamically detect AI agents installed on this system
  metrics [clear]         Display local privacy-safe telemetry summary

Flags:
  -h, --help              Show help information
  -v, --version           Show version information

Examples:
  kai code .
  kai stop code
  kai .
  kai status
  kai unregister . --dry-run
  kai query "Explain PtyManager lifecycle"
  kai graph rebuild .
  kai session clean --dry-run
  kai mcp .
  kai agent setup claude
  kai agent setup all       # auto-wire every agent installed on this system
`);
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
    // Direct folder invocation: support `kai .` or `kai <path>` directly
    const isDirectPath =
      command === "." ||
      (!command.startsWith("-") &&
        command !== "code" &&
        command !== "stop" &&
        command !== "status" &&
        command !== "unregister" &&
        command !== "graph" &&
        command !== "query" &&
        command !== "cost" &&
        command !== "config" &&
        command !== "session" &&
        command !== "mcp" &&
        command !== "bench" &&
        command !== "agent" &&
        command !== "metrics" &&
        command !== "lsp" &&
        (() => {
          try {
            return fs.existsSync(command) && fs.statSync(command).isDirectory();
          } catch {
            return false;
          }
        })());

    // 1. kai code [path] OR kai [path]
    if (command === "code" || isDirectPath) {
      const targetArg = command === "code" ? args[1] : command;
      const targetPath = targetArg && !targetArg.startsWith("-") ? targetArg : process.cwd();
      const meta = registerProject(targetPath);
      console.log(`[kai] Registered project: "${meta.name}"`);
      console.log(`[kai] Canonical path: ${meta.canonicalPath}`);
      console.log(`[kai] Indexing project files...`);

      const index = await indexProject(meta);
      console.log(`[kai] Index ready!`);
      console.log(`- Files indexed: ${Object.keys(index.files).length}`);
      console.log(`- Symbols indexed: ${Object.keys(index.symbolIndex).length}`);
      console.log(`- Project rules loaded: ${index.rules.length}`);
      console.log(`- Storage directory: ${getProjectStorageDir(meta.id)}`);

      // Persist active project in Code Mode
      saveActiveProjectState(meta.canonicalPath, meta.name, meta.id, "code");

      const noLaunch =
        args.includes("--no-launch") ||
        args.includes("--headless") ||
        args.includes("--no-gui") ||
        Boolean(process.env.VITEST);

      if (!noLaunch) {
        const appBinary = findKaiAppBinary();
        if (appBinary) {
          if (isKaiAppRunning()) {
            console.log(
              `[kai] Kai Terminal is running — active project set to "${meta.name}" in Code Mode.`
            );
          } else {
            console.log(`[kai] Launching Kai Terminal in Code Mode for "${meta.canonicalPath}"...`);
            try {
              const child = spawn(appBinary, [meta.canonicalPath], {
                detached: true,
                stdio: "ignore",
                // Windows: never flash a ghost conhost window when
                // launching the desktop app from the CLI.
                windowsHide: true,
                env: {
                  ...process.env,
                  KAI_ACTIVE_PROJECT: meta.canonicalPath,
                  KAI_MODE: "code",
                },
              });
              child.unref();
            } catch {
              // ignore spawn failure
            }
          }
        }
      }

      return 0;
    }

    // 1b. kai stop [code] — clear Code Mode, back to plain terminal mode.
    // Accepts `kai stop`, `kai stop code`, and `kai clear [code]` (alias).
    if (command === "stop" || command === "clear") {
      clearActiveProjectState();
      console.log(`[kai] Code Mode cleared — back to plain terminal mode.`);
      console.log(`Run 'kai code .' to enter Code Mode again.`);
      return 0;
    }

    // 2. kai status [path]
    if (command === "status") {
      const targetPath = args[1] || process.cwd();
      const meta = getProjectMeta(targetPath);

      if (!meta) {
        console.log(`[kai] No project registered for: ${targetPath}`);
        console.log(`Run 'kai code ${targetPath}' to register and index.`);
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
      if (meta.lastError) {
        console.log(`  Last Error:       ${meta.lastError}`);
      }
      return 0;
    }

    // 3. kai unregister <path|id> [--dry-run]
    if (command === "unregister") {
      const nonFlagArgs = args.slice(1).filter((a) => !a.startsWith("-"));
      const target = nonFlagArgs[0];
      if (!target) {
        console.error(`[kai] Error: Please specify a project path or id.`);
        console.error(`Example: kai unregister . --dry-run`);
        return 1;
      }
      const isDryRun = args.includes("--dry-run");
      let meta = getProjectMeta(target);

      if (!meta && /^[0-9a-f]{16}$/.test(target)) {
        const storageDir = getProjectStorageDir(target);
        if (fs.existsSync(storageDir)) {
          meta = {
            id: target,
            name: `orphaned-${target}`,
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
        console.error(`[kai] No project registered for: ${target}`);
        return 1;
      }

      const storageDir = getProjectStorageDir(meta.id);
      console.log(`[kai] Unregister Operation Scope:`);
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
      console.log(`[kai] Project "${meta.name}" unregistered; index data deleted.`);
      return 0;
    }

    // 3. kai graph rebuild [path]
    if (command === "graph" && args[1] === "rebuild") {
      const targetPath = args[2] || process.cwd();
      const meta = registerProject(targetPath);
      console.log(`[kai] Rebuilding index for "${meta.name}"...`);
      const index = await indexProject(meta, { forceRebuild: true });
      console.log(
        `[kai] Rebuild complete! Indexed ${Object.keys(index.files).length} files and ${Object.keys(index.symbolIndex).length} symbols.`
      );
      return 0;
    }

    // 4. kai query <task> [path]
    if (command === "query") {
      const task = args[1];
      if (!task) {
        console.error(`[kai] Error: Please provide a task or query string.`);
        console.error(`Example: kai query "Explain how workspaces are restored"`);
        return 1;
      }

      const targetPath = args[2] || process.cwd();
      let meta = getProjectMeta(targetPath);
      if (!meta) {
        meta = registerProject(targetPath);
      }

      let index = loadProjectIndex(meta.id);
      if (!index) {
        console.log(`[kai] Project not indexed yet. Indexing now...`);
        index = await indexProject(meta);
      }

      const { renderedPrompt } = assembleContext(index, { task });
      console.log(renderedPrompt);
      return 0;
    }

    // 5. kai cost [path]
    if (command === "cost") {
      const targetPath = args[1] || process.cwd();
      const meta = getProjectMeta(targetPath);
      if (!meta) {
        console.error(`[kai] No project registered for: ${targetPath}`);
        return 1;
      }

      const index = loadProjectIndex(meta.id);
      if (!index) {
        console.error(`[kai] Project not indexed yet. Run 'kai code' first.`);
        return 1;
      }

      console.log(`[kai] Project Token & Footprint Metrics:`);
      console.log(`  Project:           ${meta.name}`);
      console.log(`  Files Indexed:     ${meta.fileCount}`);
      console.log(`  Symbols Indexed:   ${meta.symbolCount}`);
      console.log(`  Total Est Tokens:  ~${index.totalTokensEstimated}`);
      console.log(`  Context Budget:    4,000 tokens (default)`);
      console.log(`  Storage Size:      Outside repository (~/.kai/projects/${meta.id})`);
      return 0;
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

    // 7. kai session list
    if (command === "session" && args[1] === "list") {
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

    // 11. kai agent list (dynamic system detection + wiring state)
    if (command === "agent" && (args[1] === "list" || args[1] === "status")) {
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
        `\nRun 'kai agent setup <name>' to install MCP wiring, e.g. 'kai agent setup opencode'.`
      );
      console.log(`Run 'kai agent setup all' to wire every installed agent at once.`);
      return 0;
    }

    // 11b. kai agent setup <agent|all> / kai agent register ...
    // Automatically installs kai MCP wiring into the agent's own config
    // file (with backup). Use --print for the snippet only, --dry-run to
    // preview, --force to refresh an existing kai entry.
    if (command === "agent" && (args[1] === "setup" || args[1] === "register")) {
      // Flags may appear before or after the agent name.
      const rest = args.slice(2);
      const positionals = rest.filter((a) => !a.startsWith("-"));
      const rawTarget = (positionals[0] || "").toLowerCase();
      const printOnly = args.includes("--print");
      const dryRun = args.includes("--dry-run");
      const force = args.includes("--force");
      const scope = args.includes("--project")
        ? ("project" as const)
        : args.includes("--global")
          ? ("global" as const)
          : ("auto" as const);
      // Resolve the installed entry point, not the cwd. The old code used
      // process.cwd()/bin/kai.js which is wrong for global installs.
      const kaiBin = process.argv[1] ? path.resolve(process.argv[1]) : "kai";

      if (!rawTarget || rawTarget.startsWith("-")) {
        // Missing target: show dynamic system state so users can see at a
        // glance which agents are actually installed right now.
        const detected = detectInstalledAgentsSync({ projectDir: process.cwd() });
        console.log(`\nAvailable agent setup targets (live system status):`);
        for (const d of detected) {
          const icon = d.binaryFound ? "✓" : "✗";
          const wired = d.kaiWired ? "wired ✓" : "not wired";
          console.log(`  ${icon} kai agent setup ${d.id.padEnd(10)} ${d.configFile} (${wired})`);
        }
        console.log(`\nTip: 'kai agent list' shows full install paths and config state.`);
        console.log(`Tip: 'kai agent setup all' wires every installed agent automatically.`);
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
        // Unknown agent — try to resolve it dynamically from PATH before giving up.
        // If a binary with that name exists, synthesise a custom mcpServers entry on
        // the fly and write it to ~/.config/<agent>/mcp.json (XDG-style).
        const { findDynamicAgentBinary, buildDynamicAgentSetup } =
          await import("../core/agents.js");
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
          console.log(`  ${icon} kai agent setup ${d.id.padEnd(10)} ${d.configFile}`);
        }
        console.log(`\nTip: 'kai agent list' shows full install paths and config state.`);
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

    console.error(`[kai] Unknown command: "${command}". Run 'kai --help' for usage.`);
    return 1;
  } catch (err: unknown) {
    console.error(`[kai] Error: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
}
