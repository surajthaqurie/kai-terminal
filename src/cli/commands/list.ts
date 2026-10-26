import { loadProjectIndex, listRegisteredProjects } from "../../core/registry";
import { detectStaleIndexEntries } from "../../core/indexer";
import { detectInstalledAgentsSync } from "../../core/agents";
import { loadKaiConfig } from "../kaiConfig";
import { printMcpStatus } from "../help";
import { listSessionCacheFiles } from "../sessionFiles";

/** `kai list [-a|-m|-i|-s|-c]`: dynamic system detection + resources. */
export async function runList(args: string[]): Promise<number> {
  const showMcp =
    args.includes("-m") || args.includes("--mcp") || args[1] === "mcp" || args.includes("mcp");
  const showIndex = args.includes("-i") || args.includes("--index");
  const showSession = args.includes("-s") || args.includes("--session");
  const showConfig = args.includes("-c") || args.includes("--config");
  const showAgent =
    args.includes("-a") ||
    args.includes("--agent") ||
    (!showIndex && !showSession && !showConfig && !showMcp);

  if (showMcp) {
    printMcpStatus(process.cwd());
  }

  if (showAgent) {
    const detected = detectInstalledAgentsSync({ projectDir: process.cwd() });
    console.log(`[kai] AI Agent Detection (live system probe):`);
    for (const d of detected) {
      const icon = d.binaryFound ? "✓" : "✗";
      const state = d.binaryFound
        ? `Installed (${d.binaryPath})${d.configured ? ", configured" : ""}`
        : d.configured
          ? "Config found (binary not on PATH)"
          : "Not found";
      const wired = d.kaiWired ? "kai wired ✓" : "kai not wired";
      console.log(`  ${icon} ${d.id.padEnd(10)} ${d.name.padEnd(16)} ${state} · ${wired}`);
      if (!d.binaryFound) {
        console.log(`    └─ ${d.installGuidance} | config: ${d.configFile}`);
      }
    }
    console.log(
      `\nTip: Run 'kai <agent> [path]' to launch a tool with Kai connected (e.g. 'kai <agent> .').`
    );
  }

  if (showIndex) {
    const projects = listRegisteredProjects();
    console.log(`\n[kai] Indexed Projects (${projects.length}):`);
    if (projects.length === 0) {
      console.log(`  No indexed projects found.`);
      console.log(`  Tip: Run 'kai graph init [path]' or 'kai <agent> [path]' to index a project.`);
    } else {
      for (const proj of projects) {
        const idx = loadProjectIndex(proj.id);
        let freshness = "unindexed";
        if (idx) {
          const staleness = detectStaleIndexEntries(idx);
          freshness = staleness.isStale ? "stale" : "fresh";
        }
        console.log(`  • ${proj.name} (id: ${proj.id})`);
        console.log(`    Path:     ${proj.canonicalPath}`);
        console.log(
          `    Status:   ${proj.status} (${freshness}) | Files: ${proj.fileCount} | Symbols: ${proj.symbolCount}`
        );
        console.log(`    Indexed:  ${proj.lastIndexedAt || "never"}`);
      }
    }
  }

  if (showSession) {
    const { sessionsDir, cacheDir, sessionFiles, cacheFiles } = listSessionCacheFiles();
    console.log(
      `
[kai] Managed Sessions & Cache (${sessionFiles.length + cacheFiles.length} files):`
    );
    console.log(`  Sessions (${sessionFiles.length} in ${sessionsDir}):`);
    if (sessionFiles.length === 0) {
      console.log(`    (none)`);
    } else {
      for (const f of sessionFiles) console.log(`    - ${f}`);
    }
    console.log(`  Cache (${cacheFiles.length} in ${cacheDir}):`);
    if (cacheFiles.length === 0) {
      console.log(`    (none)`);
    } else {
      for (const f of cacheFiles) console.log(`    - ${f}`);
    }
  }

  if (showConfig) {
    console.log(`
[kai] Current Configuration:`);
    console.log(JSON.stringify(loadKaiConfig(), null, 2));
  }

  return 0;
}
