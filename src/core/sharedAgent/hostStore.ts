/**
 * What the host remembers between runs: which agents it shares, the PCs that
 * joined (each with its public key only: nothing here lets anyone pose as a
 * PC or as the host) and their usage. The host's private identity key lives in
 * the OS secret store, and invite secrets only in memory.
 *
 * Whether sharing is ON is deliberately not stored: a LAN listener is opened
 * only when a person turns it on in this session, so restarting Kai always
 * leaves the PC private.
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { getKaiHomeDir, atomicWriteJson } from "../registry";
import { parsePublicUrl } from "./invite";
import {
  DEFAULT_SHARE_PORT,
  defaultGrants,
  emptyUsage,
  MODEL_RE,
  parseSharePort,
  type AgentUse,
  type DeviceGrants,
  type DeviceTask,
  type SharedAgentId,
  type UsageTotals,
} from "./types";

export type DeviceStatus = "approved" | "revoked";

export interface InviteRecord {
  id: string;
  /** Lookup tag derived from the secret (`inviteMaterial`). The secret itself is never stored. */
  tag: string;
  status: "open" | "used" | "cancelled" | "expired";
  createdMs: number;
  createdAt: string;
  /** 0 = no time limit: open until used, cancelled or sharing is turned off. */
  ttlSeconds: number;
  usedAt?: string;
  deviceId?: string;
}

export interface DeviceRecord {
  id: string;
  name: string;
  platform: string;
  ip: string;
  /**
   * The subnet it paired from, or "tunnel" if it paired over the internet;
   * requests from anywhere else are refused.
   */
  network: string;
  status: DeviceStatus;
  /** The PC's X25519 public key (base64url): it must prove it holds the private half on every session. */
  publicKey: string;
  createdAt: string;
  lastSeen: string;
  lastSeenMs: number;
  usage: UsageTotals;
  /** Missing on rows saved before per-PC permissions existed: read through {@link grantsOf}. */
  grants?: DeviceGrants;
  usageByAgent?: Partial<Record<SharedAgentId, UsageTotals>>;
  lastUsedAt?: string;
  /** Oldest first, at most {@link MAX_TASKS_PER_DEVICE}. */
  tasks?: DeviceTask[];
  /** Tokens used per agent on one day (host's local date), for the daily limits. */
  daily?: { day: string; tokens: Partial<Record<SharedAgentId, number>> };
}

/** A PC's permissions, with defaults for anything missing (older files, new agents). */
export function grantsOf(device: Pick<DeviceRecord, "grants">): DeviceGrants {
  const base = defaultGrants();
  const g = device.grants;
  if (!g) return base;
  return {
    agents: { ...base.agents, ...g.agents },
    models: { ...g.models },
    maxMinutes: g.maxMinutes || base.maxMinutes,
    ...(g.limits ? { limits: { ...g.limits } } : {}),
  };
}

/** The host's local date, `YYYY-MM-DD`: the day daily limits count in. */
export function localDay(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

const HOUR_MS = 3_600_000;

/** What a PC has used of one agent: tokens today, and requests started in the last hour. */
export function agentUseOf(
  device: Pick<DeviceRecord, "daily" | "tasks">,
  agent: SharedAgentId,
  now = Date.now()
): AgentUse {
  const tokens =
    device.daily?.day === localDay(new Date(now)) ? (device.daily.tokens[agent] ?? 0) : 0;
  const lastHour = (device.tasks ?? []).filter(
    (t) => t.agent === agent && now - new Date(t.startedAt).getTime() < HOUR_MS
  ).length;
  return { tokens, lastHour };
}

export interface SessionRecord {
  id: string;
  deviceId: string;
  agent: SharedAgentId;
  /** The agent's own session id, used to resume the conversation. */
  agentSessionId?: string;
  updatedAt: string;
}

export interface HostFile {
  version: 1;
  /** Host-wide switch and model per agent (model absent = the agent's default). */
  agents: Partial<Record<SharedAgentId, { enabled: boolean; model?: string }>>;
  invites: Record<string, InviteRecord>;
  devices: Record<string, DeviceRecord>;
  sessions: Record<string, SessionRecord>;
  /**
   * The internet (tunnel) address, e.g. `https://my-pc.example.com`. While set
   * and sharing is on, PCs may also join and connect through it. Absent = LAN only.
   */
  publicUrl?: string;
  /** The port sharing listens on (absent = {@link DEFAULT_SHARE_PORT}). */
  port?: number;
}

export const sharedAgentDir = (): string => path.join(getKaiHomeDir(), "shared-agent");

const blank = (): HostFile => ({ version: 1, agents: {}, invites: {}, devices: {}, sessions: {} });

export const digest = (value: string): string =>
  crypto.createHash("sha256").update(value, "utf8").digest("hex");

/** Constant-time compare of two hex digests. */
export function sameDigest(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export class HostStore {
  private data: HostFile;

  constructor(readonly file: string = path.join(sharedAgentDir(), "host.json")) {
    this.data = this.load();
  }

  private load(): HostFile {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8")) as Partial<HostFile>;
      if (parsed && parsed.version === 1) {
        const devices = parsed.devices ?? {};
        for (const d of Object.values(devices)) {
          // Joined with a bearer token, before end-to-end encryption: it must join again.
          if (typeof d.publicKey !== "string" || !d.publicKey) {
            d.publicKey = "";
            d.status = "revoked";
          }
          delete (d as { tokenHash?: unknown }).tokenHash;
        }
        const invites = parsed.invites ?? {};
        for (const [id, inv] of Object.entries(invites)) {
          if (typeof inv.tag !== "string") delete invites[id]; // old hash-only invite
        }
        return {
          ...blank(),
          ...parsed,
          agents: parsed.agents ?? {},
          invites,
          devices,
          sessions: parsed.sessions ?? {},
        };
      }
    } catch {
      // Missing or unreadable: start clean (nothing here is irreplaceable).
    }
    return blank();
  }

  read<T>(fn: (data: HostFile) => T): T {
    return fn(this.data);
  }

  /** Mutate and persist atomically. */
  write<T>(fn: (data: HostFile) => T): T {
    const result = fn(this.data);
    this.save();
    return result;
  }

  save(): void {
    atomicWriteJson(this.file, this.data);
  }

  get publicUrl(): string | null {
    // A hand-edited file can't widen what is served: re-validate on every read.
    return this.data.publicUrl ? parsePublicUrl(this.data.publicUrl) : null;
  }

  setPublicUrl(url: string | null): void {
    if (url) this.data.publicUrl = url;
    else delete this.data.publicUrl;
    this.save();
  }

  get port(): number {
    return parseSharePort(this.data.port) ?? DEFAULT_SHARE_PORT;
  }

  setPort(port: number): void {
    if (port === DEFAULT_SHARE_PORT) delete this.data.port;
    else this.data.port = port;
    this.save();
  }

  agentEnabled(agent: SharedAgentId): boolean {
    return this.data.agents[agent]?.enabled ?? true;
  }

  /** The model every PC uses with this agent, or "" for the agent's default. */
  agentModel(agent: SharedAgentId): string {
    // A hand-edited file can't put a flag on the command line: re-validate on every read.
    const m = this.data.agents[agent]?.model ?? "";
    return MODEL_RE.test(m) ? m : "";
  }
}

/** True once a timed invite has run out. An invite with no time limit never does. */
export const inviteExpired = (inv: Pick<InviteRecord, "createdMs" | "ttlSeconds">, now: number) =>
  inv.ttlSeconds > 0 && now - inv.createdMs > inv.ttlSeconds * 1000;

export const newDeviceUsage = (): UsageTotals => emptyUsage();
