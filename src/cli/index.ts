import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { KAI_VERSION } from "./constants";
import { clearActiveProjectState } from "./activeProject";
import { executeAgentWorkflow, resolveAgent } from "./agentWorkflow";
import { printDoctorReport } from "./doctor";
import { printHelp } from "./help";
import { runAgentRemove, runAgentSetup } from "./commands/agent";
import { runBench, runRun } from "./commands/advanced";
import { runConfig } from "./commands/config";
import { runClose, runOpen } from "./commands/desktop";
import { runLsp, runMetrics } from "./commands/diagnostics";
import { runGraph } from "./commands/graph";
import { runList } from "./commands/list";
import { runMcp } from "./commands/mcp";
import { runRemove } from "./commands/remove";
import { runSessionClean, runSessionList } from "./commands/session";

// Public surface consumed by tests and the doctor/launch tooling.
export { buildAgentSetup, AGENT_REGISTRY } from "../core/agents";
export { findKaiAppBinary, isKaiCliShim } from "./desktopApp";
export { resolveAgent } from "./agentWorkflow";
export { parseDesktopEntry, resolveExecTarget, auditDesktopFile } from "./doctor";
export type { DesktopEntryAudit } from "./doctor";

function isInsideKaiTerminal(): boolean {
  if (process.env.KAI_TERMINAL === "1") return true;
  if (process.env.TERM_PROGRAM === "kai") return true;
  if (process.env.VITEST || process.env.NODE_ENV === "test") return true;
  return false;
}

/** Commands that may run from any shell (everything else needs Kai Terminal). */
const EXTERNAL_COMMANDS = new Set([
  "open",
  "close",
  "mcp",
  "setup",
  "health",
  "doctor",
  "list",
  "remove",
  "unregister",
  // Hidden compat for `kai list -c` (already external): keeps the CI smoke
  // probe `kai config list` working outside Kai Terminal.
  "config",
  "session",
  "help",
  "--help",
  "-h",
  "version",
  "--version",
  "-v",
]);

/** Removed commands (single redirect, kept for old muscle memory). */
const REMOVED_HINTS = new Map<string, string>([
  [
    "code",
    "'kai code' has been removed. Use 'kai graph init [path]' to index or 'kai <agent>' to run a tool.",
  ],
  ["clear", "'kai clear' has been removed. Use 'kai stop' to exit Code Mode."],
  ["query", "'kai query' has been removed. Use 'kai graph status' or 'kai health'."],
  ["cost", "'kai cost' has been removed. Use 'kai metrics' for local stats."],
  [
    "status",
    "'kai status' has been replaced by 'kai health' (and 'kai graph status' for code-map state).",
  ],
]);

const AGENT_SETUP_SUBCOMMANDS = new Set(["setup", "register", "add", "install"]);
const AGENT_REMOVE_SUBCOMMANDS = new Set(["remove", "rm", "unlink", "unregister"]);

let activeCliPromise: Promise<number> | null = null;

export async function runCli(argv: string[]): Promise<number> {
  if (activeCliPromise) {
    return activeCliPromise;
  }
  activeCliPromise = executeCli(argv);
  try {
    return await activeCliPromise;
  } finally {
    activeCliPromise = null;
  }
}

async function executeCli(argv: string[]): Promise<number> {
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
    return await dispatch(command, args);
  } catch (err: unknown) {
    console.error(`[kai] Error: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
}

async function dispatch(command: string, args: string[]): Promise<number> {
  // External commands: talk to the desktop app.
  if (command === "open") return runOpen(args);
  if (command === "close") return runClose();

  const removedHint = REMOVED_HINTS.get(command);
  if (removedHint) {
    console.error(`[kai] ${removedHint}`);
    return 1;
  }

  // Boundary enforcement: internal commands must run inside Kai Terminal.
  if (!isInsideKaiTerminal() && !EXTERNAL_COMMANDS.has(command)) {
    console.error(`[kai] Error: 'kai ${command}' can only be executed inside Kai Terminal.`);
    console.error(`To open or focus Kai Terminal for your project, run:\n  kai open [path]`);
    return 1;
  }

  // Internal command: AI agent execution (kai <agent> [path])
  if (resolveAgent(command)) {
    return executeAgentWorkflow(command, args[1] || process.cwd());
  }

  switch (command) {
    // kai stop — clear Code Mode, back to plain terminal mode.
    case "stop":
      clearActiveProjectState();
      console.log(`[kai] Code Mode cleared — back to plain terminal mode.`);
      return 0;
    case "health":
    case "--health":
      console.log(`✔ Kai v${KAI_VERSION} is ready\n\n✔ Fast and private · Free`);
      return 0;
    // kai remove -i <path|id> | -a <name> | -s [target] [--dry-run]
    case "remove":
    case "unregister":
      return runRemove(args);
    // kai graph [init|update|status] [path]
    case "graph":
      return runGraph(args);
    // Hidden compat: `kai config` (prefer `kai list -c`). Still tested, so it stays working.
    case "config":
      return runConfig(args);
    // Hidden compat: `kai session` (prefer `kai list -s` / `kai remove -s`).
    case "session":
      if (!args[1] || args[1] === "list") return runSessionList();
      if (args[1] === "clean") return runSessionClean(args);
      break;
    // kai mcp [subcommand|agent]: agent wiring, status/list, removal.
    case "mcp":
      return runMcp(args);
    // Hidden advanced: `kai run [path] [--timeout-ms N] -- <command> [args...]`
    case "run":
      return runRun(args);
    // Hidden advanced: `kai bench [path]` (dev-only benchmark, not in manual).
    case "bench":
      return runBench(args);
    // kai list [options] (dynamic system detection + resources)
    case "list":
      return runList(args);
    // kai setup <agent|all> / kai agent <setup|add> <agent|all>
    case "setup":
      return runAgentSetup(args);
    case "agent":
    case "agents":
      if (AGENT_SETUP_SUBCOMMANDS.has(args[1])) return runAgentSetup(args);
      if (AGENT_REMOVE_SUBCOMMANDS.has(args[1])) return runAgentRemove(args);
      break;
    case "metrics":
      return runMetrics(args);
    case "lsp":
      return runLsp();
    // kai doctor — environment & install diagnostics, including the Linux
    // app-drawer (.desktop) audit: a drawer entry whose Exec target is
    // missing (or icon unresolvable) silently does nothing on click.
    case "doctor":
      printDoctorReport();
      return 0;
  }

  console.error(`[kai] Unknown command: "${command}". Run 'kai --help' for usage.`);
  return 1;
}

// Auto-execute when run directly as a script (e.g. node dist/cli/index.js)
if (!process.env.VITEST && typeof process !== "undefined" && process.argv && process.argv[1]) {
  const runAsScript = () =>
    runCli(process.argv)
      .then((code) => {
        if (typeof code === "number") process.exit(code);
      })
      .catch((err) => {
        console.error("[kai] Fatal error:", err);
        process.exit(1);
      });

  try {
    const scriptPath = path.resolve(process.argv[1]);
    const thisPath = fileURLToPath(import.meta.url);
    const isDirectRun =
      (scriptPath === thisPath ||
        fs.realpathSync(scriptPath) === fs.realpathSync(thisPath) ||
        scriptPath.endsWith(path.join("cli", "index.js")) ||
        scriptPath.endsWith("cli/index.js")) &&
      !scriptPath.endsWith("kai.js");

    if (isDirectRun) runAsScript();
  } catch {
    // If realpathSync fails (e.g. file unlinked), fall back to path suffix check
    if (process.argv[1].endsWith("dist/cli/index.js") || process.argv[1].endsWith("cli/index.js")) {
      runAsScript();
    }
  }
}
