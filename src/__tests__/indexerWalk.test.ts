import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { detectStaleIndexEntries, indexProject } from "../core/indexer";
import { registerProject } from "../core/registry";

describe("indexer directory walk (canonical paths without a realpath per entry)", () => {
  let home = "";
  let root = "";
  let outside = "";
  const prevHome = process.env.KAI_HOME;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "kai-walk-home-"));
    root = fs.mkdtempSync(path.join(os.tmpdir(), "kai-walk-proj-"));
    outside = fs.mkdtempSync(path.join(os.tmpdir(), "kai-walk-out-"));
    process.env.KAI_HOME = home;
  });
  afterEach(() => {
    process.env.KAI_HOME = prevHome;
    for (const dir of [home, root, outside]) {
      try {
        // A junction/link is removed without following it into its target.
        const link = path.join(root, "linked");
        if (dir === root && fs.existsSync(link)) fs.rmSync(link, { recursive: false, force: true });
      } catch {
        // ignore
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  const write = (base: string, rel: string, content: string) => {
    const full = path.join(base, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  };

  it("records the real path of every nested file", async () => {
    write(root, "a.ts", "export const a = 1;\n");
    write(root, "src/deep/er/b.ts", "export const b = 2;\n");
    const index = await indexProject(registerProject(root));
    expect(Object.keys(index.files).sort()).toEqual(["a.ts", "src/deep/er/b.ts"]);
    for (const [rel, file] of Object.entries(index.files)) {
      expect(file.canonicalPath, rel).toBe(fs.realpathSync(path.join(root, rel)));
    }
  });

  it("still refuses a directory link that leads outside the project", async () => {
    write(root, "inside.ts", "export const inside = 1;\n");
    write(outside, "secret.ts", "export const secret = 1;\n");
    try {
      // 'junction' works without elevation on Windows and is ignored on POSIX.
      fs.symlinkSync(outside, path.join(root, "linked"), "junction");
    } catch {
      return; // links cannot be created on this machine
    }
    const index = await indexProject(registerProject(root));
    expect(Object.keys(index.files)).toEqual(["inside.ts"]);
  });

  it("follows a directory link that stays inside the project", async () => {
    write(root, "real/mod.ts", "export const mod = 1;\n");
    try {
      fs.symlinkSync(path.join(root, "real"), path.join(root, "linked"), "junction");
    } catch {
      return;
    }
    const index = await indexProject(registerProject(root));
    // The real directory and its in-project link are the same place: indexed once.
    const paths = Object.keys(index.files).filter((p) => p.endsWith("mod.ts"));
    expect(paths).toHaveLength(1);
  });

  it("does not read as stale when a link reaches a directory the walk meets first", async () => {
    // `a/x` links to `b`. The indexer walks `a` before `b` and indexes the files
    // through the link; the freshness walk used to meet the real `b` first and
    // report `b/f.ts` as a new file until the next rebuild.
    write(root, "b/f.ts", "export const f = 1;\n");
    fs.mkdirSync(path.join(root, "a"), { recursive: true });
    try {
      fs.symlinkSync(path.join(root, "b"), path.join(root, "a", "x"), "junction");
    } catch {
      return; // links cannot be created on this machine
    }
    const index = await indexProject(registerProject(root));
    expect(Object.keys(index.files).filter((p) => p.endsWith("f.ts"))).toHaveLength(1);
    const drift = detectStaleIndexEntries(index);
    expect(drift.isStale).toBe(false);
  });
});
