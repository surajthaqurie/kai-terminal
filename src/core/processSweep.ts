import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";

/**
 * Finding the processes a `kai run` command left behind, wherever they went.
 *
 * Killing a process group reaches every descendant that stayed in it. A descendant that detached
 * (`setsid`, a double fork, `nohup` from a daemonizing launcher) is in another group and, once its
 * parent exits, has no parent link to follow. What it cannot shed is its environment: every
 * process inherits it. Each run therefore gets a random token in its environment
 * (`KAI_RUN_TOKEN`), and on timeout or abort every process of this user that still carries that
 * token is signalled too. The token is a fresh random value, so no unrelated process can match.
 *
 * Reading other processes' environments exists on Linux (`/proc/<pid>/environ`) and macOS
 * (`ps -E`). Windows has no such interface, so there the sweep is not available and callers keep
 * reporting that descendants may survive.
 *
 * Limit: a program that deliberately starts a new process with a cleared environment (`env -i`)
 * drops the token and is not found.
 */
export const RUN_TOKEN_ENV = "KAI_RUN_TOKEN";

export function newRunToken(): string {
  return randomUUID();
}

/** True where the environments of other processes can be read, so a sweep can find escapees. */
export function sweepSupported(platform: string = process.platform): boolean {
  return platform === "linux" || platform === "darwin";
}

export interface SweepDeps {
  platform?: string;
  /** Names of the entries of `/proc`. */
  readProcDir?: () => string[];
  /** The raw bytes of `/proc/<pid>/environ`, or null when unreadable. */
  readEnviron?: (pid: number) => string | null;
  /** The text of `ps -axww -E -o pid=,command=`, or null when it could not run. */
  psWithEnvironment?: () => string | null;
  /** This process, never reported. */
  selfPid?: number;
}

function defaultReadProcDir(): string[] {
  try {
    return fs.readdirSync("/proc");
  } catch {
    return [];
  }
}

function defaultReadEnviron(pid: number): string | null {
  try {
    return fs.readFileSync(`/proc/${pid}/environ`, "latin1");
  } catch {
    return null; // exited meanwhile, or another user's process
  }
}

function defaultPs(): string | null {
  try {
    const r = spawnSync("ps", ["-axww", "-E", "-o", "pid=,command="], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      timeout: 5000,
    });
    return r.status === 0 && typeof r.stdout === "string" ? r.stdout : null;
  } catch {
    return null;
  }
}

/**
 * Ids of the processes, other than this one, whose environment carries `token`. An empty list on a
 * platform where the sweep is unavailable.
 */
export function findRunProcesses(token: string, deps: SweepDeps = {}): number[] {
  const platform = deps.platform ?? process.platform;
  const self = deps.selfPid ?? process.pid;
  if (!token || !sweepSupported(platform)) return [];
  const needle = `${RUN_TOKEN_ENV}=${token}`;
  const found: number[] = [];

  if (platform === "linux") {
    const names = (deps.readProcDir ?? defaultReadProcDir)();
    const read = deps.readEnviron ?? defaultReadEnviron;
    for (const name of names) {
      if (!/^\d+$/.test(name)) continue;
      const pid = Number(name);
      if (pid === self) continue;
      const env = read(pid);
      // Entries are NUL-separated; compare whole entries so a longer value cannot match.
      if (env !== null && env.split("\0").includes(needle)) found.push(pid);
    }
    return found;
  }

  // macOS: `ps -E` appends the environment to each command line.
  const text = (deps.psWithEnvironment ?? defaultPs)();
  if (text === null) return [];
  for (const line of text.split("\n")) {
    const m = /^\s*(\d+)\s(.*)$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    if (pid === self) continue;
    // Entries are space-separated here; the token must be a whole entry, not a prefix of a longer one.
    if ((m[2] + " ").includes(`${needle} `) && (" " + m[2]).includes(` ${needle}`)) found.push(pid);
  }
  return found;
}

/** Send `signal` to every process still carrying `token`; returns the ids it signalled. */
export function signalRunProcesses(
  token: string,
  signal: NodeJS.Signals,
  deps: SweepDeps & { kill?: (pid: number, signal: NodeJS.Signals) => void } = {}
): number[] {
  const kill = deps.kill ?? ((pid, sig) => process.kill(pid, sig));
  const signalled: number[] = [];
  for (const pid of findRunProcesses(token, deps)) {
    try {
      kill(pid, signal);
      signalled.push(pid);
    } catch {
      // Gone already, or not ours to signal.
    }
  }
  return signalled;
}
