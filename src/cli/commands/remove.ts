import path from "path";
import fs from "fs";
import {
  computeProjectId,
  getProjectMeta,
  deleteProjectData,
  getProjectStorageDir,
  getKaiHomeDir,
  normalizePathForIdentity,
  resolveCanonicalPath,
} from "../../core/registry";
import { clearActiveProjectState } from "../activeProject";
import { removeAgentWiring } from "../agentWorkflow";
import { filesOfProject, listSessionCacheFiles, removeFiles } from "../sessionFiles";
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

  const storageDir = getProjectStorageDir(meta.id);
  const keepsConnection = fs.existsSync(path.join(storageDir, "integration.json"));
  console.log(`[kai] Remove Project Index Scope:`);
  console.log(`  Project:           "${meta.name}" (id: ${meta.id})`);
  console.log(`  Index data:        ${storageDir}`);
  console.log(`  NOTE: Only the index files under ~/.kai/projects/ are removed.`);
  if (keepsConnection) {
    console.log(
      `  NOTE: This folder's integration connection is kept (use 'kai remove azure' to disconnect it).`
    );
  }
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
function removeAgent(
  target: string,
  dryRun: boolean,
  scope: "auto" | "project" | "global" = "auto"
): number {
  if (!target) {
    console.error(
      `[kai] Error: Please specify an agent name to remove with -m/--mcp (or -a/--agent).`
    );
    console.error(`Example: kai remove -m <name>`);
    return 1;
  }
  return removeAgentWiring(target, { dryRun, scope });
}

/** The project a `-s <target>` names: `id` selects its files, `canonicalPath` (when known) its active-state entry. */
interface SessionProject {
  id: string;
  name: string;
  canonicalPath: string | null;
}

/**
 * Resolves `-s <target>` (`.`, a path, or a 16-hex project id) to a project, or
 * null when it names nothing. A registered project, an existing folder (its id is
 * derived from the path, so files left after the index was removed still match)
 * and a bare id qualify; a typo does not.
 */
function resolveSessionProject(target: string): SessionProject | null {
  const candidatePath = target === "." ? process.cwd() : target;
  const canonicalPath = resolveCanonicalPath(candidatePath);
  const meta =
    getProjectMeta(candidatePath) ||
    getProjectMeta(canonicalPath) ||
    (/^[0-9a-f]{16}$/.test(target) ? getProjectMeta(target) : null);
  if (meta) return { id: meta.id, name: meta.name, canonicalPath };
  if (/^[0-9a-f]{16}$/.test(target)) return { id: target, name: target, canonicalPath: null };
  try {
    if (fs.statSync(canonicalPath).isDirectory()) {
      return {
        id: computeProjectId(canonicalPath),
        name: path.basename(canonicalPath) || canonicalPath,
        canonicalPath,
      };
    }
  } catch {
    // not a path that exists
  }
  return null;
}

/** True when `active_project.json` currently points at `project`. */
function activeStateBelongsTo(project: SessionProject): boolean {
  try {
    const active = JSON.parse(
      fs.readFileSync(path.join(getKaiHomeDir(), "active_project.json"), "utf-8")
    ) as { id?: unknown; path?: unknown };
    if (active.id === project.id) return true;
    return (
      project.canonicalPath !== null &&
      typeof active.path === "string" &&
      normalizePathForIdentity(active.path) === normalizePathForIdentity(project.canonicalPath)
    );
  } catch {
    return false; // absent or unreadable: nothing of ours to clear
  }
}

/** 3. Remove session and cache files, for every project or one project. */
function removeSessions(sessionTarget: string | null, dryRun: boolean): number {
  const { sessionsDir, cacheDir, sessionFiles, cacheFiles } = listSessionCacheFiles();

  let targetSessionFiles = sessionFiles;
  let targetCacheFiles = cacheFiles;
  let targetScopeDesc = "all projects";
  let activeMatched = false;

  if (sessionTarget && sessionTarget !== "all") {
    const project = resolveSessionProject(sessionTarget);
    if (!project) {
      console.error(`[kai] No registered project or existing folder matches "${sessionTarget}".`);
      console.error(`  Nothing was removed. Use a project path, a project id, '.', or 'all'.`);
      return 1;
    }
    targetScopeDesc = project.canonicalPath
      ? `project "${project.name}" (${project.canonicalPath})`
      : `project id ${project.id}`;
    targetSessionFiles = filesOfProject(sessionFiles, project.id);
    targetCacheFiles = filesOfProject(cacheFiles, project.id);
    // The active project is cleared only when it is the one being removed.
    activeMatched = activeStateBelongsTo(project);
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
  if (activeMatched && !clearActiveProjectState()) {
    console.error(`[kai] Warning: could not clear the active project state.`);
    return 1;
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
  const scope = args.includes("--project")
    ? ("project" as const)
    : args.includes("--global")
      ? ("global" as const)
      : ("auto" as const);
  if (opts.indexTarget !== null) return removeProjectIndex(opts.indexTarget, opts.dryRun);
  if (opts.agentTarget !== null) return removeAgent(opts.agentTarget, opts.dryRun, scope);
  if (opts.removeSessions) return removeSessions(opts.sessionTarget, opts.dryRun);
  printRemoveUsage();
  return 1;
}
