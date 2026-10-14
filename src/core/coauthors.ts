/**
 * Removal of `Co-authored-by:` trailers that AI coding agents append to
 * commit messages.
 *
 * Cross-platform by construction: only `git` plumbing commands are spawned
 * (argv arrays, never shell strings), commit messages travel via temp files,
 * and no OS-specific tooling is used. Works on Linux, macOS, and Windows
 * anywhere `git` is on PATH.
 *
 * Safety contract (fail-closed):
 * - Requires an attached branch (no detached HEAD), a clean working tree,
 *   and no in-progress rebase/merge/cherry-pick.
 * - Refuses merge commits inside the target range.
 * - Refuses to touch commits already pushed upstream unless `force` is set
 *   (rewritten history then needs `git push --force-with-lease`).
 * - Validates every rewritten message BEFORE touching history; an empty
 *   result aborts the whole operation.
 * - `last = 1` amends HEAD (author preserved). `last > 1` replays the range
 *   with `cherry-pick -n` onto the base and moves the branch pointer —
 *   file content is never altered, only messages.
 */
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

export interface StrippedCommit {
  /** Original SHA (before rewrite). */
  sha: string;
  /** Subject line, unchanged by the strip. */
  subject: string;
  /** Number of trailer lines removed. */
  removed: number;
  /** Stripped full message. */
  message: string;
  /** New SHA after a real (non-dry-run) rewrite. */
  newSha?: string;
}

export interface StripCoAuthorsOptions {
  /** How many commits back from HEAD to process (default 1). */
  last?: number;
  /** Case-insensitive substring: only strip trailer lines containing it. */
  match?: string;
  /** Preview only; touch nothing. */
  dryRun?: boolean;
  /** Allow rewriting commits already pushed upstream. */
  force?: boolean;
}

export interface StripCoAuthorsResult {
  repoRoot: string;
  branch: string;
  last: number;
  dryRun: boolean;
  /** True when --force rewrote history that was already pushed. */
  rewrotePushedHistory: boolean;
  commits: StrippedCommit[];
  rewrittenCount: number;
  note: string;
}

const TRAILER_RE = /^\s*co-authored-by\s*:(.*)$/i;
const MAX_LAST = 50;
const MAX_MATCH_LEN = 256;

/**
 * Remove `Co-authored-by:` trailer lines from a commit message.
 * Body lines are byte-identical except that runs of 3+ blank lines left
 * behind collapse to a single blank line and trailing blanks are trimmed.
 */
export function stripCoAuthorTrailers(
  message: string,
  match?: string
): { message: string; removed: number } {
  const needle = (match || "").trim().toLowerCase();
  const kept: string[] = [];
  let removed = 0;
  for (const rawLine of message.split(/\r?\n/)) {
    const m = rawLine.match(TRAILER_RE);
    if (m && (!needle || rawLine.toLowerCase().includes(needle))) {
      removed++;
      continue;
    }
    kept.push(rawLine);
  }
  const collapsed = kept
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+\n/g, "\n")
    .trimEnd();
  return { message: collapsed, removed };
}

function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): string {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        ...env,
      },
    });
  } catch (err: unknown) {
    const e = err as { stdout?: unknown; message?: string };
    const out = typeof e.stdout === "string" ? e.stdout.trim() : "";
    throw new Error(`git ${args[0]} failed${out ? `: ${out}` : ""}`);
  }
}

/** Exit-status probe: true when the command exits 0. */
function gitOk(cwd: string, args: string[]): boolean {
  try {
    execFileSync("git", args, {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return true;
  } catch {
    return false;
  }
}

function writeMessageFile(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-coauthors-"));
  const file = path.join(dir, "message.txt");
  fs.writeFileSync(file, content.endsWith("\n") ? content : content + "\n", {
    mode: 0o600,
    encoding: "utf-8",
  });
  return file;
}

function removeMessageFile(file: string): void {
  try {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  } catch {
    // ignore cleanup failure
  }
}

export function gitBinaryAvailable(): boolean {
  return gitOk(process.cwd(), ["--version"]);
}

export function stripCoAuthorsInRepo(
  repoPath: string,
  options: StripCoAuthorsOptions = {}
): StripCoAuthorsResult {
  const last = options.last ?? 1;
  if (!Number.isInteger(last) || last < 1 || last > MAX_LAST) {
    throw new Error(`Invalid --last value: must be an integer from 1 to ${MAX_LAST}`);
  }
  const match = (options.match || "").trim();
  if (match.length > MAX_MATCH_LEN) {
    throw new Error(`Invalid --match value: must be at most ${MAX_MATCH_LEN} characters`);
  }
  const dryRun = Boolean(options.dryRun);
  const force = Boolean(options.force);

  // 1. Repo root + attached branch.
  let repoRoot: string;
  try {
    repoRoot = git(repoPath, ["rev-parse", "--show-toplevel"]).trim();
  } catch {
    throw new Error(`Not a git repository: ${repoPath}`);
  }
  const cwd = repoRoot;
  let branch: string;
  try {
    branch = git(cwd, ["symbolic-ref", "--short", "HEAD"]).trim();
    if (!branch) throw new Error("detached");
  } catch {
    throw new Error("Refusing to rewrite history on a detached HEAD — check out a branch first");
  }

  // 2. Fail-closed preconditions.
  const porcelain = git(cwd, ["status", "--porcelain"]).trim();
  if (porcelain) {
    throw new Error(
      "Refusing to rewrite history with a dirty working tree — commit or stash your changes first"
    );
  }
  let gitDir = "";
  try {
    gitDir = git(cwd, ["rev-parse", "--absolute-git-dir"]).trim();
  } catch {
    throw new Error("Unable to locate the git directory");
  }
  for (const marker of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REBASE_HEAD"]) {
    try {
      if (fs.existsSync(path.join(gitDir, marker))) {
        throw new Error(
          `Refusing to rewrite history while another operation is in progress (${marker} present) — finish or abort it first`
        );
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.message.startsWith("Refusing")) throw err;
      // ignore stat errors, treat as absent
    }
  }
  for (const dir of ["rebase-merge", "rebase-apply"]) {
    try {
      if (fs.existsSync(path.join(gitDir, dir))) {
        throw new Error(
          `Refusing to rewrite history while a rebase is in progress (${dir}/ present) — finish or abort it first`
        );
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.message.startsWith("Refusing")) throw err;
      // ignore
    }
  }

  // 3. Resolve the range (oldest first) and validate depth.
  const rangeOut = git(cwd, ["rev-list", `-n${last}`, "--reverse", "HEAD"]).trim();
  const shas = rangeOut ? rangeOut.split(/\s+/) : [];
  if (shas.length < last) {
    throw new Error(
      `Branch "${branch}" has only ${shas.length} commit(s) — cannot strip the last ${last}`
    );
  }
  const mergesOut = git(cwd, ["rev-list", "--merges", `-n${last}`, "HEAD"]).trim();
  if (mergesOut) {
    throw new Error(
      `Refusing to rewrite a range containing merge commit(s) (${mergesOut.split(/\s+/)[0]}) — reword those manually`
    );
  }

  // 4. Pushed-history guard.
  let upstream: string | null = null;
  try {
    upstream =
      git(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]).trim() || null;
  } catch {
    upstream = null; // no upstream configured — nothing can be pushed
  }
  const pushed: string[] = [];
  if (upstream) {
    for (const sha of shas) {
      if (gitOk(cwd, ["merge-base", "--is-ancestor", sha, upstream])) pushed.push(sha);
    }
  }
  if (pushed.length > 0 && !force) {
    throw new Error(
      `${pushed.length} of the last ${last} commit(s) are already pushed to ${upstream} (${pushed[0].slice(0, 8)}…) — re-run with --force to rewrite them (you will then need \`git push --force-with-lease\`)`
    );
  }

  // 5. Read + strip every message BEFORE touching history.
  const commits: StrippedCommit[] = [];
  for (const sha of shas) {
    const full = git(cwd, ["log", "-1", "--format=%B", sha]);
    // Strip one trailing newline for stable processing; stripCoAuthorTrailers trims the rest.
    const body = full.replace(/\r?\n$/, "");
    const subject = git(cwd, ["log", "-1", "--format=%s", sha]).trim();
    const { message, removed } = stripCoAuthorTrailers(body, match || undefined);
    if (removed > 0 && !message.trim()) {
      throw new Error(
        `Refusing to strip ${sha.slice(0, 8)} ("${subject}"): the message would become empty`
      );
    }
    commits.push({ sha, subject, removed, message });
  }

  const rewrittenCount = commits.filter((c) => c.removed > 0).length;
  const baseNote =
    rewrittenCount === 0
      ? `No Co-authored-by trailers found in the last ${last} commit(s)${match ? ` matching "${match}"` : ""} — nothing to do.`
      : dryRun
        ? `Dry run: would rewrite ${rewrittenCount} commit(s). Re-run without --dry-run to apply.`
        : `Rewrote ${rewrittenCount} commit(s) on branch "${branch}". Content unchanged, messages only.`;

  if (dryRun || rewrittenCount === 0) {
    return {
      repoRoot,
      branch,
      last,
      dryRun,
      rewrotePushedHistory: false,
      commits,
      rewrittenCount,
      note: baseNote,
    };
  }

  // 6. Rewrite. Only commits with trailers change; the rest replay byte-identical.
  const msgFile = writeMessageFile("");
  try {
    if (last === 1) {
      const target = commits[0];
      fs.writeFileSync(
        msgFile,
        target.message.endsWith("\n") ? target.message : target.message + "\n",
        {
          mode: 0o600,
          encoding: "utf-8",
        }
      );
      git(cwd, ["-c", "commit.gpgsign=false", "commit", "--amend", "-F", msgFile]);
      target.newSha = git(cwd, ["rev-parse", "HEAD"]).trim();
    } else {
      const oldest = shas[0];
      let base = "";
      try {
        base = git(cwd, ["rev-parse", `${oldest}^`]).trim();
      } catch {
        throw new Error(
          "Refusing to rewrite a range that includes the root commit — strip a smaller range instead"
        );
      }
      git(cwd, ["checkout", "-q", "--detach", base]);
      try {
        for (const target of commits) {
          git(cwd, ["cherry-pick", "-n", target.sha]);
          // Replay every commit with its (possibly stripped) message and
          // original author identity. Commits without trailers round-trip
          // byte-identical apart from committer metadata (rebase semantics).
          const author = git(cwd, ["log", "-1", "--format=%an%x00%ae%x00%aI", target.sha]).split(
            "\0"
          );
          fs.writeFileSync(
            msgFile,
            target.message.endsWith("\n") ? target.message : target.message + "\n",
            { mode: 0o600, encoding: "utf-8" }
          );
          git(cwd, ["-c", "commit.gpgsign=false", "commit", "-F", msgFile], {
            GIT_AUTHOR_NAME: author[0] || undefined,
            GIT_AUTHOR_EMAIL: author[1] || undefined,
            GIT_AUTHOR_DATE: author[2] || undefined,
          });
          target.newSha = git(cwd, ["rev-parse", "HEAD"]).trim();
        }
        const newTip = git(cwd, ["rev-parse", "HEAD"]).trim();
        git(cwd, ["branch", "-f", branch, newTip]);
        git(cwd, ["checkout", "-q", branch]);
      } catch (err: unknown) {
        try {
          git(cwd, ["cherry-pick", "--quit"]);
        } catch {
          // ignore — best effort
        }
        try {
          git(cwd, ["checkout", "-q", branch]);
        } catch {
          // ignore — surface the original error below
        }
        throw err instanceof Error ? err : new Error(String(err));
      }
    }
  } finally {
    removeMessageFile(msgFile);
  }

  const rewrotePushedHistory = pushed.length > 0;
  return {
    repoRoot,
    branch,
    last,
    dryRun: false,
    rewrotePushedHistory,
    commits,
    rewrittenCount,
    note:
      baseNote +
      (rewrotePushedHistory
        ? ` History was already pushed — update the remote with \`git push --force-with-lease\`.`
        : "") +
      " Rewritten commits are unsigned; re-sign afterwards if your workflow requires signatures.",
  };
}
