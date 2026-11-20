import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getProjectMetaPath,
  listRegisteredProjects,
  pruneProjectRegistrations,
  registerProject,
  resolveCanonicalPath,
  resolveProjectRoot,
} from "../core/registry";

describe("one project graph per location", () => {
  let tmp: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    tmp = resolveCanonicalPath(fs.mkdtempSync(path.join(os.tmpdir(), "kai-unique-")));
    prevHome = process.env.KAI_HOME;
    process.env.KAI_HOME = path.join(tmp, "kai-home");
  });

  afterEach(() => {
    process.env.KAI_HOME = prevHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const mkRepo = (rel: string): string => {
    const dir = path.join(tmp, rel);
    fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
    return dir;
  };

  it("resolves a subfolder of a git repo to the repo root", () => {
    const repo = mkRepo("repo");
    const sub = path.join(repo, "src", "deep");
    fs.mkdirSync(sub, { recursive: true });
    expect(resolveProjectRoot(sub)).toBe(resolveCanonicalPath(repo));
    expect(resolveProjectRoot(repo)).toBe(resolveCanonicalPath(repo));
  });

  it("keeps a folder outside any repo as its own project", () => {
    const plain = path.join(tmp, "plain", "child");
    fs.mkdirSync(plain, { recursive: true });
    expect(resolveProjectRoot(plain)).toBe(resolveCanonicalPath(plain));
  });

  it("a nested repo is its own project", () => {
    mkRepo("outer");
    const inner = mkRepo(path.join("outer", "inner"));
    expect(resolveProjectRoot(path.join(inner))).toBe(resolveCanonicalPath(inner));
  });

  it("registering the repo removes the old graph of its own subfolder", () => {
    const repo = mkRepo("repo");
    const sub = path.join(repo, "src");
    fs.mkdirSync(sub);
    const old = registerProject(sub); // the old behaviour: a second, nested graph
    const nestedRepo = mkRepo(path.join("repo", "vendor-lib"));
    const nested = registerProject(nestedRepo);

    const meta = registerProject(resolveProjectRoot(sub));

    expect(meta.canonicalPath).toBe(resolveCanonicalPath(repo));
    expect(fs.existsSync(getProjectMetaPath(old.id))).toBe(false);
    // A nested repo of its own keeps its graph.
    expect(fs.existsSync(getProjectMetaPath(nested.id))).toBe(true);
    expect(
      listRegisteredProjects()
        .map((p) => p.id)
        .sort()
    ).toEqual([meta.id, nested.id].sort());
  });

  it("re-registering the same location reuses one graph", () => {
    const repo = mkRepo("repo");
    const a = registerProject(resolveProjectRoot(repo));
    const b = registerProject(resolveProjectRoot(path.join(repo, ".")));
    expect(b.id).toBe(a.id);
    expect(listRegisteredProjects()).toHaveLength(1);
  });

  it("prune removes graphs whose folder is gone and corrupt metadata", () => {
    const live = mkRepo("live");
    const gone = mkRepo("gone");
    const liveMeta = registerProject(live);
    const goneMeta = registerProject(gone);
    const corrupt = registerProject(mkRepo("corrupt"));
    fs.writeFileSync(getProjectMetaPath(corrupt.id), JSON.stringify({ id: 12345 }));
    fs.rmSync(gone, { recursive: true, force: true });

    const { removed } = pruneProjectRegistrations();

    expect(removed).toContain(goneMeta.canonicalPath);
    expect(fs.existsSync(getProjectMetaPath(goneMeta.id))).toBe(false);
    expect(fs.existsSync(getProjectMetaPath(corrupt.id))).toBe(false);
    expect(fs.existsSync(getProjectMetaPath(liveMeta.id))).toBe(true);
  });

  it("prune removes an old subfolder graph once its repo has a graph", () => {
    const repo = mkRepo("repo");
    const sub = path.join(repo, ".changeset");
    fs.mkdirSync(sub);
    const repoMeta = registerProject(repo);
    const subMeta = registerProject(sub); // registered after the repo: not auto-removed
    expect(fs.existsSync(getProjectMetaPath(subMeta.id))).toBe(true);

    const { removed } = pruneProjectRegistrations();

    expect(removed).toEqual([subMeta.canonicalPath]);
    expect(fs.existsSync(getProjectMetaPath(repoMeta.id))).toBe(true);
  });
});
