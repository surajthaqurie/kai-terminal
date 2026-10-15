import fs from "fs";
import path from "path";
import { DEFAULT_EXCLUDED_DIRS } from "./indexer";
import { ensureFreshIndex } from "./codeModeWorkflow";
import { loadProjectIndex, registerProject } from "./registry";

/**
 * Opt-in graph freshness watcher for pure-MCP clients (`kai mcp --watch` or
 * `KAI_MCP_WATCH=1`).
 *
 * A pure-MCP client that edits files without ever calling a graph-dependent
 * read or `kai_sync_graph` leaves the graph stale by design. This watcher
 * closes that gap on demand: filesystem events (excluded/dot directories
 * filtered out) mark the project dirty, and a trailing-edge debounce runs
 * exactly one `ensureFreshIndex` pass (the same bounded, lock-guarded,
 * identity-checked refresh the read tools use). Refreshes never overlap; a
 * change that lands mid-refresh schedules one follow-up pass.
 *
 * Off by default: no background activity unless explicitly requested. It is
 * best effort and never throws — if the platform cannot watch the tree (for
 * example the Linux inotify watch limit) it reports once on stderr and the
 * read-tool gate keeps working exactly as before.
 */

export const DEFAULT_WATCH_DEBOUNCE_MS = 1500;

export interface GraphWatcherOptions {
  debounceMs?: number;
  /** Called after each completed refresh pass (also used by tests). */
  onRefresh?: (outcome: string) => void;
  log?: (message: string) => void;
}

export interface GraphWatcher {
  close(): void;
}

/** True when a changed path (relative to the project root) can affect the graph. */
export function isWatchRelevantPath(relPath: string): boolean {
  if (!relPath) return true; // unknown path: be conservative, let the refresh decide
  const parts = relPath.split(/[\\/]+/).filter(Boolean);
  if (parts.length === 0) return true;
  return !parts.some(
    (p, i) => DEFAULT_EXCLUDED_DIRS.has(p) || (i < parts.length - 1 && p.startsWith("."))
  );
}

export function startGraphWatcher(
  projectRoot: string,
  options: GraphWatcherOptions = {}
): GraphWatcher {
  const debounceMs = options.debounceMs ?? DEFAULT_WATCH_DEBOUNCE_MS;
  const log = options.log ?? ((m: string) => process.stderr.write(`[kai-mcp] ${m}\n`));
  let timer: NodeJS.Timeout | null = null;
  let running = false;
  let dirtyDuringRun = false;
  let closed = false;
  let watcher: fs.FSWatcher | null = null;

  const refresh = async (): Promise<void> => {
    if (closed) return;
    if (running) {
      dirtyDuringRun = true;
      return;
    }
    running = true;
    let outcome = "refresh-failed";
    try {
      const meta = registerProject(projectRoot);
      const ensured = await ensureFreshIndex(meta, loadProjectIndex(meta.id));
      outcome = ensured.refreshOutcome;
    } catch {
      // Best effort: the read-tool gate still reconciles on the next call.
    } finally {
      running = false;
    }
    options.onRefresh?.(outcome);
    if (dirtyDuringRun && !closed) {
      dirtyDuringRun = false;
      schedule();
    }
  };

  const schedule = (): void => {
    if (closed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void refresh();
    }, debounceMs);
    timer.unref?.();
  };

  try {
    watcher = fs.watch(projectRoot, { recursive: true, persistent: false }, (_event, filename) => {
      const rel = filename ? String(filename) : "";
      if (isWatchRelevantPath(path.normalize(rel))) schedule();
    });
    watcher.on("error", (err) => {
      log(
        `graph watcher stopped (${err.message}); graph freshness falls back to read-time gating.`
      );
      watcher?.close();
      watcher = null;
    });
  } catch (err) {
    log(
      `graph watcher unavailable (${err instanceof Error ? err.message : String(err)}); graph freshness falls back to read-time gating.`
    );
  }

  return {
    close(): void {
      closed = true;
      if (timer) clearTimeout(timer);
      timer = null;
      watcher?.close();
      watcher = null;
    },
  };
}
