/**
 * Runs a local coding agent in the background, read-only, and fans its output
 * out to whoever is watching (a remote PC polling the host server, or this
 * PC's own chat when it falls back to its own Claude).
 *
 * Rules every run follows:
 *  - The prompt goes to the agent on stdin, never on the command line, so a
 *    prompt can never be re-parsed as shell syntax (a `.cmd` shim included).
 *  - No shell is used. Windows `.cmd`/`.ps1` launchers are run through the same
 *    quoted, no-shell path Kai uses elsewhere (`resolveSpawnTarget`).
 *  - Every value that does reach argv (model, session id) is validated first.
 *  - The agent always runs in an empty folder, read-only. There is no setting
 *    that widens this: a shared agent cannot read or change files.
 */
import { spawn, execFile, type ChildProcess } from "child_process";
import crypto from "crypto";
import fs from "fs";
import { AGENT_REGISTRY, findBinaryOnPath } from "../agents";
import { resolveSpawnTarget, type SpawnTarget } from "../codeModeWorkflow";
import {
  clip,
  newParseState,
  parserFor,
  toWireTokens,
  type EventBody,
  type ParseState,
} from "./events";
import {
  DEFAULT_RUN_MINUTES,
  MODEL_RE,
  SHARED_AGENT_NAMES,
  isSharedAgentId,
  type ShareOtherCli,
  type SharedAgentId,
  type TokenTotals,
  type UsageTotals,
} from "./types";

const CLAUDE_SESSION_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPENCODE_SESSION_RE = /^ses_[A-Za-z0-9]{6,80}$/;
const SESSION_RES: Record<SharedAgentId, RegExp> = {
  claude: CLAUDE_SESSION_RE,
  opencode: OPENCODE_SESSION_RE,
};

const MAX_EVENTS_PER_RUN = 4000;
/** Room kept for whole blocks, tools and the end once partial text stops being recorded. */
const DELTA_HEADROOM = 600;
const KEEP_FINISHED_RUNS = 40;

export class AgentError extends Error {}

/** Finds the agent's real launcher. Injectable so tests run a stand-in. */
export type AgentLocator = (agent: SharedAgentId) => string[];

export const defaultLocator: AgentLocator = (agent) => {
  const def = AGENT_REGISTRY.find((a) => a.id === agent);
  for (const bin of def?.binaries ?? [agent]) {
    const found = findBinaryOnPath(bin);
    if (found) return [found];
  }
  throw new AgentError(`${SHARED_AGENT_NAMES[agent]} was not found on this PC.`);
};

/** argv (after the launcher) and extra environment for a read-only, non-interactive run. */
export function buildCommand(
  agent: SharedAgentId,
  opts: { resume?: string | null; model?: string | null } = {}
): { args: string[]; env: Record<string, string> } {
  const { resume, model } = opts;
  if (model && !MODEL_RE.test(model)) throw new AgentError("Model name has invalid characters.");
  if (resume && !SESSION_RES[agent].test(resume)) throw new AgentError("Invalid agent session id.");
  if (agent === "claude") {
    const args = [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--permission-prompts",
      "none",
      "--permission-mode",
      "dontAsk",
      "--restricted",
      // Chat only: no built-in tools at all (the run folder is empty anyway).
      "--tools=", // one argument: an empty argv entry is fragile through Windows launchers
      // None of the host user's CLAUDE.md, skills, plugins, hooks, custom commands
      // or agents: a remote PC must not read or trigger them.
      "--safe-mode",
      "--disable-slash-commands",
      "--strict-mcp-config", // no MCP servers / connectors
    ];
    if (model) args.push("--model", model);
    if (resume) args.push("--resume", resume);
    return { args, env: {} };
  }
  // OpenCode: the read-only "plan" agent with every permission denied, globally and
  // on the agent itself (an agent-level rule in the user's config would otherwise win).
  // That covers MCP servers from the user's global config too: their tools are refused.
  // --standalone gives each run a private server, so this config applies.
  const args = ["run", "--standalone", "--format", "json", "--agent", "plan"];
  if (model) args.push("--model", model);
  if (resume) args.push("--session", resume);
  const deny = {
    "*": "deny",
    edit: "deny",
    write: "deny",
    bash: "deny",
    webfetch: "deny",
    websearch: "deny",
    read: "deny",
    task: "deny",
    skill: "deny",
    external_directory: "deny",
  };
  const config = { permission: deny, agent: { plan: { permission: deny } } };
  return { args, env: { OPENCODE_CONFIG_CONTENT: JSON.stringify(config) } };
}

function childEnv(extra: Record<string, string>, cwd: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  // Some agents take their project folder from $PWD rather than the real cwd.
  env.PWD = cwd;
  delete env.INIT_CWD;
  delete env.OLDPWD;
  return env;
}

function target(base: string[], args: string[]): SpawnTarget {
  const [command, ...lead] = base;
  return resolveSpawnTarget(command, [...lead, ...args]);
}

export interface AgentProbe {
  id: SharedAgentId;
  name: string;
  available: boolean;
  version: string;
  error: string;
}

/** Is the agent installed, and which version? Bounded, no shell, no network. */
export async function probeAgent(
  agent: SharedAgentId,
  locate: AgentLocator = defaultLocator
): Promise<AgentProbe> {
  const info: AgentProbe = {
    id: agent,
    name: SHARED_AGENT_NAMES[agent],
    available: false,
    version: "",
    error: "",
  };
  let base: string[];
  try {
    base = locate(agent);
  } catch (e) {
    info.error = e instanceof Error ? e.message : String(e);
    return info;
  }
  info.available = true;
  try {
    const t = target(base, ["--version"]);
    info.version = await new Promise<string>((resolve) => {
      execFile(
        t.command,
        t.args,
        {
          timeout: 8000,
          windowsHide: true,
          windowsVerbatimArguments: t.windowsVerbatimArguments,
          maxBuffer: 64 * 1024,
        },
        (_err, stdout, stderr) =>
          resolve(
            String(stdout || stderr || "")
              .trim()
              .slice(0, 80)
          )
      );
    });
  } catch {
    // A version probe that cannot run does not make the agent unavailable.
  }
  return info;
}

/**
 * Why a CLI agent found on this PC cannot be shared. Each one was checked:
 * sharing needs a non-interactive mode that reads the prompt from stdin and
 * can be held to read-only. Anything new in the registry gets the default.
 */
const NOT_SHAREABLE_REASONS: Record<string, string> = {
  agy: "Its print mode still lets it edit files and run commands, so it can't be held to read-only.",
  aider: "It edits files by design and has no read-only, machine-readable mode.",
};
const DEFAULT_NOT_SHAREABLE =
  "Kai has no verified read-only mode for it yet, so it can't be shared.";

/** Detects every other coding CLI on this PC, from the shared agent registry. Injectable for tests. */
export type OtherCliDetector = () => ShareOtherCli[];

export const detectOtherClis: OtherCliDetector = () =>
  AGENT_REGISTRY.filter((def) => def.kind === "cli" && !isSharedAgentId(def.id)).flatMap((def) =>
    def.binaries.some((bin) => findBinaryOnPath(bin))
      ? [
          {
            id: def.id,
            name: def.name,
            reason: NOT_SHAREABLE_REASONS[def.id] ?? DEFAULT_NOT_SHAREABLE,
          },
        ]
      : []
  );

function killTree(proc: ChildProcess): void {
  if (proc.exitCode !== null || proc.pid === undefined) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/PID", String(proc.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    return;
  }
  try {
    process.kill(-proc.pid, "SIGKILL"); // the whole process group
  } catch {
    proc.kill("SIGKILL");
  }
}

export type RunStatus = "starting" | "running" | "completed" | "failed" | "stopped" | "timeout";

export interface RunEvent {
  seq: number;
  t: number;
  type: string;
  [key: string]: unknown;
}

export interface RunInit {
  agent: SharedAgentId;
  prompt: string;
  cwd: string;
  /** Who asked (a remote PC, or "local" for this PC's own fallback). */
  deviceId: string;
  deviceName: string;
  resume?: string | null;
  model?: string | null;
  maxMinutes?: number;
  /** The host's conversation record this run belongs to (set by the host server). */
  sessionKey?: string;
}

export class Run {
  readonly id = crypto.randomBytes(9).toString("base64url");
  readonly createdMs = Date.now();
  readonly startedAt = new Date().toISOString();
  endedAt = "";
  status: RunStatus = "starting";
  exitCode: number | null = null;
  readonly events: RunEvent[] = [];
  readonly state: ParseState = newParseState();
  stopReason = "";
  durationS = 0;
  proc: ChildProcess | null = null;
  private waiters = new Set<() => void>();

  constructor(readonly init: RunInit) {}

  get finished(): boolean {
    return this.status !== "starting" && this.status !== "running";
  }

  get tokens(): TokenTotals {
    return this.state.tokens;
  }

  emit(body: EventBody): void {
    // Partial text is a nicety: it never pushes out the real output near the cap.
    if (body.type === "delta" && this.events.length >= MAX_EVENTS_PER_RUN - DELTA_HEADROOM) return;
    let event = body;
    if (this.events.length >= MAX_EVENTS_PER_RUN && body.type !== "end") {
      if (this.events.length > MAX_EVENTS_PER_RUN) return;
      event = { type: "log", text: "Output limit reached; further output hidden." };
    }
    this.events.push({
      seq: this.events.length + 1,
      t: Math.round((Date.now() - this.createdMs) / 10) / 100,
      ...event,
    });
    this.wake();
  }

  private wake(): void {
    for (const w of [...this.waiters]) w();
  }

  /** Events with seq > `after`; waits up to `timeoutMs` when none are ready. */
  async wait(after: number, timeoutMs: number): Promise<{ events: RunEvent[]; finished: boolean }> {
    if (this.events.length <= after && !this.finished) {
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          this.waiters.delete(done);
          resolve();
        };
        const timer = setTimeout(done, timeoutMs);
        this.waiters.add(done);
      });
    }
    return { events: this.events.slice(after), finished: this.finished };
  }

  /** Waits until the run has ended. */
  async done(): Promise<void> {
    while (!this.finished) await this.wait(this.events.length, 1000);
  }

  summary() {
    return {
      id: this.id,
      deviceId: this.init.deviceId,
      deviceName: this.init.deviceName,
      agent: this.init.agent,
      status: this.status,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      costUsd: this.state.costUsd ?? null,
      tokens: { ...this.state.tokens },
      error: this.state.error ?? "",
    };
  }
}

export class RunRejected extends Error {}

export interface RunManagerOptions {
  maxConcurrent?: number;
  locate?: AgentLocator;
  /** Called once per finished run (the host server records usage here). */
  onFinish?: (run: Run) => void;
}

export class RunManager {
  private runs = new Map<string, Run>();
  private readonly maxConcurrent: number;
  private readonly locate: AgentLocator;
  private readonly onFinish?: (run: Run) => void;

  constructor(opts: RunManagerOptions = {}) {
    this.maxConcurrent = opts.maxConcurrent ?? 3;
    this.locate = opts.locate ?? defaultLocator;
    this.onFinish = opts.onFinish;
  }

  get(id: string): Run | undefined {
    return this.runs.get(id);
  }

  active(): Run[] {
    return [...this.runs.values()].filter((r) => !r.finished);
  }

  activeFor(deviceId: string): Run | undefined {
    return this.active().find((r) => r.init.deviceId === deviceId);
  }

  /** Starts a run. Throws {@link RunRejected} when busy, {@link AgentError} when it cannot start. */
  start(init: RunInit): Run {
    const live = this.active();
    if (live.some((r) => r.init.deviceId === init.deviceId)) {
      throw new RunRejected("This PC already has a task running. Stop it or wait.");
    }
    if (live.length >= this.maxConcurrent) {
      throw new RunRejected("The host is busy with other tasks. Try again shortly.");
    }
    const base = this.locate(init.agent);
    const { args, env } = buildCommand(init.agent, { resume: init.resume, model: init.model });
    const t = target(base, args);
    const run = new Run(init);
    this.runs.set(run.id, run);
    this.prune();
    this.execute(run, t, childEnv(env, init.cwd));
    return run;
  }

  stop(runId: string, reason = "stopped"): boolean {
    const run = this.runs.get(runId);
    if (!run || run.finished) return false;
    run.stopReason ||= reason;
    if (run.proc) killTree(run.proc);
    return true;
  }

  stopDevice(deviceId: string, reason: string): void {
    for (const run of this.active()) if (run.init.deviceId === deviceId) this.stop(run.id, reason);
  }

  stopAll(reason: string): void {
    for (const run of this.active()) this.stop(run.id, reason);
  }

  /** Waits (up to `timeoutMs`) for every live run to have really ended, so no agent process is left behind. */
  async settle(timeoutMs: number): Promise<void> {
    const live = this.active();
    if (!live.length) return;
    let timer: NodeJS.Timeout | undefined;
    const limit = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    });
    await Promise.race([Promise.all(live.map((r) => r.done())), limit]);
    clearTimeout(timer);
  }

  private prune(): void {
    const finished = [...this.runs.values()]
      .filter((r) => r.finished)
      .sort((a, b) => a.createdMs - b.createdMs);
    for (const old of finished.slice(0, Math.max(0, finished.length - KEEP_FINISHED_RUNS))) {
      this.runs.delete(old.id);
    }
  }

  private execute(run: Run, t: SpawnTarget, env: NodeJS.ProcessEnv): void {
    const { agent, prompt, cwd } = run.init;
    const parse = parserFor(agent);
    const stderrTail: string[] = [];
    let timer: NodeJS.Timeout | undefined;
    let settled = false;

    const finish = (status: RunStatus): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      run.durationS = Math.round((Date.now() - run.createdMs) / 100) / 10;
      run.endedAt = new Date().toISOString();
      run.status = status; // set before "end" so a watcher never sees finished without it
      run.emit({
        type: "end",
        status,
        exit_code: run.exitCode,
        error: run.state.error ?? "",
        cost_usd: run.state.costUsd ?? null,
        tokens: toWireTokens(run.state.tokens),
        duration_s: run.durationS,
      });
      try {
        this.onFinish?.(run);
      } catch {
        // Recording usage must never take the service down.
      }
    };

    let proc: ChildProcess;
    try {
      proc = spawn(t.command, t.args, {
        cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        windowsVerbatimArguments: t.windowsVerbatimArguments,
        detached: process.platform !== "win32",
      });
    } catch (e) {
      run.state.error = `Could not start ${SHARED_AGENT_NAMES[agent]}: ${(e as Error).message}`;
      finish("failed");
      return;
    }
    run.proc = proc;
    run.status = "running";
    run.emit({ type: "start", agent, agent_name: SHARED_AGENT_NAMES[agent], level: "read" });
    if (run.stopReason) killTree(proc);

    const maxMinutes = run.init.maxMinutes ?? DEFAULT_RUN_MINUTES;
    timer = setTimeout(() => this.stop(run.id, "timeout"), maxMinutes * 60_000);
    timer.unref?.();

    proc.on("error", (e) => {
      run.state.error = `Could not start ${SHARED_AGENT_NAMES[agent]}: ${e.message}`;
      finish("failed");
    });
    proc.stdin?.on("error", () => {}); // the agent may exit before reading everything
    proc.stdin?.end(prompt, "utf8");

    proc.stderr?.setEncoding("utf8");
    proc.stderr?.on("data", (chunk: string) => {
      stderrTail.push(...chunk.split("\n").filter(Boolean));
      stderrTail.splice(0, Math.max(0, stderrTail.length - 40));
    });

    let buffer = "";
    const handleLine = (raw: string): void => {
      const line = raw.trim();
      if (!line) return;
      let obj: unknown;
      try {
        obj = JSON.parse(line);
      } catch {
        run.emit({ type: "log", text: clip(line, 800) });
        return;
      }
      if (!obj || typeof obj !== "object" || Array.isArray(obj)) return;
      try {
        for (const event of parse(obj as Record<string, unknown>, run.state)) run.emit(event);
      } catch (e) {
        run.emit({ type: "log", text: `(unreadable event: ${(e as Error).message})` });
      }
    };
    proc.stdout?.setEncoding("utf8");
    proc.stdout?.on("data", (chunk: string) => {
      buffer += chunk;
      let nl = buffer.indexOf("\n");
      while (nl >= 0) {
        handleLine(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
        nl = buffer.indexOf("\n");
      }
    });

    proc.on("close", (code) => {
      if (buffer) handleLine(buffer);
      run.exitCode = code;
      if (run.stopReason === "timeout") {
        run.state.error = `Stopped after the ${maxMinutes}-minute limit`;
        finish("timeout");
      } else if (run.stopReason) {
        run.state.error ||= `Stopped (${run.stopReason})`;
        finish("stopped");
      } else if (code === 0 && run.state.ok !== false) {
        finish("completed");
      } else {
        run.state.error ||= clip(stderrTail.join("\n").trim() || `exit code ${code}`, 800);
        finish("failed");
      }
    });
  }
}

/** An empty folder owned by the app: where every shared / fallback chat runs. */
export function ensureChatDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function addUsage(usage: UsageTotals, run: Run): void {
  usage.runs += 1;
  usage.input += run.tokens.input;
  usage.output += run.tokens.output;
  usage.cacheRead += run.tokens.cacheRead;
  usage.cacheWrite += run.tokens.cacheWrite;
  usage.costUsd = Math.round((usage.costUsd + (run.state.costUsd ?? 0)) * 1e6) / 1e6;
}
