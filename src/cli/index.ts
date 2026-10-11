import path from "path";
import fs from "fs";
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

export const KAI_VERSION = "0.1.0";

/**
 * Build the verified MCP configuration snippet for an external agent.
 * Pure function (takes kaiBin explicitly) so Windows-style paths can be
 * unit-tested on any OS. Paths are JSON-escaped: interpolating a raw
 * Windows path (`C:\tools\...`) into the snippet would emit invalid JSON
 * (`\t` parses as a tab escape).
 *
 * Supported agents: claude, cursor, codex, gemini, copilot (vscode),
 * windsurf, cline. Unknown ids return null.
 */
export const SUPPORTED_AGENTS = [
  "claude",
  "cursor",
  "codex",
  "gemini",
  "copilot",
  "windsurf",
  "cline",
] as const;

export function buildAgentSetup(agent: string, kaiBin: string): string | null {
  const normalized = agent.toLowerCase();
  const quotedBin = JSON.stringify(kaiBin);
  if (normalized === "claude") {
    return `
Verified Claude Code MCP Configuration:
Add the following to your Claude Code settings (e.g., ~/.claude.json or project config):

{
  "mcpServers": {
    "kai": {
      "command": "node",
      "args": [${quotedBin}, "mcp", "."]
    }
  }
}

Verification:
Run: claude
In chat: "Use kai_project_info to inspect the codebase."
`;
  }

  if (normalized === "cursor") {
    return `
Verified Cursor MCP Configuration:
Add to .cursor/mcp.json or Cursor Settings > MCP:

{
  "mcpServers": {
    "kai": {
      "command": "node",
      "args": [${quotedBin}, "mcp", "\${workspaceFolder}"]
    }
  }
}
`;
  }

  if (normalized === "codex") {
    return `
Verified OpenAI Codex / CLI Agent Configuration:
Launch Codex with MCP stdio configuration pointing to Kai:

{
  "mcp_servers": [
    {
      "name": "kai",
      "command": "node",
      "args": [${quotedBin}, "mcp", "."]
    }
  ]
}
`;
  }

  if (normalized === "gemini") {
    return `
Verified Gemini CLI MCP Configuration:
Add to ~/.muse/settings.json (or .muse/settings.json for project scope):

{
  "mcpServers": {
    "kai": {
      "command": "node",
      "args": [${quotedBin}, "mcp", "."]
    }
  }
}

Verification:
Run: gemini
In chat: "Use kai_project_info to inspect the codebase."
`;
  }

  if (normalized === "copilot" || normalized === "vscode") {
    return `
Verified VS Code / Copilot MCP Configuration:
Add to .vscode/mcp.json:

{
  "servers": {
    "kai": {
      "type": "stdio",
      "command": "node",
      "args": [${quotedBin}, "mcp", "."]
    }
  }
}

Verification:
Open VS Code MCP settings and confirm the "kai" server is running.
`;
  }

  if (normalized === "windsurf" || normalized === "codeium") {
    return `
Verified Windsurf MCP Configuration:
Add to ~/.codeium/windsurf/mcp_config.json:

{
  "mcpServers": {
    "kai": {
      "command": "node",
      "args": [${quotedBin}, "mcp", "."]
    }
  }
}

Verification:
Restart Windsurf and confirm the "kai" MCP server is connected.
`;
  }

  if (normalized === "cline") {
    return `
Verified Cline MCP Configuration:
Add to cline_mcp_settings.json (VS Code Cline extension settings):

{
  "mcpServers": {
    "kai": {
      "command": "node",
      "args": [${quotedBin}, "mcp", "."]
    }
  }
}

Verification:
Open the Cline MCP settings panel and confirm the "kai" server is listed.
`;
  }

  return null;
}

export function printHelp(): void {
  console.log(`
Kai Terminal — Project Intelligence & CLI (v${KAI_VERSION})
Lightweight terminal-first project intelligence tool for external AI coding agents.

Usage:
  kai <command> [options]

Commands:
  code [path]             Register and index a project (does not launch an agent)
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
  agent setup <agent>     Output verified MCP configuration for external agents (claude, cursor, codex, gemini, copilot, windsurf, cline)
  metrics [clear]         Display local privacy-safe telemetry summary

Flags:
  -h, --help              Show help information
  -v, --version           Show version information

Examples:
  kai code .
  kai status
  kai unregister . --dry-run
  kai query "Explain PtyManager lifecycle"
  kai graph rebuild .
  kai session clean --dry-run
  kai mcp .
  kai agent setup claude
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
    // 1. kai code [path]
    if (command === "code") {
      const targetPath = args[1] || process.cwd();
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
      const meta = getProjectMeta(target);

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
        const ALLOWED_KEYS = new Set([
          "defaultTokenBudget",
          "maxFileSizeBytes",
          "indexingDepth",
          "telemetryLocal",
        ]);
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
          "Success Rate": `${Math.round(b.taskSuccessRate * 100)}%`,
        }))
      );
      return 0;
    }

    // 11. kai agent setup <agent>
    if (command === "agent" && args[1] === "setup") {
      const agent = (args[2] || "").toLowerCase();
      // Resolve the installed entry point, not the cwd. The old code used
      // process.cwd()/bin/kai.js which is wrong for global installs.
      const kaiBin = process.argv[1] ? path.resolve(process.argv[1]) : "kai";
      const snippet = buildAgentSetup(agent, kaiBin);

      if (snippet) {
        console.log(snippet);
        return 0;
      }

      console.log(`
Available agent setup targets:
  kai agent setup claude
  kai agent setup cursor
  kai agent setup codex
  kai agent setup gemini
  kai agent setup copilot   (VS Code)
  kai agent setup windsurf
  kai agent setup cline
`);
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
