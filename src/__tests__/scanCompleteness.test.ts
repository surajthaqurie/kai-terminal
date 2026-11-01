import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../cli/index";
import { indexProject } from "../core/indexer";
import { registerProject } from "../core/registry";

let kaiHome: string;
let project: string;
let savedKaiHome: string | undefined;
let logs: string[];
let warnings: string[];

beforeEach(() => {
  savedKaiHome = process.env.KAI_HOME;
  kaiHome = fs.mkdtempSync(path.join(os.tmpdir(), "kai-scan-home-"));
  project = fs.mkdtempSync(path.join(os.tmpdir(), "kai-scan-proj-"));
  fs.writeFileSync(path.join(project, "a.ts"), "export function a() {}\n");
  process.env.KAI_HOME = kaiHome;
  logs = [];
  warnings = [];
  vi.spyOn(console, "log").mockImplementation((...a) => void logs.push(a.join(" ")));
  vi.spyOn(console, "warn").mockImplementation((...a) => void warnings.push(a.join(" ")));
});

afterEach(() => {
  vi.restoreAllMocks();
  if (savedKaiHome === undefined) delete process.env.KAI_HOME;
  else process.env.KAI_HOME = savedKaiHome;
  fs.rmSync(kaiHome, { recursive: true, force: true });
  fs.rmSync(project, { recursive: true, force: true });
});

/**
 * Make the project root contain a link named `ghost-link` whose target cannot
 * be resolved with `code`. Real links are not creatable on every machine (and a
 * Windows junction that realpath rejects cannot be staged at all), so the
 * directory listing and `realpath` are faked for that one entry.
 */
function addUnresolvableLink(root: string, code: string): void {
  const realReaddir = fs.readdirSync;
  const realRealpath = fs.realpathSync;
  vi.spyOn(fs, "readdirSync").mockImplementation(((dir: fs.PathLike, options?: unknown) => {
    const entries = (realReaddir as (...args: unknown[]) => unknown[])(dir, options);
    const withTypes = (options as { withFileTypes?: boolean } | undefined)?.withFileTypes;
    if (!withTypes || path.resolve(String(dir)) !== path.resolve(root)) return entries;
    const ghost = {
      name: "ghost-link",
      isSymbolicLink: () => true,
      isDirectory: () => false,
      isFile: () => false,
    };
    return [...entries, ghost];
  }) as typeof fs.readdirSync);
  const fakeRealpath = ((target: fs.PathLike, ...rest: unknown[]) => {
    if (String(target).endsWith("ghost-link")) {
      throw Object.assign(new Error(`${code}: cannot resolve`), { code });
    }
    return (realRealpath as (...args: unknown[]) => string)(target, ...rest);
  }) as typeof fs.realpathSync;
  vi.spyOn(fs, "realpathSync").mockImplementation(fakeRealpath);
}

describe("indexer scan summary for links it cannot resolve", () => {
  it.each(["EACCES", "EPERM", "ELOOP", "UNKNOWN"])(
    "counts a link failing with %s, so the scan is not reported complete",
    async (code) => {
      const meta = registerProject(project);
      addUnresolvableLink(meta.canonicalPath, code);

      const index = await indexProject(meta, { forceRebuild: true });

      expect(index.scan?.complete).toBe(false);
      expect(index.scan?.unreadableDirs).toBe(1);
      expect(Object.keys(index.files)).toContain("a.ts");
    }
  );

  it("does not count a dangling link (ENOENT): there is nothing behind it", async () => {
    const meta = registerProject(project);
    addUnresolvableLink(meta.canonicalPath, "ENOENT");

    const index = await indexProject(meta, { forceRebuild: true });

    expect(index.scan?.complete).toBe(true);
    expect(index.scan?.unreadableDirs).toBe(0);
  });
});

describe("kai graph init/update say when the scan was partial", () => {
  it("init and update print a warning naming what was skipped", async () => {
    const meta = registerProject(project);
    addUnresolvableLink(meta.canonicalPath, "EACCES");

    expect(await runCli(["node", "kai", "graph", "init", project])).toBe(0);
    expect(warnings.join("\n")).toContain("the scan was incomplete");
    expect(warnings.join("\n")).toContain("1 unreadable folder(s) or link(s) skipped");

    warnings.length = 0;
    expect(await runCli(["node", "kai", "graph", "update", project])).toBe(0);
    expect(warnings.join("\n")).toContain("the scan was incomplete");
  });

  it("also reports the file cap", async () => {
    for (let i = 0; i < 120; i++) fs.writeFileSync(path.join(project, `f${i}.ts`), "");
    process.env.KAI_MAX_INDEX_FILES = "100"; // the lowest cap the variable allows
    try {
      expect(await runCli(["node", "kai", "graph", "init", project])).toBe(0);
    } finally {
      delete process.env.KAI_MAX_INDEX_FILES;
    }
    expect(warnings.join("\n")).toContain("file limit of 100 reached");
  });

  it("prints nothing extra for a complete scan", async () => {
    expect(await runCli(["node", "kai", "graph", "init", project])).toBe(0);
    expect(await runCli(["node", "kai", "graph", "update", project])).toBe(0);
    expect(warnings).toEqual([]);
  });
});
