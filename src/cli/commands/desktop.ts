import fs from "fs";
import { registerProject, resolveCanonicalPath } from "../../core/registry";
import { saveActiveProjectState } from "../activeProject";
import { closeKaiApp, findKaiAppBinary, launchKaiApp } from "../desktopApp";

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
  const stateSaved = saveActiveProjectState(meta.canonicalPath, meta.name, meta.id, "code");

  const appBinary = findKaiAppBinary();
  if (!appBinary) {
    console.error(`[kai] Error: Kai Terminal desktop application binary not found.`);
    console.error(`Please install the Kai Terminal desktop app or verify it is on PATH.`);
    return 1;
  }

  const launched = await launchKaiApp(appBinary, meta.canonicalPath);
  if (launched) {
    // The app learns about Code Mode only from the state file saved above.
    console.log(
      `[kai] Opened Kai Terminal for "${meta.name}" (${meta.canonicalPath})${stateSaved ? "" : " without Code Mode (its state could not be saved)"}`
    );
    return 0;
  } else {
    console.error(`[kai] Error: Failed to launch Kai Terminal app at ${appBinary}`);
    return 1;
  }
}

export async function runClose(): Promise<number> {
  const results = closeKaiApp();
  const closed = results.filter((r) => r.outcome === "closed");
  const failed = results.filter((r) => r.outcome === "failed");
  if (closed.length > 0) {
    const what = closed.map((r) => (r.count && r.count > 1 ? `${r.name} x${r.count}` : r.name));
    console.log(`[kai] Closed Kai Terminal (${what.join(", ")}).`);
  } else if (failed.length === 0) {
    console.log(`[kai] No running Kai Terminal instance found.`);
  }
  for (const r of failed) {
    console.error(`[kai] Error: could not close ${r.name}: ${r.detail}`);
  }
  return failed.length > 0 ? 1 : 0;
}
