import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// A bare `bash` on Windows may be WSL, whose paths and git differ; opt in with
// KAI_TEST_BASH (e.g. Git Bash) there. Linux and macOS always run this.
const BASH = process.env.KAI_TEST_BASH ?? "bash";
const enabled = process.platform !== "win32" || Boolean(process.env.KAI_TEST_BASH);
const SCRIPT = path.resolve(__dirname, "../../scripts/repoint-tag.sh").replace(/\\/g, "/");
const toPosix = (p: string) => p.replace(/\\/g, "/");

let root: string;
let origin: string;
let work: string;
let env: NodeJS.ProcessEnv;

function git(args: string[], cwd = work): string {
  const r = spawnSync("git", args, { cwd, env, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function repoint(...args: string[]): { status: number | null; out: string } {
  const r = spawnSync(BASH, [SCRIPT, ...args], { cwd: work, env, encoding: "utf8" });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

const remoteTag = (tag: string) => git(["rev-parse", `refs/tags/${tag}^{}`], origin);

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "kai-repoint-"));
  origin = path.join(root, "origin.git");
  work = path.join(root, "work");
  const emptyConfig = path.join(root, "gitconfig");
  fs.writeFileSync(emptyConfig, "");
  env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: emptyConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.com",
  };
  git(["init", "--bare", "-b", "main", toPosix(origin)], root);
  git(["clone", toPosix(origin), toPosix(work)], root);
  git(["checkout", "-b", "main"]);
  fs.writeFileSync(path.join(work, "tracked.txt"), "one\n");
  git(["add", "tracked.txt"]);
  git(["commit", "-m", "initial"]);
  git(["push", "-u", "origin", "main"]);
  git(["tag", "-a", "v1.0.0", "-m", "release one"]);
  git(["push", "origin", "refs/tags/v1.0.0"]);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe.runIf(enabled)("scripts/repoint-tag.sh", () => {
  it("commits tracked changes only, never untracked files, and moves the tag", () => {
    fs.writeFileSync(path.join(work, "tracked.txt"), "two\n");
    fs.writeFileSync(path.join(work, ".mcp.json"), "{}");
    fs.mkdirSync(path.join(work, "graphify-out"));
    fs.writeFileSync(path.join(work, "graphify-out", "graph.json"), "{}");
    const oldTag = remoteTag("v1.0.0");

    const run = repoint("v1.0.0", "--commit-msg", "fix: release", "--yes");

    expect(run.status, run.out).toBe(0);
    const head = git(["rev-parse", "HEAD"]);
    expect(head).not.toBe(oldTag);
    expect(remoteTag("v1.0.0")).toBe(head);
    expect(git(["rev-parse", "refs/heads/main"], origin)).toBe(head);
    const committed = git(["ls-tree", "-r", "--name-only", "HEAD"]).split("\n");
    expect(committed).toEqual(["tracked.txt"]);
    expect(git(["show", "HEAD:tracked.txt"])).toBe("two");
    expect(git(["log", "-1", "--format=%s"])).toBe("fix: release");
    // They are reported, not lost.
    expect(run.out).toContain(".mcp.json");
    expect(fs.existsSync(path.join(work, ".mcp.json"))).toBe(true);
  });

  it("keeps the previous tag annotation", () => {
    fs.writeFileSync(path.join(work, "tracked.txt"), "two\n");

    expect(repoint("v1.0.0", "--yes").status).toBe(0);

    expect(git(["tag", "-l", "--format=%(contents)", "v1.0.0"], origin).trim()).toBe("release one");
  });

  it("leaves the remote tag where it was when the push is rejected", () => {
    // The remote refuses to move a tag but would allow deleting it: the old
    // delete-then-push order left the release with no tag at all.
    const hook = path.join(origin, "hooks", "pre-receive");
    fs.writeFileSync(
      hook,
      [
        "#!/bin/sh",
        "while read old new ref; do",
        '  case "$ref" in refs/tags/*)',
        '    [ "$new" = "0000000000000000000000000000000000000000" ] || exit 1;;',
        "  esac",
        "done",
        "exit 0",
        "",
      ].join("\n"),
      { mode: 0o755 }
    );
    fs.writeFileSync(path.join(work, "tracked.txt"), "two\n");
    const oldTag = remoteTag("v1.0.0");

    const run = repoint("v1.0.0", "--yes");

    expect(run.status).not.toBe(0);
    expect(remoteTag("v1.0.0")).toBe(oldTag);
  });

  it("--dry-run changes nothing locally or remotely", () => {
    fs.writeFileSync(path.join(work, "tracked.txt"), "two\n");
    const localHead = git(["rev-parse", "HEAD"]);
    const oldTag = remoteTag("v1.0.0");

    const run = repoint("v1.0.0", "--dry-run");

    expect(run.status, run.out).toBe(0);
    expect(run.out).toContain("[dry-run] git add -u");
    expect(run.out).toContain("[dry-run] git push --force origin refs/tags/v1.0.0");
    expect(git(["rev-parse", "HEAD"])).toBe(localHead);
    expect(git(["status", "--porcelain"])).toContain("M tracked.txt");
    expect(remoteTag("v1.0.0")).toBe(oldTag);
    expect(git(["rev-parse", "refs/heads/main"], origin)).toBe(localHead);
  });

  it("rejects a missing tag argument and unknown flags", () => {
    expect(repoint().status).toBe(1);
    expect(repoint("v1.0.0", "--bogus").status).toBe(1);
  });
});
