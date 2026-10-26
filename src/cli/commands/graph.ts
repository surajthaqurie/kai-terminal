import { registerProject, getProjectMeta } from "../../core/registry";
import { indexProject } from "../../core/indexer";
import { installCommitMsgHook } from "../../core/githooks";
import { saveActiveProjectState } from "../activeProject";

export async function runGraph(args: string[]): Promise<number> {
  const sub = args[1];
  if (sub === "init") {
    const targetPath = args[2] || process.cwd();
    const meta = registerProject(targetPath);
    saveActiveProjectState(meta.canonicalPath, meta.name, meta.id, "code");
    try {
      installCommitMsgHook(meta.canonicalPath);
    } catch {
      // ignore hook install errors
    }
    console.log(`[kai] Initializing graph for "${meta.name}"...`);
    const index = await indexProject(meta);
    console.log(`[kai] Index ready!`);
    console.log(`- Files indexed: ${Object.keys(index.files).length}`);
    console.log(`- Symbols indexed: ${Object.keys(index.symbolIndex).length}`);
    console.log(`- Project rules loaded: ${index.rules.length}`);
    if (index.changes) {
      const { added, modified, renamed, deleted } = index.changes;
      if (added.length || modified.length || renamed.length || deleted.length) {
        console.log(
          `- Incremental changes: +${added.length} added, ~${modified.length} modified, ->${renamed.length} renamed, -${deleted.length} deleted`
        );
      }
    }
    saveActiveProjectState(meta.canonicalPath, meta.name, meta.id, "code");
    return 0;
  }
  if (sub === "update" || sub === "rebuild") {
    const targetPath = args[2] || process.cwd();
    const meta = registerProject(targetPath);
    console.log(`[kai] Updating index for "${meta.name}"...`);
    const index = await indexProject(meta, { forceRebuild: true });
    console.log(
      `[kai] Update complete! Indexed ${Object.keys(index.files).length} files and ${Object.keys(index.symbolIndex).length} symbols.`
    );
    if (index.changes) {
      const { added, modified, renamed, deleted } = index.changes;
      if (added.length || modified.length || renamed.length || deleted.length) {
        console.log(
          `  Changes: +${added.length} added, ~${modified.length} modified, ->${renamed.length} renamed, -${deleted.length} deleted`
        );
      }
    }
    return 0;
  }
  if (!sub || sub === "status" || sub === "." || sub.startsWith("/") || sub.startsWith("~")) {
    const targetPath = (sub && sub !== "status" ? sub : args[2]) || process.cwd();
    const meta = getProjectMeta(targetPath);
    if (!meta) {
      console.log(`[kai] No project registered for: ${targetPath}`);
      console.log(`Run 'kai graph init ${targetPath}' to index.`);
      return 1;
    }
    console.log(`[kai] Graph Status for "${meta.name}":`);
    console.log(`  Files Indexed:   ${meta.fileCount}`);
    console.log(`  Symbols Indexed: ${meta.symbolCount}`);
    console.log(`  Last Indexed:    ${meta.lastIndexedAt || "never"}`);
    console.log(`Tip: Run 'kai graph update [path]' to force re-indexing.`);
    return 0;
  }

  console.error(`[kai] Error: Unknown graph subcommand "${sub || ""}".`);
  console.error(`Usage: kai graph <init|update|status> [path]`);
  return 1;
}
