import path from "path";
import fs from "fs";
import { registerProject, loadProjectIndex } from "../core/registry";
import { indexProject } from "../core/indexer";
import {
  AGENT_REGISTRY,
  applyAgentSetup,
  autoSetupDetectedAgents,
  buildAgentSetup,
  detectInstalledAgentsSync,
  findDynamicAgentBinary,
  findBinaryOnPath,
  buildDynamicAgentSetup,
  removeAgentSetup,
} from "../core/agents";
import {
  detectChangedFilesFromDisk,
  runCodeTaskWithAutoSync,
  runExternalAgentCommand,
  resolveSpawnTarget,
  resetTerminalModesAfterAgent,
} from "../core/codeModeWorkflow";
import { installCommitMsgHook } from "../core/githooks";
import { announceCodeMode, clearActiveProjectState, saveActiveProjectState } from "./activeProject";
import type { AgentDefinition } from "../core/agents";

/**
 * Built-in command names. Grouped so the public surface stays obvious:
 * - public: open, close, stop, health, remove, graph, list, setup, agent/agents, metrics, lsp, doctor
 * - hidden compat (still work, not in help): unregister (= remove),
 *   config (= list -c), session (= list -s / remove -s),
 *   mcp (used by agent configs), run/bench (advanced)
 * - removed (friendly redirect): code, clear, query, cost, status
 */
const BUILTIN_COMMANDS = new Set([
  "open",
  "close",
  "stop",
  "health",
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
  "code",
  "clear",
  "query",
  "cost",
]);

/** Resolve an agent name or alias against registered agents and dynamically detected PATH binaries. */
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
  announceCodeMode(meta.canonicalPath);
  try {
    installCommitMsgHook(meta.canonicalPath);
  } catch {
    // ignore hook install errors
  }

  // 2. Auto-wire MCP for the agent
  const resolved = resolveAgent(agentNameOrCommand);
  if (resolved) {
    const kaiBin = resolveKaiBin();
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
    clearActiveProjectState(meta.canonicalPath);
    announceCodeMode(null);
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
        const target = resolveSpawnTarget(binaryToRun!, finalArgs);
        const result = await runExternalAgentCommand(target.command, target.args, {
          cwd: meta.canonicalPath,
          timeoutMs: opts.timeoutMs,
          signal: controller.signal,
          shell: target.shell,
        });
        // The agent is a fullscreen TUI: restore mouse/focus/paste input
        // modes NOW (before any further logging) so a killed/crashed agent
        // that skipped its own DECSET cleanup cannot keep injecting ghost
        // input on mouse move / window focus. Idempotent; TTY-only. The
        // outer finally below re-emits it for abort/throw paths. Also erases
        // the TUI's leftover last frame so the "Agent finished" line below
        // does not land on top of it.
        resetTerminalModesAfterAgent({ clearStaleUi: true });
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
        `[kai] Note: the timed-out command was signalled (SIGTERM, then SIGKILL after 2 s; process tree on Windows). A detached grandchild may still be writing; freshness above is point-in-time — rerun 'kai graph status' or 'kai graph update' if it keeps changing.`
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
    // Guarantee terminal-mode restore on abort/throw paths where the
    // outcome closure above never ran (idempotent no-op otherwise).
    resetTerminalModesAfterAgent();
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onInterrupt);
    // Code Mode lasts as long as the agent run: without this the footer
    // stayed on "Code Mode" forever after the first `kai code`.
    clearActiveProjectState(meta.canonicalPath);
    announceCodeMode(null);
  }
}

/**
 * Path to the running kai CLI script (symlinks resolved), used as the command
 * written into agents' MCP configs. Falls back to the bare name when the
 * script was deleted or moved since launch.
 */
function resolveKaiBin(): string {
  let kaiBin = process.argv[1] ? path.resolve(process.argv[1]) : "kai";
  try {
    const real = fs.realpathSync(kaiBin);
    if (real.toLowerCase().endsWith(".js")) kaiBin = real;
  } catch {
    // Unresolvable — keep the resolved argv.
  }
  return kaiBin;
}

function printBackupNote(backupPath: string | undefined | null): void {
  if (!backupPath) return;
  console.log(`[kai] Previous config backed up to: ${backupPath}`);
  console.log(
    `[kai] The backup is kept intentionally — delete it after verifying the new config works.`
  );
}

/** Removes Kai's MCP wiring from one agent and reports the outcome as an exit code. */
export function removeAgentWiring(agent: string, dryRun: boolean): number {
  const result = removeAgentSetup(agent, { projectDir: process.cwd(), scope: "auto", dryRun });
  if (dryRun) {
    console.log(`[kai] Dry-run: ${result.message}`);
    return 0;
  }
  console.log(`[kai] ${result.message}`);
  return result.removed ? 0 : 1;
}

export async function executeAgentSetupWorkflow(
  rawTarget: string,
  allArgs: string[]
): Promise<number> {
  const printOnly = allArgs.includes("--print");
  const dryRun = allArgs.includes("--dry-run");
  const force = allArgs.includes("--force");
  const scope = allArgs.includes("--project")
    ? ("project" as const)
    : allArgs.includes("--global")
      ? ("global" as const)
      : ("auto" as const);
  const kaiBin = resolveKaiBin();

  if (!rawTarget || rawTarget.startsWith("-")) {
    const detected = detectInstalledAgentsSync({ projectDir: process.cwd() });
    console.log(`\nAvailable agent setup targets (live system status):`);
    for (const d of detected) {
      const icon = d.binaryFound ? "✓" : "✗";
      const wired = d.kaiWired ? "wired ✓" : "not wired";
      console.log(`  ${icon} kai mcp ${d.id.padEnd(10)} ${d.configFile} (${wired})`);
    }
    console.log(`\nTip: 'kai list mcp' shows full install paths and MCP config state.`);
    console.log(`Tip: 'kai mcp all' wires every installed agent automatically.`);
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
    console.log(`[kai] Done: ${wrote} wired, ${already} already configured, ${skipped} skipped.`);
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
        printBackupNote(dynamicResult.backupPath);
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
      console.log(`  ${icon} kai mcp ${d.id.padEnd(10)} ${d.configFile}`);
    }
    console.log(`\nTip: 'kai list mcp' shows full install paths and config state.`);
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
  printBackupNote(result.backupPath);
  console.log(`[kai] Restart ${result.name} so it picks up the kai MCP server.`);
  return 0;
}
