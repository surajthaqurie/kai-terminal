import fs from "fs";
import { resolveCanonicalPath } from "../../core/registry";
import { startMcpServer } from "../../core/mcp";
import { AGENT_REGISTRY, findDynamicAgentBinary, listAgentIds } from "../../core/agents";
import { AGENT_FLAGS, flagValue } from "../args";
import { printMcpHelp, printMcpStatus, printMcpStdioNote } from "../help";
import { executeAgentSetupWorkflow, removeAgentWiring } from "../agentWorkflow";

const REMOVE_SUBCOMMANDS = new Set(["remove", "rm", "unlink", "unregister"]);
const SETUP_SUBCOMMANDS = new Set(["setup", "add", "install"]);

/** True for `all` or a known / PATH-detected agent id or alias. */
function isKnownAgent(name: string): boolean {
  const knownAgentIds = listAgentIds().map((id) => id.toLowerCase());
  return (
    name === "all" ||
    name === "--all" ||
    knownAgentIds.includes(name) ||
    AGENT_REGISTRY.some(
      (a) => a.id.toLowerCase() === name || a.aliases.some((al) => al.toLowerCase() === name)
    ) ||
    Boolean(findDynamicAgentBinary(name))
  );
}

/** Serves MCP over stdio; in an interactive terminal it only explains how to connect an agent. */
async function serveMcp(projectDir: string, watch: boolean): Promise<number> {
  if (process.stdin.isTTY) {
    printMcpStdioNote();
    return 0;
  }
  await startMcpServer(projectDir, process.stdin, process.stdout, { watch });
  return 0;
}

/** `kai mcp [subcommand|agent|path]`: agent wiring, status/list, removal, or the stdio server. */
export async function runMcp(args: string[]): Promise<number> {
  const sub = (args[1] || "").toLowerCase();

  if (!args[1] || sub === "--help" || sub === "-h" || sub === "help") {
    printMcpHelp();
    return 0;
  }

  if (sub === "list" || sub === "status") {
    printMcpStatus(process.cwd());
    return 0;
  }

  if (REMOVE_SUBCOMMANDS.has(sub)) {
    const target = flagValue(args, AGENT_FLAGS) ?? args[2];
    if (!target || target.startsWith("-")) {
      console.error(`[kai] Error: Please specify an agent name to remove.`);
      console.error(`Example: kai mcp remove claude`);
      return 1;
    }
    return removeAgentWiring(target, args.includes("--dry-run"));
  }

  if (SETUP_SUBCOMMANDS.has(sub)) {
    return await executeAgentSetupWorkflow((args[2] || "").toLowerCase(), args);
  }
  if (isKnownAgent(sub)) {
    return await executeAgentSetupWorkflow(sub, args);
  }

  // Opt-in graph watcher for pure-MCP clients (default off).
  const watch = args.includes("--watch") || process.env.KAI_MCP_WATCH === "1";
  const pathArg = args.slice(1).find((a) => a !== "--watch");

  if (sub === "." || sub === "start" || sub === "--watch") {
    return await serveMcp(process.cwd(), watch);
  }

  const targetPath = pathArg || process.cwd();
  if (pathArg && !fs.existsSync(resolveCanonicalPath(targetPath))) {
    console.error(
      `[kai] Error: "${pathArg}" is neither an existing directory nor a recognized agent/command.`
    );
    console.error(`Run 'kai mcp --help' or 'kai mcp list' to see available options and agents.`);
    return 1;
  }
  return await serveMcp(targetPath, watch);
}
