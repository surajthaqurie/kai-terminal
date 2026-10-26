import path from "path";
import fs from "fs";
import { ensureKaiDirectories, getKaiHomeDir } from "../core/registry";

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
}
