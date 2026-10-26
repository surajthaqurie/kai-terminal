/**
 * Automatic `Co-authored-by:` trailer removal via a git `commit-msg` hook.
 *
 * Entering Code Mode (`kai code .`) installs a self-contained hook into the
 * repo, so EVERY commit afterwards — from Claude Code, opencode, or any
 * other agent — has AI trailers stripped at commit time with nothing to
 * remember and no extra commands. `kai status` reports the hook state;
 * removal (when ever wanted) is a plain file operation documented in the
 * README.
 *
 * Cross-platform by construction:
 * - The hook is POSIX `sh` + `grep -v -i` only. Git for Windows executes
 *   hooks through its bundled shell, so the exact same file works on
 *   Linux, macOS, and Windows with no Node/kai dependency at commit time.
 * - Fail-open: any hook error leaves the message untouched and the commit
 *   proceeds (exit 0). A hook must never block work.
 * - A pre-existing user hook is never overwritten: it is moved aside to
 *   `commit-msg.kai-orig` and chained (runs after stripping, exit code
 *   preserved). Removal restores it byte-identical.
 */
import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";

const HOOK_MARKER = "kai-commit-msg-hook v1";
export const HOOK_FILE = "commit-msg";
export const HOOK_BACKUP_FILE = "commit-msg.kai-orig";

const HOOK_SCRIPT = `#!/bin/sh
# ${HOOK_MARKER} — auto-strip AI Co-authored-by trailers. Fail-open: never blocks a commit.
f="$1"
if [ -n "$f" ] && [ -f "$f" ]; then
  tmp="$f.kai-trim-tmp"
  grep -v -i '^[[:space:]]*co-authored-by[[:space:]]*:' "$f" > "$tmp" 2>/dev/null
  code=$?
  # grep exits 1 when every line was filtered (message was only trailers):
  # still replace — git then refuses the empty message safely. Exit > 1 is a
  # real error (missing grep, I/O): leave the message untouched.
  if [ "$code" -le 1 ]; then
    cat "$tmp" > "$f" 2>/dev/null || true
  fi
  rm -f "$tmp"
fi
# Chain the pre-existing user hook preserved at install time, if any.
if [ -x "$(dirname "$0")/${HOOK_BACKUP_FILE}" ]; then
  exec "$(dirname "$0")/${HOOK_BACKUP_FILE}" "$@"
fi
exit 0
`;

export type HookState = "none" | "ours" | "ours-chained" | "foreign";

export interface HookStatus {
  repoRoot: string;
  hooksDir: string;
  hookPath: string;
  state: HookState;
}

export interface HookInstallResult {
  repoRoot: string;
  hookPath: string;
  alreadyInstalled: boolean;
  /** True when a pre-existing user hook was preserved and chained. */
  chained: boolean;
}

export interface HookRemoveResult {
  repoRoot: string;
  removed: boolean;
  /** True when a preserved user hook was restored. */
  restored: boolean;
}

function isOurHook(content: string): boolean {
  return content.includes(HOOK_MARKER);
}

/** Resolve the hooks directory, honouring `core.hooksPath` and worktrees. */
function resolveHooksDir(repoPath: string): { repoRoot: string; hooksDir: string } {
  let repoRoot: string;
  try {
    repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: repoPath,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    }).trim();
  } catch {
    throw new Error(`Not a git repository: ${repoPath}`);
  }
  if (!repoRoot) throw new Error(`Not a git repository: ${repoPath}`);
  try {
    const hooksDir = execFileSync(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-path", "hooks"],
      {
        cwd: repoRoot,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      }
    ).trim();
    if (hooksDir) return { repoRoot, hooksDir };
  } catch {
    // git < 2.13 fallback below
  }
  const gitDir = execFileSync("git", ["rev-parse", "--absolute-git-dir"], {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  }).trim();
  return { repoRoot, hooksDir: path.join(gitDir, "hooks") };
}

export function hookStatus(repoPath: string): HookStatus {
  const { repoRoot, hooksDir } = resolveHooksDir(repoPath);
  const hookPath = path.join(hooksDir, HOOK_FILE);
  let state: HookState = "none";
  try {
    if (fs.existsSync(hookPath)) {
      const content = fs.readFileSync(hookPath, "utf-8");
      const chained = fs.existsSync(path.join(hooksDir, HOOK_BACKUP_FILE));
      state = isOurHook(content) ? (chained ? "ours-chained" : "ours") : "foreign";
    }
  } catch {
    state = "none";
  }
  return { repoRoot, hooksDir, hookPath, state };
}

export function installCommitMsgHook(repoPath: string): HookInstallResult {
  const { repoRoot, hooksDir } = resolveHooksDir(repoPath);
  const hookPath = path.join(hooksDir, HOOK_FILE);
  const backupPath = path.join(hooksDir, HOOK_BACKUP_FILE);

  try {
    fs.mkdirSync(hooksDir, { recursive: true });
  } catch {
    throw new Error(`Cannot write hooks directory: ${hooksDir}`);
  }

  if (fs.existsSync(hookPath)) {
    let content = "";
    try {
      content = fs.readFileSync(hookPath, "utf-8");
    } catch {
      throw new Error(`Cannot read existing hook: ${hookPath}`);
    }
    if (isOurHook(content)) {
      try {
        fs.chmodSync(hookPath, 0o755);
      } catch {
        // Windows ignores mode bits; hook still runs via git's shell
      }
      return { repoRoot, hookPath, alreadyInstalled: true, chained: fs.existsSync(backupPath) };
    }
    // Foreign hook: preserve it, never overwrite.
    if (fs.existsSync(backupPath)) {
      throw new Error(
        `A preserved hook already exists at ${backupPath} — resolve it manually before reinstalling`
      );
    }
    try {
      fs.renameSync(hookPath, backupPath);
    } catch {
      throw new Error(`Cannot preserve existing hook at ${hookPath}`);
    }
    writeHook(hookPath);
    return { repoRoot, hookPath, alreadyInstalled: false, chained: true };
  }

  writeHook(hookPath);
  return { repoRoot, hookPath, alreadyInstalled: false, chained: false };
}

function writeHook(hookPath: string): void {
  try {
    fs.writeFileSync(hookPath, HOOK_SCRIPT, { mode: 0o755, encoding: "utf-8" });
  } catch {
    throw new Error(`Cannot write hook: ${hookPath}`);
  }
  try {
    fs.chmodSync(hookPath, 0o755);
  } catch {
    // ignore on Windows
  }
}

export function removeCommitMsgHook(repoPath: string): HookRemoveResult {
  const { repoRoot, hooksDir } = resolveHooksDir(repoPath);
  const hookPath = path.join(hooksDir, HOOK_FILE);
  const backupPath = path.join(hooksDir, HOOK_BACKUP_FILE);

  if (!fs.existsSync(hookPath)) {
    return { repoRoot, removed: false, restored: false };
  }
  let content = "";
  try {
    content = fs.readFileSync(hookPath, "utf-8");
  } catch {
    throw new Error(`Cannot read hook: ${hookPath}`);
  }
  if (!isOurHook(content)) {
    throw new Error(`No Kai hook installed (a foreign commit-msg hook exists) — not touching it`);
  }
  try {
    fs.rmSync(hookPath, { force: true });
  } catch {
    throw new Error(`Cannot remove hook: ${hookPath}`);
  }
  let restored = false;
  if (fs.existsSync(backupPath)) {
    try {
      fs.renameSync(backupPath, hookPath);
      restored = true;
    } catch {
      throw new Error(`Hook removed, but cannot restore the preserved hook at ${backupPath}`);
    }
  }
  return { repoRoot, removed: true, restored };
}
