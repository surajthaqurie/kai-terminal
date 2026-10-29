import path from "path";
import fs from "fs";
import {
  getProjectMeta,
  deleteProjectData,
  getProjectStorageDir,
  getKaiHomeDir,
  resolveCanonicalPath,
} from "../../core/registry";
import { clearActiveProjectState } from "../activeProject";
import { removeAgentWiring } from "../agentWorkflow";
import { listSessionCacheFiles, removeFiles } from "../sessionFiles";
import { findProvider, PROVIDER_CATALOG } from "../../core/integrations/providerCatalog";
import { runProviderRemove, runRemoveByName } from "./provider";

interface RemoveOptions {
  dryRun: boolean;
  /** `-i <path|id>`: "" when the flag was given without a value. */
  indexTarget: string | null;
  /** `-m|-a <name>`: "" when the flag was given without a value. */
  agentTarget: string | null;
  /** `-s [target]` */
  removeSessions: boolean;
  sessionTarget: string | null;
}

const isValue = (arg: string | undefined): arg is string => Boolean(arg) && !arg!.startsWith("-");

function parseRemoveArgs(args: string[]): RemoveOptions {
  const opts: RemoveOptions = {
    dryRun: args.includes("--dry-run"),
    indexTarget: null,
    agentTarget: null,
    removeSessions: false,
    sessionTarget: null,
  };

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    if (arg === "--dry-run") continue;
    if (arg === "-i" || arg === "--index") {
      opts.indexTarget = isValue(next) ? next : "";
      i++;
    } else if (arg === "-m" || arg === "--mcp" || arg === "-a" || arg === "--agent") {
      opts.agentTarget = isValue(next) ? next : "";
      i++;
    } else if ((arg === "mcp" || arg === "agent") && i === 1) {
      opts.agentTarget = isValue(next) ? next : "";
      i++;
    } else if (arg === "-s" || arg === "--session") {
      opts.removeSessions = true;
      if (isValue(next)) {
        opts.sessionTarget = next;
        i++;
      }
    }
  }
  return opts;
}

/** 1. Remove a project's index data (the repository itself is never touched). */
function removeProjectIndex(target: string, dryRun: boolean): number {
  if (!target) {
    console.error(`[kai] Error: Please specify a project path or id to remove with -i/--index.`);
    console.error(`Example: kai remove -i . --dry-run`);
    return 1;
  }
  let meta = getProjectMeta(target);

  if (!meta && /^[0-9a-f]{16}$/.test(target)) {
    if (fs.existsSync(getProjectStorageDir(target))) {
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

  console.log(`[kai] Remove Project Index Scope:`);
  console.log(`  Project:           "${meta.name}" (id: ${meta.id})`);
  console.log(`  Index data:        ${getProjectStorageDir(meta.id)}`);
  console.log(`  NOTE: Only Kai-owned data under ~/.kai/projects/ is removed.`);
  console.log(`  NOTE: The repository at ${meta.canonicalPath} is NOT touched.`);

  if (dryRun) {
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

/** 2. Remove Kai's MCP wiring from an agent. */
function removeAgent(target: string, dryRun: boolean): number {
  if (!target) {
    console.error(
      `[kai] Error: Please specify an agent name to remove with -m/--mcp (or -a/--agent).`
    );
    console.error(`Example: kai remove -m <name>`);
    return 1;
  }
  return removeAgentWiring(target, dryRun);
}

/** 3. Remove session and cache files, for every project or one project. */
function removeSessions(sessionTarget: string | null, dryRun: boolean): number {
  const { sessionsDir, cacheDir, sessionFiles, cacheFiles } = listSessionCacheFiles();

  let targetSessionFiles = sessionFiles;
  let targetCacheFiles = cacheFiles;
  let targetScopeDesc = "all projects";
  let activeMatched = false;

  if (sessionTarget && sessionTarget !== "all") {
    const candidatePath = sessionTarget === "." ? process.cwd() : sessionTarget;
    const canonicalPath = resolveCanonicalPath(candidatePath);
    let meta = getProjectMeta(candidatePath) || getProjectMeta(canonicalPath);
    if (!meta && /^[0-9a-f]{16}$/.test(sessionTarget)) {
      meta = getProjectMeta(sessionTarget);
    }

    const projId =
      meta?.id || (fs.existsSync(canonicalPath) ? path.basename(canonicalPath) : sessionTarget);
    const projName = meta?.name || path.basename(canonicalPath);
    targetScopeDesc = `project "${projName}" (${canonicalPath})`;

    const belongsToProject = (f: string) =>
      f.includes(projId) || (meta && (f.includes(meta.id) || f.includes(meta.name)));
    targetSessionFiles = sessionFiles.filter(belongsToProject);
    targetCacheFiles = cacheFiles.filter(belongsToProject);

    // Check if active_project matches this project
    const activeFile = path.join(getKaiHomeDir(), "active_project.json");
    if (fs.existsSync(activeFile)) {
      try {
        const activeData = JSON.parse(fs.readFileSync(activeFile, "utf-8"));
        if (
          activeData.id === meta?.id ||
          activeData.path === canonicalPath ||
          sessionTarget === "."
        ) {
          activeMatched = true;
        }
      } catch {}
    }
  }

  console.log(`[kai] Remove Session Scope:`);
  console.log(`  Scope:                   ${targetScopeDesc}`);
  console.log(`  Session files to remove: ${targetSessionFiles.length} (in ${sessionsDir})`);
  console.log(`  Cache files to remove:   ${targetCacheFiles.length} (in ${cacheDir})`);
  if (activeMatched) {
    console.log(`  Active project state:    will be cleared`);
  }
  console.log(`  NOTE: Project index databases in ~/.kai/projects/ are NOT touched.`);

  if (dryRun) {
    console.log(`[kai] Dry-run complete. No files were deleted.`);
    return 0;
  }

  removeFiles(sessionsDir, targetSessionFiles);
  removeFiles(cacheDir, targetCacheFiles);
  if (activeMatched) {
    clearActiveProjectState();
  }
  console.log(`[kai] Session and cache data for ${targetScopeDesc} cleanly cleared.`);
  return 0;
}

function printRemoveUsage(): void {
  console.error(`[kai] Error: Please specify what to remove using a flag:`);
  console.error(`  -i, --index <path|id>         Remove project index (repo is untouched)`);
  console.error(`  -m, --mcp, -a, --agent <name> Remove Kai MCP configuration from an agent`);
  console.error(`  -s, --session [target]        Remove session and cache files`);
  for (const p of PROVIDER_CATALOG) {
    const name = p.aliases[0] ?? p.id;
    console.error(`  ${name.padEnd(30)}Disconnect ${p.label} from this folder`);
  }
  console.error(`\nExamples:`);
  console.error(`  kai remove -i .`);
  console.error(`  kai remove -i /path/to/project`);
  console.error(`  kai remove -m claude`);
  console.error(`  kai remove -a claude`);
  console.error(`  kai remove -s`);
  console.error(`  kai remove azure`);
  console.error(`  kai remove --name <account-id>`);
}

/** `kai remove -i <path|id> | -a <name> | -s [target] [--dry-run]` */
export async function runRemove(args: string[]): Promise<number> {
  // `kai remove --name <id>`: an account id or organization, for any integration.
  const nameAt = args.indexOf("--name");
  if (nameAt !== -1) return runRemoveByName(args[nameAt + 1] ?? "", args.slice(1));
  // `kai remove azure`: an integration name in the first position.
  if (args[1] && findProvider(args[1])) return runProviderRemove(args[1], args.slice(2));
  const opts = parseRemoveArgs(args);
  if (opts.indexTarget !== null) return removeProjectIndex(opts.indexTarget, opts.dryRun);
  if (opts.agentTarget !== null) return removeAgent(opts.agentTarget, opts.dryRun);
  if (opts.removeSessions) return removeSessions(opts.sessionTarget, opts.dryRun);
  printRemoveUsage();
  return 1;
}
