import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { execFileSync } from "child_process";
import {
  installCommitMsgHook,
  removeCommitMsgHook,
  hookStatus,
  HOOK_FILE,
  HOOK_BACKUP_FILE,
} from "../core/githooks";
import { runCli } from "../cli/index";
import { handleMcpMessage } from "../core/mcp";

function gitBinaryAvailable(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const hasGit = gitBinaryAvailable();

function g(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
}

function initRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-githooks-"));
  g(dir, ["init", "-b", "main"]);
  return dir;
}

function commitWithMessage(dir: string, name: string, content: string, message: string): void {
  fs.writeFileSync(path.join(dir, name), content);
  g(dir, ["add", name]);
  g(dir, [
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-q",
    "-m",
    message,
  ]);
}

describe.skipIf(!hasGit)("commit-msg hook lifecycle", () => {
  let dirs: string[] = [];
  let savedKaiHome: string | undefined;

  beforeEach(() => {
    dirs = [];
    savedKaiHome = process.env.KAI_HOME;
    process.env.KAI_HOME = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "kai-githooks-home-")),
      "kai_home"
    );
  });

  afterEach(() => {
    if (savedKaiHome === undefined) delete process.env.KAI_HOME;
    else process.env.KAI_HOME = savedKaiHome;
    for (const d of dirs) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  function track(dir: string): string {
    dirs.push(dir);
    return dir;
  }

  function hooksDirOf(repo: string): string {
    return g(repo, ["rev-parse", "--path-format=absolute", "--git-path", "hooks"]).trim();
  }

  it("installs, reports status, and removes cleanly", () => {
    const repo = track(initRepo());
    expect(hookStatus(repo).state).toBe("none");
    const r = installCommitMsgHook(repo);
    expect(r.alreadyInstalled).toBe(false);
    expect(r.chained).toBe(false);
    expect(fs.existsSync(r.hookPath)).toBe(true);
    expect(hookStatus(repo).state).toBe("ours");

    const again = installCommitMsgHook(repo);
    expect(again.alreadyInstalled).toBe(true);

    const rm = removeCommitMsgHook(repo);
    expect(rm.removed).toBe(true);
    expect(rm.restored).toBe(false);
    expect(hookStatus(repo).state).toBe("none");
    const rm2 = removeCommitMsgHook(repo);
    expect(rm2.removed).toBe(false);
  });

  it("preserves and chains a foreign hook, restores it on remove", () => {
    const repo = track(initRepo());
    const hooksDir = hooksDirOf(repo);
    const foreign = "#!/bin/sh\necho foreign-hook-ran >&2\nexit 0\n";
    fs.writeFileSync(path.join(hooksDir, HOOK_FILE), foreign, { mode: 0o755 });
    try {
      fs.chmodSync(path.join(hooksDir, HOOK_FILE), 0o755);
    } catch {
      // ignore on Windows
    }

    const r = installCommitMsgHook(repo);
    expect(r.chained).toBe(true);
    expect(hookStatus(repo).state).toBe("ours-chained");
    expect(fs.readFileSync(path.join(hooksDir, HOOK_BACKUP_FILE), "utf-8")).toBe(foreign);

    const rm = removeCommitMsgHook(repo);
    expect(rm.removed).toBe(true);
    expect(rm.restored).toBe(true);
    expect(fs.readFileSync(path.join(hooksDir, HOOK_FILE), "utf-8")).toBe(foreign);
    expect(fs.existsSync(path.join(hooksDir, HOOK_BACKUP_FILE))).toBe(false);
    expect(hookStatus(repo).state).toBe("foreign");
  });

  it("refuses to remove a foreign hook and fails outside repos", () => {
    const repo = track(initRepo());
    const hooksDir = hooksDirOf(repo);
    fs.writeFileSync(path.join(hooksDir, HOOK_FILE), "#!/bin/sh\nexit 0\n");
    expect(() => removeCommitMsgHook(repo)).toThrow(/foreign/);
    const plain = track(fs.mkdtempSync(path.join(os.tmpdir(), "kai-githooks-plain-")));
    expect(() => installCommitMsgHook(plain)).toThrow(/Not a git repository/);
    expect(() => hookStatus(plain)).toThrow(/Not a git repository/);
  });

  it("strips trailers on real commits end to end", () => {
    const repo = track(initRepo());
    installCommitMsgHook(repo);
    commitWithMessage(
      repo,
      "a.txt",
      "one\n",
      "Add feature\n\nBody.\n\nCo-authored-by: Claude <noreply@anthropic.com>"
    );
    const stored = g(repo, ["log", "-1", "--format=%B"]);
    expect(stored).not.toMatch(/co-authored-by/i);
    expect(stored).toContain("Add feature");
    expect(stored).toContain("Body.");
    // Commits without trailers pass through untouched.
    commitWithMessage(repo, "b.txt", "two\n", "Clean commit\n\nSome body.");
    expect(g(repo, ["log", "-1", "--format=%B"]).replace(/(\r?\n)+$/, "")).toBe(
      "Clean commit\n\nSome body."
    );
  });

  it("chains a foreign hook: strip runs and the original still executes", () => {
    const repo = track(initRepo());
    const hooksDir = hooksDirOf(repo);
    fs.writeFileSync(path.join(hooksDir, HOOK_FILE), '#!/bin/sh\necho "CHAINED-MARKER" >> "$1"\n');
    try {
      fs.chmodSync(path.join(hooksDir, HOOK_FILE), 0o755);
    } catch {
      // ignore on Windows
    }
    installCommitMsgHook(repo);
    commitWithMessage(repo, "a.txt", "one\n", "Work\n\nCo-authored-by: Bot <b@b>");
    const stored = g(repo, ["log", "-1", "--format=%B"]);
    expect(stored).not.toMatch(/co-authored-by/i);
    expect(stored).toContain("CHAINED-MARKER");
  });

  it("Code Mode / graph init auto-installs the hook", async () => {
    const repo = track(initRepo());
    expect(await runCli(["node", "kai", "graph", "init", repo])).toBe(0);
    expect(hookStatus(repo).state).toBe("ours");
    // Second entry is idempotent and stays quiet.
    expect(await runCli(["node", "kai", "graph", "init", repo])).toBe(0);
    expect(hookStatus(repo).state).toBe("ours");
  });

  it("Code Mode works in non-git folders without a hook", async () => {
    const plain = track(fs.mkdtempSync(path.join(os.tmpdir(), "kai-githooks-plain-")));
    expect(await runCli(["node", "kai", "graph", "init", plain])).toBe(0);
  });

  it("graph init installs the hook and reports ours", async () => {
    const repo = track(initRepo());
    expect(await runCli(["node", "kai", "graph", "init", repo])).toBe(0);
    expect(hookStatus(repo).state).toBe("ours");
  });

  it("no hook management tool is exposed over MCP (automatic only)", async () => {
    const repo = track(initRepo());
    const res = await handleMcpMessage(
      {
        jsonrpc: "2.0",
        id: "h1",
        method: "tools/call",
        params: { name: "kai_commit_hook", arguments: { action: "status", projectPath: repo } },
      },
      repo
    );
    expect(res && "error" in res).toBe(true);
    expect(JSON.stringify(res)).toContain("Unknown tool");
    const listed = await handleMcpMessage(
      { jsonrpc: "2.0", id: "h2", method: "tools/list", params: {} },
      repo
    );
    expect(JSON.stringify(listed)).not.toContain("kai_commit_hook");
  });
});
