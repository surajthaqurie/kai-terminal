import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { indexProject } from "../core/indexer";
import { getGraphFreshness } from "../core/codeModeWorkflow";
import { registerProject, loadProjectIndex } from "../core/registry";
import { isWatchRelevantPath, startGraphWatcher } from "../core/graphWatcher";

let savedKaiHome: string | undefined;
let isolatedKaiHome: string;
let projectDir: string;

beforeEach(() => {
  savedKaiHome = process.env.KAI_HOME;
  isolatedKaiHome = fs.mkdtempSync(path.join(os.tmpdir(), "kai-home-"));
  process.env.KAI_HOME = isolatedKaiHome;
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-watch-"));
  fs.mkdirSync(path.join(projectDir, "src"), { recursive: true });
  fs.writeFileSync(path.join(projectDir, "src", "a.ts"), "export const a = 1;\n");
});

afterEach(() => {
  if (savedKaiHome === undefined) delete process.env.KAI_HOME;
  else process.env.KAI_HOME = savedKaiHome;
  fs.rmSync(isolatedKaiHome, { recursive: true, force: true });
  fs.rmSync(projectDir, { recursive: true, force: true });
});

describe("isWatchRelevantPath", () => {
  it("ignores excluded and dot directories, keeps source paths", () => {
    expect(isWatchRelevantPath(path.join("node_modules", "x", "index.js"))).toBe(false);
    expect(isWatchRelevantPath(path.join("src", "dist", "out.js"))).toBe(false);
    expect(isWatchRelevantPath(path.join(".git", "HEAD"))).toBe(false);
    expect(isWatchRelevantPath(path.join("src", "a.ts"))).toBe(true);
    expect(isWatchRelevantPath(".gitignore")).toBe(true);
    expect(isWatchRelevantPath("")).toBe(true);
  });
});

describe("startGraphWatcher", () => {
  it("refreshes a stale graph after an external edit without any MCP read", async () => {
    const meta = registerProject(projectDir);
    await indexProject(meta);
    expect(getGraphFreshness(loadProjectIndex(meta.id))).toBe("fresh");

    const refreshed = new Promise<string>((resolve) => {
      const watcher = startGraphWatcher(projectDir, {
        debounceMs: 100,
        onRefresh: (outcome) => {
          watcher.close();
          resolve(outcome);
        },
        log: () => {},
      });
      // Edit after the watcher is armed (new file => untracked => stale).
      setTimeout(() => {
        fs.writeFileSync(path.join(projectDir, "src", "b.ts"), "export const b = 2;\n");
      }, 100);
    });

    expect(await refreshed).toBe("refreshed");
    const after = loadProjectIndex(meta.id);
    expect(after?.files["src/b.ts"]).toBeDefined();
    expect(getGraphFreshness(after)).toBe("fresh");
  }, 20000);

  it("does nothing for changes inside excluded directories and stops on close", async () => {
    const meta = registerProject(projectDir);
    await indexProject(meta);
    let refreshes = 0;
    const watcher = startGraphWatcher(projectDir, {
      debounceMs: 50,
      onRefresh: () => refreshes++,
      log: () => {},
    });
    fs.mkdirSync(path.join(projectDir, "node_modules", "pkg"), { recursive: true });
    fs.writeFileSync(path.join(projectDir, "node_modules", "pkg", "i.js"), "x");
    await new Promise((r) => setTimeout(r, 500));
    expect(refreshes).toBe(0);

    watcher.close();
    fs.writeFileSync(path.join(projectDir, "src", "c.ts"), "export const c = 3;\n");
    await new Promise((r) => setTimeout(r, 500));
    expect(refreshes).toBe(0);
  }, 20000);
});
