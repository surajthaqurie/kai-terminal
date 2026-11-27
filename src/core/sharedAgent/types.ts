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
 * Both ends must be Kai Terminal: every call carries {@link KAI_CLIENT_HEADER}
 * and every reply {@link KAI_SERVICE_HEADER}, and each side refuses the other
 * without it. (The wire shape grew out of Agent Bridge's, but Agent Bridge PCs
 * and other HTTP clients are refused.) The headers are a product boundary, not
 * an authentication step: invites and device tokens are what keep strangers out.
 */

/** What a Kai host and a Kai client call themselves on the wire. */
export const KAI_SERVICE = "kai-terminal";
/** Sent by a Kai client on every call to a host. Value: {@link KAI_SERVICE}. */
export const KAI_CLIENT_HEADER = "x-kai-client";
/** Sent by a Kai host on every reply. Value: {@link KAI_SERVICE}. */
export const KAI_SERVICE_HEADER = "x-kai-service";
/** Why a host refuses a caller that is not Kai Terminal. */
export const NOT_KAI_CLIENT =
  "Shared Agent only works between Kai Terminal PCs. Join from Kai Terminal.";

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

/** The port the host server listens on until the person picks another. */
export const DEFAULT_SHARE_PORT = 8765;
/** Lowest and highest port a person may choose (below 1024 needs admin rights). */
export const MIN_SHARE_PORT = 1024;
export const MAX_SHARE_PORT = 65535;

/** A valid share port, or null. Accepts a number or the text typed in the port box. */
export function parseSharePort(value: unknown): number | null {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\s*\d{1,5}\s*$/.test(value)
        ? Number(value)
        : NaN;
  return Number.isInteger(n) && n >= MIN_SHARE_PORT && n <= MAX_SHARE_PORT ? n : null;
}

/**
 * How long an invite link lives, in minutes. 0 = "until I turn it off": the
 * link stays valid until it is used, cancelled, or sharing is turned off.
 */
export const INVITE_MINUTES = [5, 15, 60, 0] as const;
export type InviteMinutes = (typeof INVITE_MINUTES)[number];
export const INVITE_UNTIL_OFF = 0;
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
  /**
   * The host's safety code ("K7QF-2M9D-XR4T"), from the identity key it proved
   * it holds. Matches the code on the host's Share screen. Empty for rows
   * joined before end-to-end encryption (they must join again).
   */
  safetyCode: string;
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
  /**
   * The model every PC's runs use with this agent, unless a PC has its own
   * (see {@link DeviceGrants.models}). Empty = the agent's own default.
   */
  model?: string;
}

/**
 * A coding CLI found on this PC that Kai cannot share yet, because it has no
 * non-interactive, read-only mode Kai can enforce. Listed so the person sees
 * every agent they have, and why some cannot be switched on.
 */
export interface ShareOtherCli {
  id: string;
  name: string;
  reason: string;
}

/** One address PCs can join through, with the network adapter it belongs to. */
export interface ShareAddress {
  url: string;
  /** The adapter's name, e.g. "Wi-Fi", "Ethernet" or "vEthernet (WSL)". */
  adapter: string;
  /** A virtual switch (WSL, Hyper-V, Docker…): other PCs usually can't reach it. */
  virtual: boolean;
}

export interface ShareInvite {
  id: string;
  createdAt: string;
  /** null = no time limit: valid until used, cancelled or sharing is turned off. */
  expiresInSeconds: number | null;
}

export type DeviceState = "connected" | "offline" | "disconnected";

/**
 * A model name that may be passed to an agent's command line. It must start with
 * a letter or digit, so it can never be read as a flag ("--auto", "-c").
 */
export const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/#@\-[\]]{0,99}$/;

/** Model names offered while typing; any name matching {@link MODEL_RE} may be entered. */
export const MODEL_SUGGESTIONS: Partial<Record<SharedAgentId, readonly string[]>> = {
  claude: ["sonnet", "opus", "haiku"],
};

/** Longest run a host can allow one PC, and the default. */
export const MAX_RUN_MINUTES_LIMIT = 240;
export const DEFAULT_RUN_MINUTES = 10;
/** Tasks kept per PC in its history (its totals keep counting past this). */
export const MAX_TASKS_PER_DEVICE = 100;

/** Bounds of the per-agent daily token limit a host can set for one PC. */
export const MIN_DAILY_TOKENS = 1_000;
export const MAX_DAILY_TOKENS = 100_000_000;
/**
 * Most requests per hour a host can allow one PC with one agent. The hour is
 * counted from the PC's task history, so it cannot exceed what that keeps.
 */
export const MAX_REQUESTS_PER_HOUR = MAX_TASKS_PER_DEVICE;

/** One agent's limits for one PC. */
export interface AgentLimits {
  /** A run is stopped after this many minutes (1 to {@link MAX_RUN_MINUTES_LIMIT}). */
  maxMinutes: number;
  /** Tokens the PC may use with this agent per day (host's local day). null = no limit. */
  dailyTokens: number | null;
  /** Requests the PC may start with this agent in any hour. null = no limit. */
  perHour: number | null;
}

/**
 * What one joined PC may do on this host. The host-wide agent switch still
 * applies on top: an agent turned off for everyone is off for every PC.
 */
export interface DeviceGrants {
  agents: Record<SharedAgentId, boolean>;
  /**
   * The model this PC's runs use, per agent. Empty / missing = the host-wide
   * model set for that agent ({@link ShareAgentRow.model}), else the agent's default.
   */
  models: Partial<Record<SharedAgentId, string>>;
  /**
   * The time limit for an agent with no row in {@link limits} (permissions saved
   * before limits were per agent). 1 to {@link MAX_RUN_MINUTES_LIMIT}.
   */
  maxMinutes: number;
  /** Each agent's own limits for this PC. Read through {@link limitsFor}. */
  limits?: Partial<Record<SharedAgentId, AgentLimits>>;
}

export const defaultGrants = (): DeviceGrants => ({
  agents: Object.fromEntries(SHARED_AGENT_IDS.map((id) => [id, true])) as Record<
    SharedAgentId,
    boolean
  >,
  models: {},
  maxMinutes: DEFAULT_RUN_MINUTES,
});

/** One agent's limits for a PC, with the PC-wide time limit for anything not set. */
export function limitsFor(grants: DeviceGrants, agent: SharedAgentId): AgentLimits {
  const row = grants.limits?.[agent];
  return {
    maxMinutes: row?.maxMinutes ?? grants.maxMinutes,
    dailyTokens: row?.dailyTokens ?? null,
    perHour: row?.perHour ?? null,
  };
}

/** What one PC has used of one agent: today's tokens and requests in the last hour. */
export interface AgentUse {
  tokens: number;
  lastHour: number;
}

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

  const limits = v.limits ?? {};
  if (!limits || typeof limits !== "object" || Array.isArray(limits)) {
    throw new GrantsError("Invalid agent limits.");
  }
  for (const [id, raw] of Object.entries(limits)) {
    if (!isSharedAgentId(id)) throw new GrantsError(`Unknown agent: ${id.slice(0, 40)}`);
    if (raw === null || raw === undefined) continue;
    if (typeof raw !== "object" || Array.isArray(raw)) {
      throw new GrantsError(`Invalid limits for ${SHARED_AGENT_NAMES[id]}.`);
    }
    (out.limits ??= {})[id] = parseAgentLimits(raw as Record<string, unknown>, id, minutes);
  }
  return out;
}

const isWhole = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n);

function parseAgentLimits(
  v: Record<string, unknown>,
  id: SharedAgentId,
  fallbackMinutes: number
): AgentLimits {
  const name = SHARED_AGENT_NAMES[id];
  const minutes = v.maxMinutes ?? fallbackMinutes;
  if (!isWhole(minutes) || minutes < 1 || minutes > MAX_RUN_MINUTES_LIMIT) {
    throw new GrantsError(`${name}: time limit must be 1 to ${MAX_RUN_MINUTES_LIMIT} minutes.`);
  }
  const daily = v.dailyTokens ?? null;
  if (daily !== null && (!isWhole(daily) || daily < MIN_DAILY_TOKENS || daily > MAX_DAILY_TOKENS)) {
    throw new GrantsError(
      `${name}: daily token limit must be ${MIN_DAILY_TOKENS.toLocaleString("en-US")} to ${MAX_DAILY_TOKENS.toLocaleString("en-US")}, or empty for no limit.`
    );
  }
  const perHour = v.perHour ?? null;
  if (perHour !== null && (!isWhole(perHour) || perHour < 1 || perHour > MAX_REQUESTS_PER_HOUR)) {
    throw new GrantsError(
      `${name}: requests per hour must be 1 to ${MAX_REQUESTS_PER_HOUR}, or empty for no limit.`
    );
  }
  return { maxMinutes: minutes, dailyTokens: daily, perHour };
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
  /** What it has used of each agent today and in the last hour (missing = older service). */
  today?: Partial<Record<SharedAgentId, AgentUse>>;
}

export interface ShareRun {
  id: string;
  deviceName: string;
  agent: SharedAgentId;
  startedAt: string;
}

export interface ShareStatus {
  enabled: boolean;
  /** The port sharing uses (the one listening now, or the next start's). */
  port: number;
  /** Present while the server is listening. `urls` are ranked: real network cards first. */
  listening: { port: number; urls: string[]; addresses?: ShareAddress[] } | null;
  /**
   * The internet (tunnel) address, e.g. `https://my-pc.example.com`. While set
   * (and sharing is on) PCs can also join through it. null = LAN only.
   */
  publicUrl: string | null;
  agents: ShareAgentRow[];
  /** Other coding CLIs installed here that cannot be shared (missing = none found / older service). */
  otherClis?: ShareOtherCli[];
  /** True while installed agents' versions are still being fetched (missing = older service). */
  agentsChecking?: boolean;
  invites: ShareInvite[];
  devices: ShareDevice[];
  runs: ShareRun[];
  /**
   * This host's safety code, present while sharing is on. A joined PC shows the
   * same code; reading them to each other proves no one is in between.
   */
  safetyCode: string | null;
}

export interface CreatedInvite {
  id: string;
  /** The full LAN link. Shown once: only a hash is kept. */
  link: string;
  /** The same invite through the internet address, when one is set. */
  internetLink?: string;
  /** null = no time limit (see {@link INVITE_UNTIL_OFF}). */
  expiresInSeconds: number | null;
}

/** Whether a port is free to share on. */
export interface PortCheck {
  port: number;
  available: boolean;
  /** True when it is taken by this PC's own sharing (so it is fine to keep). */
  ours: boolean;
  message: string;
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
  /** Turns sharing on or off; `port` (only while off) changes the port it listens on. */
  | { op: "share_set"; enabled: boolean; port?: number }
  /** Is this port free? (Tries to open it for a moment, then releases it.) */
  | { op: "port_check"; port: number }
  | { op: "share_agent"; agent: SharedAgentId; enabled: boolean }
  /** Sets (or with null / "", clears) the model every PC uses with this agent. */
  | { op: "share_agent_model"; agent: SharedAgentId; model: string | null }
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
  | { ok: true; hosts: JoinedHost[] }
  | { ok: true; host: JoinedHost }
  | { ok: true; chatId: string }
  | { ok: true; share: ShareStatus }
  | { ok: true; share: ShareStatus; invite: CreatedInvite }
  | { ok: true; history: DeviceHistory }
  | { ok: true; port: PortCheck }
  | { ok: false; error: SharedAgentErrorBody };

/** Things the service says without being asked (a line with an `event` key). */
export type SharedAgentEvent =
  | { event: "hosts"; hosts: JoinedHost[] }
  | { event: "share" }
  | { event: "chat"; chatId: string; kind: ChatEventKind; [key: string]: unknown }
  | { event: "service_exit" };

export type ChatEventKind =
  "route" | "session" | "text" | "delta" | "tool" | "tool_result" | "denied" | "log" | "end";
