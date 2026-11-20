/**
 * The receiving side: the PCs this PC has joined, and calls to their host
 * servers (Kai or Agent Bridge, same protocol).
 *
 * The list lives in `~/.kai/shared-agent/hosts.json`. Each host's bearer token
 * goes to the OS secret store, never into that file. Only private-network
 * IPv4 hosts over HTTP, or public tunnel hosts over HTTPS, are ever contacted,
 * and redirects are never followed.
 */
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import type { SecretStore } from "../integrations/secretStore";
import { atomicWriteJson } from "../registry";
import { sharedAgentDir } from "./hostStore";
import { allowedOrigin, type InviteTarget } from "./invite";
import {
  emptyUsage,
  isSharedAgentId,
  SHARED_AGENT_NAMES,
  type AgentView,
  type SharedAgentErrorCode,
  type SharedAgentId,
  type TokenTotals,
  type UsageTotals,
} from "./types";

export class ClientError extends Error {
  constructor(
    readonly code: SharedAgentErrorCode,
    message: string
  ) {
    super(message);
  }
}

export interface HostRecord {
  id: string;
  name: string;
  /** e.g. `http://192.168.1.20:8765` (LAN) or `https://my-pc.example.com` (internet). */
  origin: string;
  hostName: string;
  connectedAt: string;
  /** False once the host removed this PC (its token no longer works). */
  connected: boolean;
  usage: UsageTotals;
}

interface HostsFile {
  version: 1;
  hosts: HostRecord[];
}

export interface WireEvent {
  seq: number;
  type: string;
  [key: string]: unknown;
}

export interface ClientOptions {
  secrets: SecretStore;
  fetchImpl?: typeof fetch;
  file?: string;
  /** How this PC introduces itself when it joins. */
  clientName?: string;
}

export const hostSecretKey = (id: string): string => `kai/shared-agent/host/${id}`;
const RUN_ID_RE = /^[A-Za-z0-9_-]{4,40}$/;
const REQUEST_TIMEOUT_MS = 8_000;
const POLL_TIMEOUT_MS = 20_000;

/** A saved row's origin; rows written before internet links kept `ip` + `port`. */
function originOf(row: Record<string, unknown>): string | null {
  const raw =
    typeof row.origin === "string"
      ? row.origin
      : typeof row.ip === "string"
        ? `http://${row.ip}:${Number(row.port) || 80}`
        : "";
  return allowedOrigin(raw)?.origin ?? null;
}

/** "192.168.1.20:8765" or "my-pc.example.com", for messages. */
export function displayAddress(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

function platformLabel(): string {
  return (
    { win32: "Windows", darwin: "macOS", linux: "Linux" }[process.platform as string] ?? "Other"
  );
}

export class HostsClient {
  private readonly file: string;
  private readonly fetchImpl: typeof fetch;
  private readonly clientName: string;
  private data: HostsFile;

  constructor(private readonly opts: ClientOptions) {
    this.file = opts.file ?? path.join(sharedAgentDir(), "hosts.json");
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.clientName = (opts.clientName ?? (os.hostname() || "PC")).slice(0, 64);
    this.data = this.load();
  }

  private load(): HostsFile {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8")) as Partial<HostsFile>;
      if (parsed?.version === 1 && Array.isArray(parsed.hosts)) {
        return {
          version: 1,
          hosts: parsed.hosts.flatMap((h) => {
            if (!h || typeof h.id !== "string") return [];
            const origin = originOf(h as unknown as Record<string, unknown>);
            if (!origin) return [];
            const {
              ip: _ip,
              port: _port,
              ...rest
            } = h as HostRecord & {
              ip?: unknown;
              port?: unknown;
            };
            return [{ ...rest, origin, usage: { ...emptyUsage(), ...(h.usage ?? {}) } }];
          }),
        };
      }
    } catch {
      // Missing or unreadable: no joined PCs yet.
    }
    return { version: 1, hosts: [] };
  }

  private save(): void {
    atomicWriteJson(this.file, this.data);
  }

  list(): HostRecord[] {
    return this.data.hosts.map((h) => ({ ...h, usage: { ...h.usage } }));
  }

  get(id: string): HostRecord | undefined {
    return this.data.hosts.find((h) => h.id === id);
  }

  // ---------------------------------------------------------------- calls

  private async call(
    host: Pick<HostRecord, "origin">,
    method: "GET" | "POST",
    urlPath: string,
    opts: { token?: string; body?: unknown; timeoutMs?: number; signal?: AbortSignal } = {}
  ): Promise<{ status: number; data: Record<string, unknown> }> {
    const allowed = allowedOrigin(host.origin);
    if (!allowed) {
      throw new ClientError(
        "bad_request",
        "Only local-network PCs or HTTPS internet links can be used."
      );
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? REQUEST_TIMEOUT_MS);
    const onAbort = () => controller.abort();
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const res = await this.fetchImpl(`${allowed.origin}${urlPath}`, {
        method,
        redirect: "manual",
        signal: controller.signal,
        headers: {
          ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
          ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      });
      let data: Record<string, unknown> = {};
      try {
        const parsed: unknown = await res.json();
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          data = parsed as Record<string, unknown>;
        }
      } catch {
        // empty or non-JSON body
      }
      return { status: res.status, data };
    } catch {
      if (opts.signal?.aborted) throw new ClientError("failed", "Cancelled.");
      throw new ClientError(
        "unreachable",
        allowed.tunnel
          ? `Can't reach ${displayAddress(allowed.origin)}. Is the host sharing, and is its tunnel still running?`
          : `Can't reach ${displayAddress(allowed.origin)}. Is Kai (or Agent Bridge) running there, and sharing?`
      );
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    }
  }

  /** A call on a joined host. A 401 means the host removed this PC. */
  private async authed(
    host: HostRecord,
    method: "GET" | "POST",
    urlPath: string,
    opts: { body?: unknown; timeoutMs?: number; signal?: AbortSignal } = {}
  ): Promise<Record<string, unknown>> {
    const token = host.connected ? await this.opts.secrets.get(hostSecretKey(host.id)) : null;
    if (!token)
      throw new ClientError(
        "removed",
        `${host.name} is not connected. Join again with a new invite link.`
      );
    const { status, data } = await this.call(host, method, urlPath, { ...opts, token });
    if (status === 401) {
      await this.markRemoved(host.id);
      throw new ClientError(
        "removed",
        `${host.name} removed this PC. Join again with a new invite link.`
      );
    }
    if (status !== 200) {
      const detail =
        typeof data.detail === "string" ? data.detail : `${host.name} answered ${status}.`;
      throw new ClientError(status === 409 || status === 429 ? "busy" : "rejected", detail);
    }
    return data;
  }

  private async markRemoved(id: string): Promise<void> {
    const host = this.get(id);
    if (host) {
      host.connected = false;
      this.save();
    }
    await this.opts.secrets.delete(hostSecretKey(id)).catch(() => {});
  }

  // ---------------------------------------------------------------- joining

  /** Redeems an invite. A PC that joins the same host again keeps its row and usage. */
  async join(target: InviteTarget, name?: string): Promise<HostRecord> {
    const previous = this.data.hosts.find((h) => h.origin === target.origin);
    const { status, data } = await this.call(target, "POST", "/api/pair/key", {
      body: { device_name: this.clientName, platform: platformLabel(), key: target.key },
    });
    const token = data.device_token;
    if (status !== 200 || typeof token !== "string" || !token) {
      throw new ClientError(
        status === 429 ? "busy" : "rejected",
        typeof data.detail === "string" ? data.detail : `The other PC answered ${status}.`
      );
    }
    if (previous?.connected) await this.leaveRemote(previous).catch(() => {});
    const id = previous?.id ?? crypto.randomBytes(9).toString("base64url");
    await this.opts.secrets.set(hostSecretKey(id), token);
    const hostName = typeof data.host_name === "string" ? data.host_name.slice(0, 60) : "";
    const typed = (name ?? "").trim().slice(0, 60);
    let record = this.data.hosts.find((h) => h.id === id);
    if (!record) {
      record = {
        id,
        name: "",
        origin: target.origin,
        hostName,
        connectedAt: "",
        connected: true,
        usage: emptyUsage(),
      };
      this.data.hosts.push(record);
    }
    record.name = typed || record.name || hostName || displayAddress(target.origin);
    record.hostName = hostName;
    record.connected = true;
    record.connectedAt = new Date().toISOString();
    this.save();
    return { ...record, usage: { ...record.usage } };
  }

  private async leaveRemote(host: HostRecord): Promise<void> {
    const token = await this.opts.secrets.get(hostSecretKey(host.id));
    if (token) await this.call(host, "POST", "/api/device/disconnect", { token, timeoutMs: 3_000 });
  }

  /** Tells the host (best effort: it may be off), then forgets it. */
  async leave(id: string): Promise<void> {
    const host = this.get(id);
    if (!host) throw new ClientError("bad_request", "That PC is not in your list.");
    await this.leaveRemote(host).catch(() => {});
    await this.opts.secrets.delete(hostSecretKey(id)).catch(() => {});
    this.data.hosts = this.data.hosts.filter((h) => h.id !== id);
    this.save();
  }

  // ---------------------------------------------------------------- using a host

  /** Is it reachable, still ours, and which agents does it share with us? */
  async me(id: string): Promise<{ hostName: string; agents: AgentView[]; latencyMs: number }> {
    const host = this.get(id);
    if (!host) throw new ClientError("bad_request", "That PC is not in your list.");
    const started = Date.now();
    const data = await this.authed(host, "GET", "/api/device/me");
    const latencyMs = Date.now() - started;
    const rows = Array.isArray(data.agents) ? data.agents : [];
    const agents: AgentView[] = [];
    for (const row of rows as Array<Record<string, unknown>>) {
      if (isSharedAgentId(row?.id)) {
        agents.push({
          id: row.id,
          name: SHARED_AGENT_NAMES[row.id],
          available: row.available === true,
        });
      }
    }
    return {
      hostName: typeof data.host_name === "string" ? data.host_name : "",
      agents,
      latencyMs,
    };
  }

  async startRun(
    id: string,
    req: { agent: SharedAgentId; message: string; session?: string | null }
  ): Promise<{ runId: string; sessionId: string }> {
    const host = this.get(id);
    if (!host) throw new ClientError("bad_request", "That PC is not in your list.");
    const data = await this.authed(host, "POST", "/api/device/runs", {
      body: {
        agent: req.agent,
        workspace: "chat",
        prompt: req.message,
        session: req.session || "new",
      },
    });
    if (typeof data.run_id !== "string" || typeof data.session_id !== "string") {
      throw new ClientError("failed", "The host sent an unexpected reply.");
    }
    return { runId: data.run_id, sessionId: data.session_id };
  }

  async poll(
    id: string,
    runId: string,
    after: number,
    signal?: AbortSignal
  ): Promise<{ events: WireEvent[]; finished: boolean }> {
    const host = this.get(id);
    if (!host) throw new ClientError("bad_request", "That PC is not in your list.");
    if (!RUN_ID_RE.test(runId)) throw new ClientError("bad_request", "Bad run id.");
    const data = await this.authed(
      host,
      "GET",
      `/api/device/runs/${runId}/poll?after=${Math.max(0, Math.trunc(after))}`,
      { timeoutMs: POLL_TIMEOUT_MS, signal }
    );
    const events = Array.isArray(data.events) ? (data.events as WireEvent[]) : [];
    return { events, finished: data.finished === true };
  }

  async stop(id: string, runId: string): Promise<void> {
    const host = this.get(id);
    if (!host || !RUN_ID_RE.test(runId)) return;
    await this.authed(host, "POST", `/api/device/runs/${runId}/stop`).catch(() => {});
  }

  /** Adds one finished run's tokens to what this PC has used through that host. */
  addUsage(id: string, tokens: Partial<TokenTotals> | undefined, costUsd: unknown): void {
    const host = this.get(id);
    if (!host) return;
    const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
    host.usage.runs += 1;
    host.usage.input += n(tokens?.input);
    host.usage.output += n(tokens?.output);
    host.usage.cacheRead += n(tokens?.cacheRead);
    host.usage.cacheWrite += n(tokens?.cacheWrite);
    host.usage.costUsd = Math.round((host.usage.costUsd + n(costUsd)) * 1e6) / 1e6;
    this.save();
  }
}
