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
