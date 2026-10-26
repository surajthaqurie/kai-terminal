import fs from "fs";
import { getSessionsDir } from "../../core/registry";
import { clearSessionCacheFiles, listSessionCacheFiles } from "../sessionFiles";

/** Hidden compat: `kai session [list]` (prefer `kai list -s`). */
export async function runSessionList(): Promise<number> {
  const sessionsDir = getSessionsDir();
  if (!fs.existsSync(sessionsDir)) {
    console.log(`[kai] No active session files found.`);
    return 0;
  }

  const files = fs.readdirSync(sessionsDir);
  console.log(`[kai] Managed Sessions (${files.length}):`);
  for (const f of files) {
    console.log(`  - ${f}`);
  }
  return 0;
}

/** Hidden compat: `kai session clean` == `kai remove -s`. Prefer `kai remove -s`. */
export async function runSessionClean(args: string[]): Promise<number> {
  const isDryRun = args.includes("--dry-run");
  const { sessionsDir, cacheDir, sessionFiles, cacheFiles } = listSessionCacheFiles();

  console.log(`[kai] Session Clean Operation Scope:`);
  console.log(`  Session files to remove: ${sessionFiles.length} (in ${sessionsDir})`);
  console.log(`  Cache files to remove:   ${cacheFiles.length} (in ${cacheDir})`);
  console.log(`  NOTE: Project index databases in ~/.kai/projects/ are NOT touched.`);

  if (isDryRun) {
    console.log(`[kai] Dry-run complete. No files were deleted.`);
    return 0;
  }

  clearSessionCacheFiles();
  console.log(`[kai] Session and cache directories cleanly cleared.`);
  return 0;
}
