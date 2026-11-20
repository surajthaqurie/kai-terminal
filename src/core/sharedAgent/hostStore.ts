/**
 * What the host remembers between runs: which agents it shares, the PCs that
 * joined (each with a hash of its token, never the token) and their usage.
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
  defaultGrants,
  emptyUsage,
  type DeviceGrants,
  type DeviceTask,
  type SharedAgentId,
  type UsageTotals,
} from "./types";

export type DeviceStatus = "approved" | "revoked";

export interface InviteRecord {
  id: string;
  keyHash: string;
  status: "open" | "used" | "cancelled" | "expired";
  createdMs: number;
  createdAt: string;
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
  tokenHash: string;
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
  };
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
  agents: Partial<Record<SharedAgentId, { enabled: boolean }>>;
  invites: Record<string, InviteRecord>;
  devices: Record<string, DeviceRecord>;
  sessions: Record<string, SessionRecord>;
  /**
   * The internet (tunnel) address, e.g. `https://my-pc.example.com`. While set
   * and sharing is on, PCs may also join and connect through it. Absent = LAN only.
   */
  publicUrl?: string;
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
        return {
          ...blank(),
          ...parsed,
          agents: parsed.agents ?? {},
          invites: parsed.invites ?? {},
          devices: parsed.devices ?? {},
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

  agentEnabled(agent: SharedAgentId): boolean {
    return this.data.agents[agent]?.enabled ?? true;
  }
}

export const newDeviceUsage = (): UsageTotals => emptyUsage();
