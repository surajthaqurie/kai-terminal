import path from "path";
import fs from "fs";
import { atomicWriteJson, ensureKaiDirectories, getKaiHomeDir } from "../core/registry";
import { buildCodeModeSignal } from "../core/codeModeSignal";

/**
 * Tell the terminal this process runs in that its Code Mode started
 * (`projectPath`) or ended (`null`). The desktop app scopes the footer pill to
 * that one pane; anywhere else (plain shells, pipes, CI) nothing is written.
 */
export function announceCodeMode(projectPath: string | null): void {
  if (process.env.KAI_TERMINAL !== "1" || !process.stdout.isTTY) return;
  try {
    process.stdout.write(buildCodeModeSignal(projectPath));
  } catch {
    // Best-effort: a closed stdout must never fail the agent run.
  }
}

/**
 * Persist active project info and sync SQLite localStorage for WebKitGTK/Tauri
 * so that when Kai opens (or gains focus), it automatically selects this project in Code Mode.
 *
 * Written atomically: the desktop app polls this file, and a half-written one
 * would read as "no project". Returns false (after a warning line) when the
 * state could not be saved, so callers never report Code Mode as entered when
 * the app was not told.
 */
export function saveActiveProjectState(
  projectPath: string,
  projectName: string,
  projectId: string,
  mode: string = "code"
): boolean {
  try {
    ensureKaiDirectories();
    atomicWriteJson(path.join(getKaiHomeDir(), "active_project.json"), {
      id: projectId,
      name: projectName,
      path: projectPath,
      mode,
      timestamp: Date.now(),
    });
    return true;
  } catch (err: unknown) {
    console.error(
      `[kai] Warning: could not save Code Mode state (${err instanceof Error ? err.message : String(err)}); the desktop app will not switch to this project.`
    );
    return false;
  }
}

/**
 * Clear Code Mode: removes the persisted active project so the desktop app
 * falls back to plain terminal mode. Never touches the project index data
 * (use `unregister` for that) or the repository itself.
 *
 * With `onlyIfPath`, the state is cleared only while it still points at that
 * project, so a finishing agent run never wipes Code Mode that another
 * `kai code <other>` started in the meantime.
 *
 * Returns false when the state file exists but could not be removed; absent
 * state, or state that belongs to another project, counts as success.
 */
export function clearActiveProjectState(onlyIfPath?: string): boolean {
  try {
    ensureKaiDirectories();
    const activeFile = path.join(getKaiHomeDir(), "active_project.json");
    if (!fs.existsSync(activeFile)) return true;
    if (onlyIfPath !== undefined) {
      const current = JSON.parse(fs.readFileSync(activeFile, "utf-8")) as { path?: unknown };
      if (current.path !== onlyIfPath) return true;
    }
    fs.unlinkSync(activeFile);
    return true;
  } catch {
    return false;
  }
}
