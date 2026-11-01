import path from "path";
import fs from "fs";
import { getSessionsDir, getCacheDir } from "../core/registry";

export interface SessionCacheListing {
  sessionsDir: string;
  cacheDir: string;
  sessionFiles: string[];
  cacheFiles: string[];
}

/** Files under the managed `sessions/` and `cache/` dirs (empty when a dir does not exist yet). */
export function listSessionCacheFiles(): SessionCacheListing {
  const sessionsDir = getSessionsDir();
  const cacheDir = getCacheDir();
  return {
    sessionsDir,
    cacheDir,
    sessionFiles: fs.existsSync(sessionsDir) ? fs.readdirSync(sessionsDir) : [],
    cacheFiles: fs.existsSync(cacheDir) ? fs.readdirSync(cacheDir) : [],
  };
}

/**
 * The names that belong to project `projectId`: the id itself, or the id
 * followed by `.` or `-` (`<id>.json`, `<id>-layout`). A name that merely
 * contains the id, or a project name such as `app`, never matches: removing one
 * project's files must not take another's (or an unrelated file's) with them.
 */
export function filesOfProject(names: string[], projectId: string): string[] {
  return names.filter(
    (name) =>
      name === projectId || name.startsWith(`${projectId}.`) || name.startsWith(`${projectId}-`)
  );
}

/** Deletes the named regular files in `dir`; symlinks, directories and unreadable entries are skipped. */
export function removeFiles(dir: string, names: string[]): void {
  for (const name of names) {
    try {
      const file = path.join(dir, name);
      if (fs.lstatSync(file).isFile()) fs.unlinkSync(file);
    } catch {
      // ignore
    }
  }
}

/** Shared session/cache cleanup used by `kai remove -s` and `kai session clean` (hidden compat). */
export function clearSessionCacheFiles(): { sessions: number; cache: number } {
  const { sessionsDir, cacheDir, sessionFiles, cacheFiles } = listSessionCacheFiles();
  removeFiles(sessionsDir, sessionFiles);
  removeFiles(cacheDir, cacheFiles);
  return { sessions: sessionFiles.length, cache: cacheFiles.length };
}
