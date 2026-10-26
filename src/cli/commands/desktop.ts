import fs from "fs";
import { execSync } from "child_process";
import { registerProject, resolveCanonicalPath } from "../../core/registry";
import { saveActiveProjectState } from "../activeProject";
import { findKaiAppBinary, launchKaiApp } from "../desktopApp";

export async function runOpen(args: string[]): Promise<number> {
  const targetPath = args[1] || process.cwd();
  const canonicalPath = resolveCanonicalPath(targetPath);
  if (!fs.existsSync(canonicalPath)) {
    console.error(`[kai] Error: Directory "${targetPath}" does not exist.`);
    return 1;
  }
  const stat = fs.statSync(canonicalPath);
  if (!stat.isDirectory()) {
    console.error(`[kai] Error: Path "${targetPath}" is not a directory.`);
    return 1;
  }

  const meta = registerProject(canonicalPath);
  saveActiveProjectState(meta.canonicalPath, meta.name, meta.id, "code");

  const appBinary = findKaiAppBinary();
  if (!appBinary) {
    console.error(`[kai] Error: Kai Terminal desktop application binary not found.`);
    console.error(`Please install the Kai Terminal desktop app or verify it is on PATH.`);
    return 1;
  }

  const launched = launchKaiApp(appBinary, meta.canonicalPath);
  if (launched) {
    console.log(`[kai] Opened Kai Terminal for "${meta.name}" (${meta.canonicalPath})`);
    return 0;
  } else {
    console.error(`[kai] Error: Failed to launch Kai Terminal app at ${appBinary}`);
    return 1;
  }
}

export async function runClose(): Promise<number> {
  try {
    if (process.platform === "win32") {
      try {
        execSync("taskkill /F /IM kai.exe", { stdio: "ignore" });
      } catch {}
      try {
        execSync("taskkill /F /IM cross-platform-terminal-backend.exe", { stdio: "ignore" });
      } catch {}
    } else {
      try {
        execSync("pkill -x kai", { stdio: "ignore" });
      } catch {}
      try {
        execSync("pkill -x cross-platform-terminal-backend", { stdio: "ignore" });
      } catch {}
      try {
        execSync("pkill -x kai-terminal", { stdio: "ignore" });
      } catch {}
    }
    console.log(`[kai] Kai Terminal instances closed.`);
    return 0;
  } catch (err: unknown) {
    console.error(
      `[kai] Error closing Kai Terminal: ${err instanceof Error ? err.message : String(err)}`
    );
    return 1;
  }
}
