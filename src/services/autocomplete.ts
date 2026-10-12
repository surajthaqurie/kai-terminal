/**
 * Terminal command autocomplete (frontend inline suggestions).
 *
 * The shell itself still owns Tab completion over the PTY. This layer adds
 * a fish-style helper: as the user types, we match the current token
 * against (1) recently used commands (local history) and (2) a curated
 * builtin command set, then offer a popup. Accepting a suggestion writes
 * only the missing remainder to the PTY — a single writer, no echo hacks.
 */

export const AUTOCOMPLETE_HISTORY_KEY = "kai_cmd_history_v1";
const MAX_HISTORY = 200;
const MAX_SUGGESTIONS = 8;

export const BUILTIN_COMMANDS: string[] = [
  // coreutils / navigation
  "ls", "ll", "la", "cd", "pwd", "mkdir", "rmdir", "rm", "cp", "mv", "touch",
  "cat", "less", "more", "head", "tail", "echo", "clear", "history", "exit",
  "find", "grep", "rg", "fd", "sed", "awk", "xargs", "chmod", "chown", "ln",
  "tar", "zip", "unzip", "curl", "wget", "ssh", "scp", "rsync",
  // git
  "git", "git status", "git add", "git commit", "git push", "git pull",
  "git fetch", "git checkout", "git switch", "git branch", "git merge",
  "git rebase", "git log", "git diff", "git stash", "git clone",
  // package managers / runtimes
  "npm", "npm install", "npm run", "npm test", "npm run build", "npm run dev",
  "npx", "yarn", "pnpm", "bun", "node", "deno",
  "python", "python3", "pip", "pip3", "poetry", "cargo", "go", "rustc",
  // containers / k8s
  "docker", "docker ps", "docker images", "docker build", "docker run",
  "docker compose", "docker compose up", "kubectl", "helm", "terraform",
  // kai
  "kai", "kai --help", "kai code", "kai reconcile",
  // editors / misc
  "code", "vim", "nvim", "nano", "tmux", "make", "cmake",
];

export function loadCommandHistory(): string[] {
  try {
    const raw = localStorage.getItem(AUTOCOMPLETE_HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((s): s is string => typeof s === "string").slice(0, MAX_HISTORY);
  } catch {
    return [];
  }
}

export function saveCommandHistory(history: string[]): void {
  try {
    localStorage.setItem(AUTOCOMPLETE_HISTORY_KEY, JSON.stringify(history.slice(0, MAX_HISTORY)));
  } catch {
    // ignore quota errors
  }
}

/** Record a submitted line (most-recent-first, deduped, capped). */
export function recordCommand(history: string[], line: string): string[] {
  const cmd = line.trim();
  if (!cmd) return history;
  // Never persist likely-secret assignments (e.g. `export TOKEN=...`).
  if (/(password|secret|token|api[_-]?key)\s*=\s*\S+/i.test(cmd)) return history;
  const next = [cmd, ...history.filter((h) => h !== cmd)];
  return next.slice(0, MAX_HISTORY);
}

/**
 * Current token = text after the last shell separator on the input line.
 * Separators: whitespace, ; & | ( ) < > ` ' " $ and = for `KEY=value` runs.
 */
export function currentToken(line: string): string {
  const m = line.match(/([^;\s&|()<>`'"$=]+)$/);
  return m ? m[1] : "";
}

/**
 * Ranked completions for `prefix`: history first (recency), then builtins.
 * Case-insensitive prefix match, deduped, capped at MAX_SUGGESTIONS.
 * Empty prefix -> no suggestions (avoids popup spam on a blank prompt).
 */
export function getCompletions(prefix: string, history: string[]): string[] {
  if (!prefix) return [];
  const lower = prefix.toLowerCase();
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (s: string) => {
    if (seen.has(s)) return;
    seen.add(s);
    if (out.length < MAX_SUGGESTIONS) out.push(s);
  };
  // History: match the full command line start OR the last token start.
  for (const h of history) {
    if (out.length >= MAX_SUGGESTIONS) break;
    if (h.toLowerCase().startsWith(lower)) {
      push(h);
      continue;
    }
    const tok = currentToken(h);
    if (tok && tok.toLowerCase().startsWith(lower) && tok.length > prefix.length) {
      push(tok);
    }
  }
  for (const b of BUILTIN_COMMANDS) {
    if (out.length >= MAX_SUGGESTIONS) break;
    if (b.toLowerCase().startsWith(lower) && !seen.has(b)) push(b);
  }
  // Token-only builtins for mid-line tokens (e.g. after `sudo `).
  if (out.length < MAX_SUGGESTIONS) {
    const firstWords = new Set(
      BUILTIN_COMMANDS.map((c) => c.split(" ")[0])
    );
    for (const w of firstWords) {
      if (out.length >= MAX_SUGGESTIONS) break;
      if (w.toLowerCase().startsWith(lower) && !seen.has(w)) push(w);
    }
  }
  return out;
}

/** Remainder to type when accepting `suggestion` for `prefix`. */
export function completionRemainder(prefix: string, suggestion: string): string {
  if (!suggestion.toLowerCase().startsWith(prefix.toLowerCase())) return suggestion;
  // Preserve the suggestion's own casing, complete only the missing tail.
  // When the suggestion is a full history line and the prefix is a shorter
  // token, complete up to the next space (single word) to avoid pasting a
  // whole pipeline over a partial word.
  const tail = suggestion.slice(prefix.length);
  if (suggestion.includes(" ") && !prefix.includes(" ")) {
    const space = tail.indexOf(" ");
    if (space > 0) return tail.slice(0, space);
  }
  return tail;
}
