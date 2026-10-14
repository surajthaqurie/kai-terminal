import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { execFileSync } from "child_process";
import { stripCoAuthorTrailers, stripCoAuthorsInRepo, gitBinaryAvailable } from "../core/coauthors";
import { runCli } from "../cli/index";
import { handleMcpMessage } from "../core/mcp";

const GIT = process.env.KAI_TEST_GIT || "git";
const hasGit = gitBinaryAvailable();

function g(cwd: string, args: string[]): string {
  return execFileSync(GIT, args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
}

function initRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-coauthors-"));
  g(dir, ["init", "-b", "main"]);
  return dir;
}

function commitFile(dir: string, name: string, content: string, message: string): void {
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
    "-m",
    message,
  ]);
}

function headMessage(dir: string): string {
  return g(dir, ["log", "-1", "--format=%B"]).replace(/(\r?\n)+$/, "");
}

function headTree(dir: string): string {
  return g(dir, ["rev-parse", "HEAD^{tree}"]).trim();
}

describe("stripCoAuthorTrailers (pure)", () => {
  it("strips standard agent trailers at the end", () => {
    const { message, removed } = stripCoAuthorTrailers(
      "Add feature\n\nBody text.\n\nCo-authored-by: Opencode <noreply@opencode.ai>\nCo-authored-by: Claude <noreply@anthropic.com>\n"
    );
    expect(removed).toBe(2);
    expect(message).toBe("Add feature\n\nBody text.");
  });

  it("is case-insensitive and tolerates whitespace and CRLF", () => {
    const { message, removed } = stripCoAuthorTrailers(
      "Fix bug\r\n\r\n   CO-AUTHORED-BY :  Bot <b@b>  \r\n"
    );
    expect(removed).toBe(1);
    expect(message).toBe("Fix bug");
  });

  it("removes mid-message trailers and collapses blanks", () => {
    const { message, removed } = stripCoAuthorTrailers("a\n\nCo-authored-by: X <x@y>\n\nb");
    expect(removed).toBe(1);
    expect(message).toBe("a\n\nb");
  });

  it("leaves messages without trailers byte-identical", () => {
    const input = "Subject\n\nBody with Co-authored-by mentioned inline, not as a trailer.";
    const { message, removed } = stripCoAuthorTrailers(input);
    expect(removed).toBe(0);
    expect(message).toBe(input);
  });

  it("match filter keeps non-matching trailers", () => {
    const input = "S\n\nCo-authored-by: Opencode <a@b>\nCo-authored-by: Human <h@h>\n";
    const { message, removed } = stripCoAuthorTrailers(input, "opencode");
    expect(removed).toBe(1);
    expect(message).toBe("S\n\nCo-authored-by: Human <h@h>");
  });
});

describe.skipIf(!hasGit)("stripCoAuthorsInRepo (git integration)", () => {
  let dirs: string[] = [];
  let savedKaiHome: string | undefined;

  beforeEach(() => {
    dirs = [];
    savedKaiHome = process.env.KAI_HOME;
    process.env.KAI_HOME = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "kai-coauthors-home-")),
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

  it("amends HEAD: message cleaned, tree and author preserved", () => {
    const repo = track(initRepo());
    commitFile(repo, "a.txt", "one\n", "Base commit");
    commitFile(
      repo,
      "b.txt",
      "two\n",
      "Add b\n\nSome body.\n\nCo-authored-by: Opencode <noreply@opencode.ai>"
    );
    const beforeTree = headTree(repo);
    const beforeAuthor = g(repo, ["log", "-1", "--format=%an %ae"]).trim();

    const res = stripCoAuthorsInRepo(repo, { last: 1 });
    expect(res.rewrittenCount).toBe(1);
    expect(res.commits[0].removed).toBe(1);
    expect(res.commits[0].newSha).toBeTruthy();
    expect(headMessage(repo)).toBe("Add b\n\nSome body.");
    expect(headTree(repo)).toBe(beforeTree);
    expect(g(repo, ["log", "-1", "--format=%an %ae"]).trim()).toBe(beforeAuthor);
  });

  it("rewrites a range and replays trailer-free commits with identical trees", () => {
    const repo = track(initRepo());
    commitFile(repo, "root.txt", "root\n", "Root commit");
    commitFile(repo, "a.txt", "one\n", "First\n\nCo-authored-by: Bot <b@b>");
    commitFile(repo, "b.txt", "two\n", "Second without trailer");
    commitFile(repo, "c.txt", "three\n", "Third\n\nCo-authored-by: Bot <b@b>");
    const beforeTree = headTree(repo);

    const res = stripCoAuthorsInRepo(repo, { last: 3 });
    expect(res.rewrittenCount).toBe(2);
    expect(headTree(repo)).toBe(beforeTree);
    expect(g(repo, ["log", "--format=%s", "-n3"]).trim().split("\n")).toEqual([
      "Third",
      "Second without trailer",
      "First",
    ]);
    expect(g(repo, ["log", "--format=%B", "-n3"])).not.toMatch(/co-authored-by/i);
  });

  it("dry-run previews without touching history", () => {
    const repo = track(initRepo());
    commitFile(repo, "a.txt", "one\n", "Work\n\nCo-authored-by: Bot <b@b>");
    const before = g(repo, ["rev-parse", "HEAD"]).trim();

    const res = stripCoAuthorsInRepo(repo, { last: 1, dryRun: true });
    expect(res.dryRun).toBe(true);
    expect(res.rewrittenCount).toBe(1);
    expect(res.commits[0].newSha).toBeUndefined();
    expect(g(repo, ["rev-parse", "HEAD"]).trim()).toBe(before);
    expect(headMessage(repo)).toContain("Co-authored-by");
  });

  it("reports nothing-to-do when no trailers exist", () => {
    const repo = track(initRepo());
    commitFile(repo, "a.txt", "one\n", "Clean commit");
    const res = stripCoAuthorsInRepo(repo, { last: 1 });
    expect(res.rewrittenCount).toBe(0);
  });

  it("refuses dirty trees, detached HEAD, merges, and empty results", () => {
    const repo = track(initRepo());
    commitFile(repo, "a.txt", "one\n", "Base");
    fs.writeFileSync(path.join(repo, "a.txt"), "dirty\n");
    expect(() => stripCoAuthorsInRepo(repo, { last: 1 })).toThrow(/dirty/);
    g(repo, ["checkout", "--", "a.txt"]);

    g(repo, ["checkout", "-q", "--detach", "HEAD"]);
    expect(() => stripCoAuthorsInRepo(repo, { last: 1 })).toThrow(/detached/);
    g(repo, ["checkout", "-q", "main"]);

    commitFile(repo, "only.txt", "x\n", "Co-authored-by: Bot <b@b>");
    expect(() => stripCoAuthorsInRepo(repo, { last: 1 })).toThrow(/empty/);
  });

  it("refuses merge commits in range", () => {
    const repo = track(initRepo());
    commitFile(repo, "a.txt", "one\n", "Base");
    g(repo, ["checkout", "-qb", "side"]);
    commitFile(repo, "s.txt", "s\n", "Side work");
    g(repo, ["checkout", "-q", "main"]);
    g(repo, [
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "-c",
      "commit.gpgsign=false",
      "merge",
      "--no-ff",
      "-m",
      "Merge side",
      "side",
    ]);
    expect(() => stripCoAuthorsInRepo(repo, { last: 2 })).toThrow(/merge/i);
  });

  it("refuses pushed history without --force, rewrites with it", () => {
    const repo = track(initRepo());
    const bare = track(fs.mkdtempSync(path.join(os.tmpdir(), "kai-coauthors-bare-")));
    g(bare, ["init", "--bare", "-b", "main"]);
    g(repo, ["remote", "add", "origin", bare]);
    commitFile(repo, "a.txt", "one\n", "Base");
    g(repo, ["push", "-q", "-u", "origin", "main"]);
    commitFile(repo, "b.txt", "two\n", "Pushed work\n\nCo-authored-by: Bot <b@b>");
    g(repo, ["push", "-q"]);

    expect(() => stripCoAuthorsInRepo(repo, { last: 1 })).toThrow(/already pushed/);
    const res = stripCoAuthorsInRepo(repo, { last: 1, force: true });
    expect(res.rewrittenCount).toBe(1);
    expect(res.rewrotePushedHistory).toBe(true);
    expect(headMessage(repo)).toBe("Pushed work");
  });

  it("CLI strips HEAD and supports --dry-run", async () => {
    const repo = track(initRepo());
    commitFile(repo, "a.txt", "one\n", "Work\n\nCo-authored-by: Bot <b@b>");
    const code = await runCli(["node", "kai", "strip-coauthors", repo, "--dry-run"]);
    expect(code).toBe(0);
    expect(headMessage(repo)).toContain("Co-authored-by");
    const code2 = await runCli(["node", "kai", "strip-coauthors", repo]);
    expect(code2).toBe(0);
    expect(headMessage(repo)).toBe("Work");
  });

  it("CLI returns 1 outside a repo and validates flags", async () => {
    const plain = track(fs.mkdtempSync(path.join(os.tmpdir(), "kai-coauthors-plain-")));
    expect(await runCli(["node", "kai", "strip-coauthors", plain])).toBe(1);
    const repo = track(initRepo());
    commitFile(repo, "a.txt", "one\n", "Base");
    expect(await runCli(["node", "kai", "strip-coauthors", repo, "--last", "0"])).toBe(1);
  });

  it("MCP kai_strip_coauthors dry-runs within the workspace boundary", async () => {
    const repo = track(initRepo());
    commitFile(repo, "a.txt", "one\n", "Work\n\nCo-authored-by: Bot <b@b>");
    const res = await handleMcpMessage(
      {
        jsonrpc: "2.0",
        id: "strip-1",
        method: "tools/call",
        params: {
          name: "kai_strip_coauthors",
          arguments: { projectPath: repo, dryRun: true },
        },
      },
      repo
    );
    expect(res && "result" in res).toBe(true);
    const text = JSON.stringify(res);
    expect(text).toContain("would rewrite");
    expect(headMessage(repo)).toContain("Co-authored-by");
  });

  it("MCP rejects bad params and out-of-boundary paths", async () => {
    const repo = track(initRepo());
    commitFile(repo, "a.txt", "one\n", "Base");
    const badLast = await handleMcpMessage(
      {
        jsonrpc: "2.0",
        id: "strip-2",
        method: "tools/call",
        params: { name: "kai_strip_coauthors", arguments: { projectPath: repo, last: -3 } },
      },
      repo
    );
    expect(badLast && "error" in badLast).toBe(true);
    const outside = await handleMcpMessage(
      {
        jsonrpc: "2.0",
        id: "strip-3",
        method: "tools/call",
        params: { name: "kai_strip_coauthors", arguments: { projectPath: "/etc" } },
      },
      repo
    );
    expect(outside && "error" in outside).toBe(true);
  });
});
