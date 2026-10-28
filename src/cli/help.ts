import { MCP_TOOLS } from "../core/mcp";
import { detectInstalledAgentsSync } from "../core/agents";
import { KAI_VERSION } from "./constants";

export function printMcpHelp(): void {
  console.log(`
Kai MCP (Model Context Protocol) Management

Usage:
  kai mcp <agent|all>             Wire an AI agent to Kai MCP (--print, --dry-run, --force)
  kai mcp setup <agent|all>       Explicit setup alias for an agent
  kai mcp list                    Show MCP server info, tools, and agent connection status
  kai mcp remove <agent>          Remove Kai MCP wiring from an agent

Options:
  --print                         Print config snippet without writing
  --dry-run                       Simulate without modifying files
  --force                         Overwrite existing Kai MCP entry
  --project                       Write to project-scoped config if supported
  --global                        Write to global user config
  --watch                         (server) Keep the graph fresh in the background while
                                  serving (or set KAI_MCP_WATCH=1); off by default

Examples:
  kai mcp claude                  Connect Claude Code to Kai MCP
  kai mcp all                     Auto-wire all detected agents
  kai mcp list                    List MCP status and wired agents
  kai mcp remove claude           Remove Kai MCP wiring from Claude Code
  kai remove -m claude            Alternative removal syntax
`);
}

export function printMcpStatus(projectDir: string = process.cwd()): void {
  console.log(`[kai] MCP (Model Context Protocol) Server & Agent Status:\n`);
  console.log(`  Local MCP Server:`);
  console.log(`    Protocol:      JSON-RPC 2.0 (stdio)`);
  console.log(`    Project Root:  ${projectDir}`);
  console.log(`    Tools (${MCP_TOOLS.length}):     ${MCP_TOOLS.map((t) => t.name).join(", ")}\n`);

  const detected = detectInstalledAgentsSync({ projectDir });
  console.log(`  Connected Agents:`);
  for (const d of detected) {
    const icon = d.kaiWired ? "✓" : "✗";
    const status = d.binaryFound ? `Installed (${d.binaryPath})` : "Not installed on PATH";
    const wired = d.kaiWired ? "kai wired ✓" : "not wired";
    console.log(
      `    ${icon} ${d.id.padEnd(10)} ${d.name.padEnd(16)} ${wired.padEnd(13)} · ${d.configFile} (${status})`
    );
  }
  console.log(
    `\nTip: 'kai mcp <agent>' (e.g. 'kai mcp claude') or 'kai mcp all' to wire an agent.`
  );
  console.log(`Tip: 'kai remove -m <agent>' or 'kai mcp remove <agent>' to remove MCP wiring.`);
}

export function printHelp(): void {
  console.log(`
Kai Terminal — CLI (v${KAI_VERSION})

Usage:
  kai <command> [options]

Outside Kai (any shell):
  open [path]             Launch Kai Terminal (defaults to current folder)
  kai (no args, from a    Opens the app — any non-interactive launcher
    launcher / script)    click (desktop drawer, pinned shortcut) counts
  health                  System readiness and health check
  doctor                  Environment, PATH, and install diagnostics
  list [-a|-m|-i|-s|-c]   Look up agents (-a, default), MCP (-m),
                          projects (-i), sessions (-s), config (-c)
  remove [-m|-a|-i|-s]    Delete Kai data: MCP/agent wiring (-m/-a <name>),
                          project index (-i <path|id>), project session (-s [path])
  close                   Quit Kai Terminal

Inside Kai Terminal — Run:
  <agent> [path]          Run an AI tool (replace <agent> with its command)
  stop                    Back to plain terminal (maps and files are kept)

Manage & Integrate:
  agent <add|remove> [name]
                        Wire one tool (--print, --dry-run, --force,
                        --project), or unwire one (aliases: agents; add =
                        setup/install, remove = rm/unlink/unregister)
  setup <agent|all>       Connect Kai to a tool (alias for kai agent add)
  mcp [agent|list|remove] Manage MCP server & agent connections (e.g. kai mcp claude)
  graph <init|update|status> [path]
                        Build, rebuild, or inspect the code-map

Diagnostics:
  lsp                     Check installed language servers
  metrics [clear]         Show or wipe local timing stats

Flags:
  -h, --help              Show help
  -v, --version           Show version

Examples:
  kai open /path/to/project
  kai <agent> .
  kai agent add claude
  kai agent remove claude
  kai mcp claude
  kai mcp list
  kai remove -m claude
  kai list -a
  kai list -m
  kai graph status .
  kai remove -s .
  kai health
`);
}

/** Shown instead of starting the stdio MCP server when `kai mcp` runs in an interactive terminal. */
export function printMcpStdioNote(): void {
  console.log(
    `[kai] Note: The MCP server runs automatically over stdio for connected AI coding tools.`
  );
  console.log(
    `Tip: Run 'kai mcp <agent>' to connect an agent (e.g. 'kai mcp claude'), or 'kai mcp list' to view status.`
  );
}
