import { IntegrationError } from "../integrations/types";
import { agentInChain, ancestorChain, type ProcessInfo } from "./agentProcess";

/**
 * Your Teams sign-in is yours, not your AI agent's.
 *
 * Kai never puts a Teams token in an environment variable, a file inside a
 * project, an agent's config or the MCP server, and `kai teams` has no
 * scripted command an agent could use to read or post as you. This guard adds
 * the last layer: a Teams command refuses to run when an AI agent is running it.
 *
 * Three ways to tell, strongest first:
 * - the PROCESS TREE: some parent of this command is a known agent CLI (Claude
 *   Code, Codex, Gemini, Copilot, OpenCode, Aider, Cline, ...), however the
 *   agent was started and whether or not it sets any variable;
 * - ENVIRONMENT markers: `KAI_AGENT_SESSION` (set by Kai on every agent it
 *   starts) and the variables other agents set on the commands they run;
 *   these also survive when the process tree is broken (an agent whose shell was
 *   started through a launcher that has since exited cannot be seen from the tree);
 * - the chat itself needs a person at an interactive terminal.
 *
 * If the process list cannot be read (a locked-down machine), the check lets
 * the command through rather than lock you out; the other two still apply.
 */
/**
 * `KAI_AGENT_SESSION` is Kai's own. The rest are the variables the agents' command
 * shells are documented to set; the list is best effort and the process tree is
 * the backstop for agents that set none.
 */
const AGENT_MARKERS = [
  "KAI_AGENT_SESSION",
  "CLAUDECODE",
  "GEMINI_CLI",
  "OPENCODE",
  "CURSOR_AGENT",
  "CODEX_SANDBOX_NETWORK_DISABLED",
] as const;

export type AgentDetection = { by: "environment" | "process"; agent: string };

/** The environment variable that says an AI agent is running this command, or null. */
export function agentSessionMarker(env: NodeJS.ProcessEnv = process.env): string | null {
  for (const name of AGENT_MARKERS) {
    const v = env[name];
    if (v !== undefined && v !== "" && v !== "0") return name;
  }
  return null;
}

export interface GuardDeps {
  /** Test seam: this process and its ancestors (default: read from the OS). */
  processes?: () => Promise<ProcessInfo[] | null>;
}

/** Whether an AI agent is running this command, and how we know. */
export async function detectAgentSession(
  env: NodeJS.ProcessEnv = process.env,
  deps: GuardDeps = {}
): Promise<AgentDetection | null> {
  const marker = agentSessionMarker(env);
  if (marker) return { by: "environment", agent: marker };
  let chain: ProcessInfo[] | null = null;
  try {
    chain = await (deps.processes ?? ancestorChain)();
  } catch {
    chain = null;
  }
  const agent = chain ? agentInChain(chain) : null;
  return agent ? { by: "process", agent } : null;
}

/** What to tell a caller that an AI agent's session is not allowed to do something. */
export interface AgentRefusal {
  /** The thing that is not available, as a sentence subject: "Microsoft Teams". */
  what: string;
  /** What the person should do instead. */
  hint: string;
}

/** Throws a `forbidden` error when an AI agent is running this command. */
export async function assertNotAgentSessionFor(
  refusal: AgentRefusal,
  env: NodeJS.ProcessEnv = process.env,
  deps: GuardDeps = {}
): Promise<void> {
  const found = await detectAgentSession(env, deps);
  if (!found) return;
  throw new IntegrationError(
    "forbidden",
    found.by === "process"
      ? `${refusal.what} is not available inside an AI agent's session (${found.agent} is running this command).`
      : `${refusal.what} is not available inside an AI agent's session.`,
    refusal.hint
  );
}

/** Refuse to touch the Teams account from inside an AI agent's session. */
export function assertNotAgentSession(
  env: NodeJS.ProcessEnv = process.env,
  deps: GuardDeps = {}
): Promise<void> {
  return assertNotAgentSessionFor(
    {
      what: "Microsoft Teams",
      hint: "Your Teams sign-in is private to you. Open a normal terminal tab and run `kai teams` yourself.",
    },
    env,
    deps
  );
}

/** Environment for an agent Kai starts: marks it as an agent session. */
export function agentEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...base, KAI_AGENT_SESSION: "1" };
}
