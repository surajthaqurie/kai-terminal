import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../cli/index";
import { filesOfProject } from "../cli/sessionFiles";
import {
  getKaiHomeDir,
  getProjectMeta,
  getProjectStorageDir,
  registerProject,
} from "../core/registry";

let kaiHome: string;
let savedKaiHome: string | undefined;
let logs: string[];
let errors: string[];

beforeEach(() => {
  savedKaiHome = process.env.KAI_HOME;
  kaiHome = fs.mkdtempSync(path.join(os.tmpdir(), "kai-remove-home-"));
  process.env.KAI_HOME = kaiHome;
  logs = [];
  errors = [];
  vi.spyOn(console, "log").mockImplementation((...a) => void logs.push(a.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...a) => void errors.push(a.join(" ")));
});

afterEach(() => {
  vi.restoreAllMocks();
  if (savedKaiHome === undefined) delete process.env.KAI_HOME;
  else process.env.KAI_HOME = savedKaiHome;
  fs.rmSync(kaiHome, { recursive: true, force: true });
});

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

/** A project folder with the given basename, registered with Kai. */
function project(name: string): { dir: string; id: string } {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "kai-remove-proj-"));
  tempDirs.push(parent);
  const dir = path.join(parent, name);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "a.ts"), "export function a() {}\n");
  return { dir, id: registerProject(dir).id };
}

const sessionsDir = () => path.join(kaiHome, "sessions");
const cacheDir = () => path.join(kaiHome, "cache");

function put(dir: string, ...names: string[]): void {
  fs.mkdirSync(dir, { recursive: true });
  for (const name of names) fs.writeFileSync(path.join(dir, name), "x");
}

const listing = (dir: string) => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []);

describe("filesOfProject", () => {
  const id = "0123456789abcdef";

  it("matches the id and id-prefixed names, nothing that merely contains them", () => {
    const names = [
      id,
      `${id}.json`,
      `${id}-layout.json`,
      `other-${id}.json`,
      `${id}x.json`,
      `${id.slice(0, 15)}.json`,
      "app.json",
      "notes.txt",
    ];
    expect(filesOfProject(names, id)).toEqual([id, `${id}.json`, `${id}-layout.json`]);
  });
});

describe("kai remove -s <target>", () => {
  it("removes only the files that belong to the project, not ones that share its name", async () => {
    const app = project("app");
    const other = project("application");
    put(
      sessionsDir(),
      `${app.id}.json`,
      `${app.id}-layout.json`,
      `${other.id}.json`,
      "app-notes.txt",
      "app.json",
      `backup-${app.id}.bak`,
      "unrelated.json"
    );
    put(cacheDir(), `${app.id}.cache`, "app.cache", `${other.id}.cache`);

    expect(await runCli(["node", "kai", "remove", "-s", app.dir])).toBe(0);

    expect(listing(sessionsDir())).toEqual(
      [
        `${other.id}.json`,
        "app-notes.txt",
        "app.json",
        `backup-${app.id}.bak`,
        "unrelated.json",
      ].sort()
    );
    expect(listing(cacheDir())).toEqual([`${other.id}.cache`, "app.cache"].sort());
  });

  it("refuses a target that names no project, and deletes nothing", async () => {
    project("app");
    put(sessionsDir(), "a.json", "app.json", "src.json");
    put(cacheDir(), "a", "src");

    // A project name is not a target either: it is neither a path nor an id.
    for (const typo of ["a", "app", "no-such-project"]) {
      expect(await runCli(["node", "kai", "remove", "-s", typo])).toBe(1);
    }

    expect(errors.join("\n")).toContain("No registered project or existing folder matches");
    expect(listing(sessionsDir())).toEqual(["a.json", "app.json", "src.json"]);
    expect(listing(cacheDir())).toEqual(["a", "src"]);
  });

  it("accepts a project id, registered or not", async () => {
    const orphanId = "fedcba9876543210";
    put(sessionsDir(), `${orphanId}.json`, "keep.json");

    expect(await runCli(["node", "kai", "remove", "-s", orphanId])).toBe(0);

    expect(listing(sessionsDir())).toEqual(["keep.json"]);
  });

  it("a folder that is not registered still resolves through its derived id", async () => {
    const { dir, id } = project("app");
    fs.rmSync(getProjectStorageDir(id), { recursive: true, force: true });
    expect(getProjectMeta(dir)).toBeNull();
    put(sessionsDir(), `${id}.json`, "keep.json");

    expect(await runCli(["node", "kai", "remove", "-s", dir])).toBe(0);

    expect(listing(sessionsDir())).toEqual(["keep.json"]);
  });

  it("--dry-run reports and deletes nothing", async () => {
    const app = project("app");
    put(sessionsDir(), `${app.id}.json`);
    fs.writeFileSync(
      path.join(getKaiHomeDir(), "active_project.json"),
      JSON.stringify({ id: app.id, path: app.dir })
    );

    expect(await runCli(["node", "kai", "remove", "-s", app.dir, "--dry-run"])).toBe(0);

    expect(listing(sessionsDir())).toEqual([`${app.id}.json`]);
    expect(fs.existsSync(path.join(kaiHome, "active_project.json"))).toBe(true);
    expect(logs.join("\n")).toContain("will be cleared");
  });

  it("`all` still clears everything", async () => {
    const app = project("app");
    put(sessionsDir(), `${app.id}.json`, "free-form.json");
    put(cacheDir(), "anything");

    expect(await runCli(["node", "kai", "remove", "-s", "all"])).toBe(0);

    expect(listing(sessionsDir())).toEqual([]);
    expect(listing(cacheDir())).toEqual([]);
  });
});

describe("kai remove -s and the active project", () => {
  const activeFile = () => path.join(kaiHome, "active_project.json");
  const setActive = (p: { id: string; dir: string }) =>
    fs.writeFileSync(activeFile(), JSON.stringify({ id: p.id, path: p.dir, name: "x" }));

  it("clears the active state when it is the project being removed", async () => {
    const app = project("app");
    setActive(app);

    expect(await runCli(["node", "kai", "remove", "-s", app.dir])).toBe(0);

    expect(fs.existsSync(activeFile())).toBe(false);
  });

  it("keeps another project's active state, also for `-s .`", async () => {
    const app = project("app");
    const other = project("other");
    setActive(other);

    expect(await runCli(["node", "kai", "remove", "-s", app.dir])).toBe(0);
    expect(fs.existsSync(activeFile())).toBe(true);

    vi.spyOn(process, "cwd").mockReturnValue(app.dir);
    expect(await runCli(["node", "kai", "remove", "-s", "."])).toBe(0);
    expect(fs.existsSync(activeFile())).toBe(true);
    expect(JSON.parse(fs.readFileSync(activeFile(), "utf-8")).id).toBe(other.id);
  });

  it("matches the active path case-insensitively where the filesystem is", async () => {
    if (process.platform !== "win32" && process.platform !== "darwin") return;
    const app = project("app");
    fs.writeFileSync(activeFile(), JSON.stringify({ path: app.dir.toUpperCase() }));

    expect(await runCli(["node", "kai", "remove", "-s", app.dir])).toBe(0);

    expect(fs.existsSync(activeFile())).toBe(false);
  });

  it("`-s .` clears the active state when cwd is the active project", async () => {
    const app = project("app");
    setActive(app);
    vi.spyOn(process, "cwd").mockReturnValue(app.dir);

    expect(await runCli(["node", "kai", "remove", "-s", "."])).toBe(0);

    expect(fs.existsSync(activeFile())).toBe(false);
  });
});

describe("kai remove -i keeps what is not index data", () => {
  it("leaves the integration binding in place and says so", async () => {
    const { dir, id } = project("app");
    expect(await runCli(["node", "kai", "graph", "init", dir])).toBe(0);
    const binding = path.join(getProjectStorageDir(id), "integration.json");
    fs.writeFileSync(binding, JSON.stringify({ provider: "azure-devops" }));

    expect(await runCli(["node", "kai", "remove", "-i", dir, "--dry-run"])).toBe(0);
    expect(logs.join("\n")).toContain("integration connection is kept");
    expect(fs.existsSync(path.join(getProjectStorageDir(id), "index.json"))).toBe(true);

    expect(await runCli(["node", "kai", "remove", "-i", dir])).toBe(0);

    expect(fs.existsSync(binding)).toBe(true);
    expect(fs.existsSync(path.join(getProjectStorageDir(id), "index.json"))).toBe(false);
    expect(fs.existsSync(path.join(getProjectStorageDir(id), "meta.json"))).toBe(false);
    expect(fs.existsSync(path.join(getProjectStorageDir(id), ".lock"))).toBe(false);
    expect(getProjectMeta(dir)).toBeNull();
  });

  it("removes the whole storage directory when nothing else lives there", async () => {
    const { dir, id } = project("app");
    expect(await runCli(["node", "kai", "graph", "init", dir])).toBe(0);

    expect(await runCli(["node", "kai", "remove", "-i", dir])).toBe(0);

    expect(fs.existsSync(getProjectStorageDir(id))).toBe(false);
  });
});
