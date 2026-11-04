import fs from "fs";
import { execFile } from "child_process";
import { windowsPowerShellEnv } from "../integrations/secretStore";

/**
 * Finds out whether this command is being run by an AI agent, by looking at the
 * processes that started it. Environment markers only catch agents that set
 * one; every agent runs as a process, and its commands are its descendants.
 *
 * The walk goes from this process up through its parents and stops at the
 * first match. It also stops at the Kai desktop app: a terminal tab inside Kai
 * is a person's, even if something once started the app.
 *
 * Editors that merely contain a terminal (Cursor, Windsurf, VS Code) are NOT
 * agents here: a person typing in an editor's terminal is a person.
 */

export interface ProcessInfo {
  pid: number;
  ppid: number;
  /** Executable name or path as the OS reports it. */
  name: string;
  /** The full command line, when the OS gives it. */
  cmdline: string;
}

/** Executable names (without extension) of agent command-line tools. */
const AGENT_EXECUTABLES = new Map<string, string>([
  ["claude", "Claude Code"],
  ["claude-code", "Claude Code"],
  ["codex", "Codex"],
  ["gemini", "Gemini CLI"],
  ["gemini-cli", "Gemini CLI"],
  ["copilot", "GitHub Copilot CLI"],
  ["gh-copilot", "GitHub Copilot CLI"],
  ["opencode", "OpenCode"],
  ["opencode-ai", "OpenCode"],
  ["aider", "Aider"],
  ["aider-chat", "Aider"],
  ["cline", "Cline"],
  ["cursor-agent", "Cursor Agent"],
  ["cursor-cli", "Cursor Agent"],
  ["agy", "Antigravity"],
]);

/** npm packages the agents above ship as; they run under `node`, so the name alone is just "node". */
const AGENT_PACKAGES: Array<[string, string]> = [
  ["@anthropic-ai/claude-code", "Claude Code"],
  ["@openai/codex", "Codex"],
  ["@google/gemini-cli", "Gemini CLI"],
  ["@github/copilot", "GitHub Copilot CLI"],
  ["opencode-ai", "OpenCode"],
  ["aider-chat", "Aider"],
];

/** The Kai desktop app's own process names: the walk stops here. */
const KAI_APP_NAMES = new Set(["kai", "kai-terminal", "cross-platform-terminal-backend"]);

function baseName(name: string): string {
  const last = name.replace(/\\/g, "/").split("/").pop() ?? name;
  return last.replace(/\.(exe|cmd|bat|js|mjs|cjs)$/i, "").toLowerCase();
}

/** The agent this process is, or null. */
export function matchAgentProcess(p: Pick<ProcessInfo, "name" | "cmdline">): string | null {
  const byName = AGENT_EXECUTABLES.get(baseName(p.name));
  if (byName) return byName;
  const cmd = p.cmdline.replace(/\\/g, "/").toLowerCase();
  for (const [pkg, label] of AGENT_PACKAGES) {
    if (cmd.includes(`/node_modules/${pkg}/`) || cmd.includes(`/${pkg}/`)) return label;
  }
  return null;
}

/** True for the Kai desktop app (never the Node `kai` CLI, which runs as `node`). */
export function isKaiApp(p: Pick<ProcessInfo, "name">): boolean {
  return KAI_APP_NAMES.has(baseName(p.name));
}

/**
 * The agent among a process and its ancestors (this process first), or null.
 * Stops at the Kai desktop app.
 */
export function agentInChain(chain: readonly ProcessInfo[]): string | null {
  for (const p of chain) {
    if (isKaiApp(p)) return null;
    const agent = matchAgentProcess(p);
    if (agent) return agent;
  }
  return null;
}

const MAX_DEPTH = 24;

/** Follow parents through a whole process table, starting at `startPid`. */
export function chainFromTable(table: readonly ProcessInfo[], startPid: number): ProcessInfo[] {
  const byPid = new Map(table.map((p) => [p.pid, p]));
  const chain: ProcessInfo[] = [];
  const seen = new Set<number>();
  let pid = startPid;
  while (pid > 0 && !seen.has(pid) && chain.length < MAX_DEPTH) {
    seen.add(pid);
    const p = byPid.get(pid);
    if (!p) break;
    chain.push(p);
    pid = p.ppid;
  }
  return chain;
}

// ---------------------------------------------------------------------------
// Reading the process table, per platform
// ---------------------------------------------------------------------------

export type Exec = (
  command: string,
  args: string[],
  env?: NodeJS.ProcessEnv
) => Promise<string | null>;

const LIST_TIMEOUT_MS = 6000;

export const execText: Exec = (command, args, env) =>
  new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        encoding: "utf8",
        env: env ?? process.env,
        windowsHide: true,
        timeout: LIST_TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024,
      },
      (err, stdout) => resolve(err ? null : String(stdout))
    );
  });

/** Windows: one query for every process (id, parent, name, command line). */
export function parseWindowsProcesses(json: string): ProcessInfo[] {
  const parsed: unknown = JSON.parse(json);
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const out: ProcessInfo[] = [];
  for (const r of rows) {
    const o = (typeof r === "object" && r !== null ? r : {}) as Record<string, unknown>;
    const pid = Number(o.ProcessId);
    if (!Number.isInteger(pid)) continue;
    out.push({
      pid,
      ppid: Number(o.ParentProcessId) || 0,
      name: typeof o.Name === "string" ? o.Name : "",
      cmdline: typeof o.CommandLine === "string" ? o.CommandLine : "",
    });
  }
  return out;
}

/** macOS: `ps -axo pid=,ppid=,comm=` (name may contain spaces) merged with `ps -axo pid=,args=`. */
export function parsePsTable(comm: string, args: string): ProcessInfo[] {
  const cmdByPid = new Map<number, string>();
  for (const line of args.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (m) cmdByPid.set(Number(m[1]), m[2]);
  }
  const out: ProcessInfo[] = [];
  for (const line of comm.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    out.push({ pid, ppid: Number(m[2]), name: m[3].trim(), cmdline: cmdByPid.get(pid) ?? "" });
  }
  return out;
}

/** Linux: parent and name from `/proc/<pid>/stat` (the name sits in parentheses and may contain any character). */
export function parseProcStat(stat: string): { ppid: number; name: string } | null {
  const open = stat.indexOf("(");
  const close = stat.lastIndexOf(")");
  if (open < 0 || close < open) return null;
  const rest = stat
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  const ppid = Number(rest[1]);
  return Number.isInteger(ppid) ? { ppid, name: stat.slice(open + 1, close) } : null;
}

function linuxChain(startPid: number): ProcessInfo[] {
  const chain: ProcessInfo[] = [];
  const seen = new Set<number>();
  let pid = startPid;
  while (pid > 0 && !seen.has(pid) && chain.length < MAX_DEPTH) {
    seen.add(pid);
    let stat: { ppid: number; name: string } | null;
    let cmdline = "";
    try {
      stat = parseProcStat(fs.readFileSync(`/proc/${pid}/stat`, "utf8"));
      cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ").trim();
    } catch {
      break;
    }
    if (!stat) break;
    chain.push({ pid, ppid: stat.ppid, name: stat.name, cmdline });
    pid = stat.ppid;
  }
  return chain;
}

export interface ProcessDeps {
  platform?: NodeJS.Platform;
  pid?: number;
  exec?: Exec;
}

/**
 * This process and its ancestors, or null when the process list cannot be read
 * (the caller then does not block: see `detectAgentSession`).
 */
export async function ancestorChain(deps: ProcessDeps = {}): Promise<ProcessInfo[] | null> {
  const platform = deps.platform ?? process.platform;
  const pid = deps.pid ?? process.pid;
  const exec = deps.exec ?? execText;
  try {
    if (platform === "win32") {
      const out = await exec(
        "powershell",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);Get-CimInstance Win32_Process|Select-Object ProcessId,ParentProcessId,Name,CommandLine|ConvertTo-Json -Compress",
        ],
        windowsPowerShellEnv()
      );
      return out ? chainFromTable(parseWindowsProcesses(out), pid) : null;
    }
    if (platform === "darwin") {
      const [comm, args] = await Promise.all([
        exec("ps", ["-axo", "pid=,ppid=,comm="]),
        exec("ps", ["-axo", "pid=,args="]),
      ]);
      return comm ? chainFromTable(parsePsTable(comm, args ?? ""), pid) : null;
    }
    if (fs.existsSync("/proc/self/stat")) {
      const chain = linuxChain(pid);
      return chain.length > 0 ? chain : null;
    }
    const [comm, args] = await Promise.all([
      exec("ps", ["-axo", "pid=,ppid=,comm="]),
      exec("ps", ["-axo", "pid=,args="]),
    ]);
    return comm ? chainFromTable(parsePsTable(comm, args ?? ""), pid) : null;
  } catch {
    return null;
  }
}
