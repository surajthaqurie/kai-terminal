/**
 * Shared Agent: contract between the desktop UI, the Node service and the
 * LAN wire protocol. Pure types and constants (no Node imports), so the React
 * panel can import them too.
 *
 * Two roles, one protocol:
 *  - RECEIVE: this PC joins another PC with a one-time invite link and chats
 *    with the agents that PC shares.
 *  - SHARE: this PC runs a small host server so other PCs can chat with its
 *    local agents (read-only, in an empty folder).
 * The wire protocol is the same one Agent Bridge (`lan-agent-hub`) speaks, so
 * a Kai PC and an Agent Bridge PC can use each other.
 */

/** The agents that can be shared. Both have a verified non-interactive, read-only mode. */
export const SHARED_AGENT_IDS = ["claude", "opencode"] as const;
export type SharedAgentId = (typeof SHARED_AGENT_IDS)[number];

export const SHARED_AGENT_NAMES: Record<SharedAgentId, string> = {
  claude: "Claude Code",
  opencode: "OpenCode",
};

export function isSharedAgentId(value: unknown): value is SharedAgentId {
  return typeof value === "string" && (SHARED_AGENT_IDS as readonly string[]).includes(value);
}

/** First port tried by the host server; the next nine are tried if it is taken. */
export const DEFAULT_SHARE_PORT = 8765;
export const INVITE_MINUTES = [5, 15, 60] as const;
export type InviteMinutes = (typeof INVITE_MINUTES)[number];
export const MAX_MESSAGE_CHARS = 20_000;

/*
 * Routing is fixed, not a setting: a chat goes to the joined PC's agent first,
 * and when that PC is offline, removed this PC, is busy or fails, this PC's own
 * agent answers instead, automatically. The chat says which one answered.
 */

export interface TokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface UsageTotals extends TokenTotals {
  runs: number;
  costUsd: number;
}

export const emptyTokens = (): TokenTotals => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
});
export const emptyUsage = (): UsageTotals => ({ ...emptyTokens(), runs: 0, costUsd: 0 });
export const totalTokens = (t: TokenTotals): number =>
  t.input + t.output + t.cacheRead + t.cacheWrite;

export type SharedAgentErrorCode =
  "bad_request" | "unreachable" | "removed" | "rejected" | "busy" | "unavailable" | "failed";

export interface SharedAgentErrorBody {
  code: SharedAgentErrorCode;
  message: string;
}

// ---------------------------------------------------------------------------
// RECEIVE side: PCs this PC has joined
// ---------------------------------------------------------------------------

export interface AgentView {
  id: SharedAgentId;
  name: string;
  available: boolean;
}

export interface JoinedHost {
  id: string;
  /** What the person calls it (defaults to the host's computer name). */
  name: string;
  hostName: string;
  /** "192.168.1.20:8765" on the LAN, "my-pc.example.com" over the internet. */
  address: string;
  /** True when this PC reaches the host through an internet (tunnel) link. */
  internet: boolean;
  connectedAt: string;
  /** False after the host removed this PC: a new invite link is needed. */
  connected: boolean;
  /** null until the first check has finished. */
  online: boolean | null;
  latencyMs: number | null;
  checkedAt: string | null;
  agents: AgentView[];
  /** Tokens this PC has used through that host (counted here, from the host's own reports). */
  usage: UsageTotals;
  message?: string;
}

// ---------------------------------------------------------------------------
// SHARE side: this PC as a host
// ---------------------------------------------------------------------------

export interface ShareAgentRow {
  id: SharedAgentId;
  name: string;
  available: boolean;
  version: string;
  error: string;
  enabled: boolean;
}

export interface ShareInvite {
  id: string;
  createdAt: string;
  expiresInSeconds: number;
}

export type DeviceState = "connected" | "offline" | "disconnected";

/** A model name that may be passed to an agent's command line. */
export const MODEL_RE = /^[A-Za-z0-9._:/#@\-[\]]{1,100}$/;

/** Longest run a host can allow one PC, and the default. */
export const MAX_RUN_MINUTES_LIMIT = 240;
export const DEFAULT_RUN_MINUTES = 10;
/** Tasks kept per PC in its history (its totals keep counting past this). */
export const MAX_TASKS_PER_DEVICE = 100;

/**
 * What one joined PC may do on this host. The host-wide agent switch still
 * applies on top: an agent turned off for everyone is off for every PC.
 */
export interface DeviceGrants {
  agents: Record<SharedAgentId, boolean>;
  /** The model this PC's runs use, per agent. Empty / missing = the agent's default. */
  models: Partial<Record<SharedAgentId, string>>;
  /** A run is stopped after this many minutes (1 to {@link MAX_RUN_MINUTES_LIMIT}). */
  maxMinutes: number;
}

export const defaultGrants = (): DeviceGrants => ({
  agents: { claude: true, opencode: true },
  models: {},
  maxMinutes: DEFAULT_RUN_MINUTES,
});

export class GrantsError extends Error {}

/** Validates permissions sent from the UI. Throws {@link GrantsError} with a readable reason. */
export function parseGrants(value: unknown): DeviceGrants {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new GrantsError("Permissions must be an object.");
  }
  const v = value as Record<string, unknown>;
  const out = defaultGrants();

  const agents = v.agents ?? {};
  if (!agents || typeof agents !== "object" || Array.isArray(agents)) {
    throw new GrantsError("Invalid agent list.");
  }
  for (const [id, on] of Object.entries(agents)) {
    if (!isSharedAgentId(id)) throw new GrantsError(`Unknown agent: ${id.slice(0, 40)}`);
    if (typeof on !== "boolean") throw new GrantsError(`Invalid setting for ${id}.`);
    out.agents[id] = on;
  }

  const models = v.models ?? {};
  if (!models || typeof models !== "object" || Array.isArray(models)) {
    throw new GrantsError("Invalid model list.");
  }
  for (const [id, raw] of Object.entries(models)) {
    if (!isSharedAgentId(id)) throw new GrantsError(`Unknown agent: ${id.slice(0, 40)}`);
    if (raw === null || raw === undefined) continue;
    if (typeof raw !== "string") throw new GrantsError(`Invalid model for ${id}.`);
    const model = raw.trim();
    if (!model) continue;
    if (!MODEL_RE.test(model)) {
      throw new GrantsError(`Model name for ${SHARED_AGENT_NAMES[id]} has invalid characters.`);
    }
    out.models[id] = model;
  }

  const minutes = v.maxMinutes ?? DEFAULT_RUN_MINUTES;
  if (
    typeof minutes !== "number" ||
    !Number.isInteger(minutes) ||
    minutes < 1 ||
    minutes > MAX_RUN_MINUTES_LIMIT
  ) {
    throw new GrantsError(`Time limit must be 1 to ${MAX_RUN_MINUTES_LIMIT} minutes.`);
  }
  out.maxMinutes = minutes;
  return out;
}

export type TaskStatus = "completed" | "failed" | "stopped" | "timeout";

/** One finished run, as the host remembers it. */
export interface DeviceTask {
  id: string;
  agent: SharedAgentId;
  model: string;
  /** The start of what the PC asked, whitespace collapsed (not the full prompt). */
  title: string;
  status: TaskStatus;
  startedAt: string;
  endedAt: string;
  durationS: number;
  tokens: TokenTotals;
  costUsd: number;
  error: string;
}

export interface DeviceHistory {
  deviceId: string;
  usage: UsageTotals;
  byAgent: Partial<Record<SharedAgentId, UsageTotals>>;
  lastUsedAt: string;
  /** Newest first. */
  tasks: DeviceTask[];
}

export interface ShareDevice {
  id: string;
  name: string;
  address: string;
  state: DeviceState;
  lastSeen: string;
  usage: UsageTotals;
  activeRunId: string | null;
  grants: DeviceGrants;
}

export interface ShareRun {
  id: string;
  deviceName: string;
  agent: SharedAgentId;
  startedAt: string;
}

export interface ShareStatus {
  enabled: boolean;
  /** Present while the server is listening. */
  listening: { port: number; urls: string[] } | null;
  /**
   * The internet (tunnel) address, e.g. `https://my-pc.example.com`. While set
   * (and sharing is on) PCs can also join through it. null = LAN only.
   */
  publicUrl: string | null;
  agents: ShareAgentRow[];
  invites: ShareInvite[];
  devices: ShareDevice[];
  runs: ShareRun[];
}

export interface CreatedInvite {
  id: string;
  /** The full LAN link. Shown once: only a hash is kept. */
  link: string;
  /** The same invite through the internet address, when one is set. */
  internetLink?: string;
  expiresInSeconds: number;
}

// ---------------------------------------------------------------------------
// RPC: one JSON object per line over the service's stdin / stdout
// ---------------------------------------------------------------------------

export type SharedAgentRequest =
  | { op: "ping" }
  | { op: "hosts_list"; refresh?: boolean }
  | { op: "host_join"; link: string; name?: string }
  | { op: "host_leave"; hostId: string }
  | {
      op: "chat_send";
      chatId: string;
      hostId: string | null;
      agent: SharedAgentId;
      message: string;
      session?: string | null;
    }
  | { op: "chat_stop"; chatId: string }
  | { op: "share_status"; refresh?: boolean }
  | { op: "share_set"; enabled: boolean }
  | { op: "share_agent"; agent: SharedAgentId; enabled: boolean }
  /** Sets (or with null, removes) the internet address PCs may join through. */
  | { op: "share_public_url"; url: string | null }
  | { op: "invite_create"; expiresMinutes: InviteMinutes }
  | { op: "invite_cancel"; id: string }
  | { op: "device_disconnect"; id: string }
  | { op: "device_remove"; id: string }
  | { op: "device_grants"; id: string; grants: DeviceGrants }
  | { op: "device_history"; id: string }
  | { op: "run_stop"; runId: string };

export type SharedAgentResponse =
  | { ok: true; pong?: true }
  | { ok: true; hosts: JoinedHost[]; ownAgents: AgentView[] }
  | { ok: true; host: JoinedHost }
  | { ok: true; chatId: string }
  | { ok: true; share: ShareStatus }
  | { ok: true; share: ShareStatus; invite: CreatedInvite }
  | { ok: true; history: DeviceHistory }
  | { ok: false; error: SharedAgentErrorBody };

/** Things the service says without being asked (a line with an `event` key). */
export type SharedAgentEvent =
  | { event: "hosts"; hosts: JoinedHost[] }
  | { event: "share" }
  | { event: "chat"; chatId: string; kind: ChatEventKind; [key: string]: unknown }
  | { event: "service_exit" };

export type ChatEventKind =
  "route" | "session" | "text" | "tool" | "tool_result" | "denied" | "log" | "end";
