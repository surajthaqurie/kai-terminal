/**
 * The receiving side: the PCs this PC has joined, and calls to their host
 * servers. Only Kai Terminal hosts are used.
 *
 * Every call after the handshake is end-to-end encrypted (`secureChannel.ts`),
 * whatever carries it: the LAN, ngrok, Cloudflare Tunnel or any proxy only
 * relays ciphertext. The host must prove it holds the identity key whose
 * fingerprint was in the invite link (and, later, that same key), so a tunnel
 * provider or a machine on the LAN can't pose as it.
 *
 * The list lives in `~/.kai/shared-agent/hosts.json` and holds no secret: this
 * PC's private key for each host goes to the OS secret store. Only
 * private-network IPv4 hosts over HTTP, or public tunnel hosts over HTTPS, are
 * ever contacted, and redirects are never followed.
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
  CONFIRM_COUNTER,
  CONFIRM_TEXT,
  ChannelError,
  b64u,
  clientKeys,
  fingerprint,
  fromB64u,
  generateKeyPair,
  inviteMaterial,
  keyPairFromPrivate,
  open,
  safetyCode,
  sameBytes,
  seal,
  type HandshakeMode,
  type SessionKeys,
} from "./secureChannel";
import {
  emptyUsage,
  isSharedAgentId,
  KAI_CLIENT_HEADER,
  KAI_SERVICE,
  KAI_SERVICE_HEADER,
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
  /** False once the host removed this PC (its key no longer works). */
  connected: boolean;
  usage: UsageTotals;
  /** The host's identity public key, pinned at joining. Empty on rows from before encryption. */
  hostKey: string;
  /** This PC's id on that host. */
  deviceId: string;
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

/** Where this PC's private key for a joined host is kept (OS secret store). */
export const hostSecretKey = (id: string): string => `kai/shared-agent/host/${id}`;
const RUN_ID_RE = /^[A-Za-z0-9_-]{4,40}$/;
const REQUEST_TIMEOUT_MS = 8_000;
const POLL_TIMEOUT_MS = 20_000;
/** The most a host may send back in one reply (a malicious host can't exhaust memory). */
const MAX_REPLY_BYTES = 4 * 1024 * 1024;

const REJOIN =
  "was joined with an older Kai Terminal that did not encrypt end to end. Join it again with a new invite link.";

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

/** What the secret store holds for one joined host. */
interface StoredDeviceKey {
  v: 2;
  privateKey: string;
}

function parseStoredKey(raw: string | null): StoredDeviceKey | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredDeviceKey>;
    if (parsed?.v === 2 && typeof parsed.privateKey === "string") {
      fromB64u(parsed.privateKey, 32);
      return { v: 2, privateKey: parsed.privateKey };
    }
  } catch {
    // An old bearer token (plain text) or damage: not usable.
  }
  return null;
}

interface Session {
  keys: SessionKeys;
  /** The last counter used; each call takes the next one. */
  n: number;
}

export interface CallReply {
  status: number;
  data: Record<string, unknown>;
}

export class HostsClient {
  private readonly file: string;
  private readonly fetchImpl: typeof fetch;
  private readonly clientName: string;
  private data: HostsFile;
  private readonly sessions = new Map<string, Session>();
  private readonly connecting = new Map<string, Promise<Session>>();

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
            const hostKey = typeof h.hostKey === "string" ? h.hostKey : "";
            const deviceId = typeof h.deviceId === "string" ? h.deviceId : "";
            return [
              {
                ...rest,
                origin,
                hostKey,
                deviceId,
                // Joined before encryption: there is no key to prove, so it must join again.
                connected: Boolean(h.connected && hostKey && deviceId),
                usage: { ...emptyUsage(), ...(h.usage ?? {}) },
              },
            ];
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

  /** The safety code of a joined host's pinned key ("" for rows that must join again). */
  safetyCodeOf(id: string): string {
    const key = this.get(id)?.hostKey;
    return key ? safetyCode(key) : "";
  }

  // ---------------------------------------------------------------- transport

  /** One HTTP request to a Kai host. Only `/api/sc/*` is ever called. */
  private async post(
    host: Pick<HostRecord, "origin">,
    urlPath: "/api/sc/hello" | "/api/sc/call",
    body: unknown,
    opts: { timeoutMs?: number; signal?: AbortSignal } = {}
  ): Promise<CallReply> {
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
        method: "POST",
        redirect: "manual",
        signal: controller.signal,
        headers: { [KAI_CLIENT_HEADER]: KAI_SERVICE, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.headers.get(KAI_SERVICE_HEADER)?.trim().toLowerCase() !== KAI_SERVICE) {
        // A tunnel or proxy answering for a host that is down has no Kai header either.
        if (res.status >= 502 && res.status <= 504) throw new Error("gateway");
        throw new ClientError(
          "rejected",
          `${displayAddress(allowed.origin)} is not a Kai Terminal host. Shared Agent only works between Kai Terminal PCs.`
        );
      }
      return { status: res.status, data: await readLimitedJson(res) };
    } catch (e) {
      if (e instanceof ClientError) throw e;
      if (opts.signal?.aborted) throw new ClientError("failed", "Cancelled.");
      throw new ClientError(
        "unreachable",
        allowed.tunnel
          ? `Can't reach ${displayAddress(allowed.origin)}. Is the host sharing, and is its tunnel still running?`
          : `Can't reach ${displayAddress(allowed.origin)}. Is Kai Terminal running there, and sharing?`
      );
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    }
  }

  /**
   * Runs the handshake. The host must prove it holds the private half of a key
   * that `acceptHost` accepts (the invite's fingerprint, or the pinned key).
   */
  private async handshake(
    host: Pick<HostRecord, "origin">,
    mode: HandshakeMode,
    tag: string,
    secret: { clientStaticPrivate: string } | { psk: Buffer },
    acceptHost: (hostKey: string) => boolean,
    clientStatic?: string
  ): Promise<{ session: Session; hostKey: string }> {
    const ephemeral = generateKeyPair();
    const { status, data } = await this.post(host, "/api/sc/hello", {
      v: 1,
      mode,
      tag,
      e: ephemeral.publicKey,
    });
    if (status !== 200) throw replyError(status, data, "The other PC");
    const sid = typeof data.sid === "string" && data.sid.length <= 64 ? data.sid : "";
    let hostKey: string;
    let hostEphemeral: string;
    try {
      hostKey = b64u(fromB64u(data.h, 32));
      hostEphemeral = b64u(fromB64u(data.e, 32));
    } catch {
      throw impostor(host.origin);
    }
    if (!sid || !acceptHost(hostKey)) throw impostor(host.origin);
    let keys: SessionKeys;
    try {
      keys = clientKeys(
        {
          mode,
          tag,
          clientEphemeral: ephemeral.publicKey,
          hostEphemeral,
          hostStatic: hostKey,
          clientStatic,
          sid,
        },
        ephemeral.privateKey,
        secret
      );
      const confirm = open(keys.recv, sid, "s2c", CONFIRM_COUNTER, keys.transcript, data.confirm);
      if (confirm !== CONFIRM_TEXT) throw new ChannelError("bad confirm");
    } catch {
      // The host does not hold the key it showed: someone is in between.
      throw impostor(host.origin);
    }
    return { session: { keys, n: 0 }, hostKey };
  }

  /** Sends one sealed request on a session and opens the sealed reply. */
  private async sealed(
    host: Pick<HostRecord, "origin">,
    session: Session,
    method: "GET" | "POST",
    innerPath: string,
    body: unknown,
    opts: { timeoutMs?: number; signal?: AbortSignal }
  ): Promise<CallReply> {
    const { keys } = session;
    const n = ++session.n;
    const c = seal(
      keys.send,
      keys.sid,
      "c2s",
      n,
      keys.transcript,
      JSON.stringify({ m: method, p: innerPath, b: body })
    );
    const outer = await this.post(host, "/api/sc/call", { s: keys.sid, n, c }, opts);
    if (outer.status !== 200) {
      // Not sealed: the host refused before decrypting (session gone, rate limit, ...).
      return outer;
    }
    let reply: unknown;
    try {
      if (outer.data.n !== n) throw new ChannelError("counter mismatch");
      reply = JSON.parse(open(keys.recv, keys.sid, "s2c", n, keys.transcript, outer.data.c));
    } catch {
      throw impostor(host.origin);
    }
    const r = (reply ?? {}) as { status?: unknown; body?: unknown };
    const data =
      r.body && typeof r.body === "object" && !Array.isArray(r.body)
        ? (r.body as Record<string, unknown>)
        : {};
    return { status: typeof r.status === "number" ? r.status : 500, data };
  }

  /** A live session with a joined host, made (once, even for concurrent callers) when needed. */
  private async sessionFor(host: HostRecord): Promise<Session> {
    const existing = this.sessions.get(host.id);
    if (existing) return existing;
    const pending = this.connecting.get(host.id);
    if (pending) return pending;
    const p = this.connect(host);
    this.connecting.set(host.id, p);
    try {
      const session = await p;
      this.sessions.set(host.id, session);
      return session;
    } finally {
      this.connecting.delete(host.id);
    }
  }

  private async connect(host: HostRecord): Promise<Session> {
    if (!host.connected || !host.hostKey || !host.deviceId) {
      throw new ClientError(
        "removed",
        host.hostKey
          ? `${host.name} is not connected. Join again with a new invite link.`
          : `${host.name} ${REJOIN}`
      );
    }
    const stored = parseStoredKey(await this.opts.secrets.get(hostSecretKey(host.id)));
    if (!stored) throw new ClientError("removed", `${host.name} ${REJOIN}`);
    try {
      const { session } = await this.handshake(
        host,
        "device",
        host.deviceId,
        { clientStaticPrivate: stored.privateKey },
        (key) => sameBytes(key, host.hostKey),
        keyPairFromPrivate(stored.privateKey).publicKey
      );
      return session;
    } catch (e) {
      if (e instanceof ClientError && e.code === "rejected" && /not approved/.test(e.message)) {
        await this.markRemoved(host.id);
        throw new ClientError(
          "removed",
          `${host.name} removed this PC. Join again with a new invite link.`
        );
      }
      throw e;
    }
  }

  /** A call on a joined host. Reconnects once if the host ended the session. */
  private async authed(
    host: HostRecord,
    method: "GET" | "POST",
    innerPath: string,
    opts: { body?: unknown; timeoutMs?: number; signal?: AbortSignal } = {}
  ): Promise<Record<string, unknown>> {
    let reply: CallReply = { status: 500, data: {} };
    for (let attempt = 0; attempt < 2; attempt++) {
      const session = await this.sessionFor(host);
      reply = await this.sealed(host, session, method, innerPath, opts.body ?? {}, opts);
      if (reply.status === 401 && reply.data.code === "session") {
        if (this.sessions.get(host.id) === session) this.sessions.delete(host.id);
        continue;
      }
      break;
    }
    const { status, data } = reply;
    if (status === 401) {
      await this.markRemoved(host.id);
      throw new ClientError(
        "removed",
        `${host.name} removed this PC. Join again with a new invite link.`
      );
    }
    if (status !== 200) throw replyError(status, data, host.name);
    return data;
  }

  private async markRemoved(id: string): Promise<void> {
    this.sessions.delete(id);
    const host = this.get(id);
    if (host) {
      host.connected = false;
      this.save();
    }
    await this.opts.secrets.delete(hostSecretKey(id)).catch(() => {});
  }

  /**
   * One raw device-API call on a joined host's encrypted channel (the inner
   * path, e.g. `/me`), returning the inner status and body. For diagnostics
   * and tests; the app uses the typed methods below.
   */
  async deviceRequest(
    id: string,
    method: "GET" | "POST",
    innerPath: string,
    body: unknown = {}
  ): Promise<CallReply> {
    const host = this.get(id);
    if (!host) throw new ClientError("bad_request", "That PC is not in your list.");
    return this.sealed(host, await this.sessionFor(host), method, innerPath, body, {});
  }

  // ---------------------------------------------------------------- joining

  /** Redeems an invite. Nothing secret is sent: the invite only keys the handshake. */
  async join(target: InviteTarget, name?: string): Promise<HostRecord> {
    const previous = this.data.hosts.find((h) => h.origin === target.origin);
    const { tag, psk } = inviteMaterial(target.key);
    const { session, hostKey } = await this.handshake(target, "pair", tag, { psk }, (key) =>
      sameBytes(fingerprint(key), target.fingerprint)
    );
    const device = generateKeyPair();
    const { status, data } = await this.sealed(
      target,
      session,
      "POST",
      "/pair",
      { device_name: this.clientName, platform: platformLabel(), public_key: device.publicKey },
      {}
    );
    const deviceId = typeof data.device_id === "string" ? data.device_id : "";
    if (status !== 200 || !/^[A-Za-z0-9_-]{4,64}$/.test(deviceId)) {
      throw replyError(status, data, "The other PC");
    }
    if (previous?.connected) await this.leaveRemote(previous).catch(() => {});
    const id = previous?.id ?? crypto.randomBytes(9).toString("base64url");
    this.sessions.delete(id);
    const stored: StoredDeviceKey = { v: 2, privateKey: device.privateKey };
    await this.opts.secrets.set(hostSecretKey(id), JSON.stringify(stored));
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
        hostKey,
        deviceId,
      };
      this.data.hosts.push(record);
    }
    record.name = typed || record.name || hostName || displayAddress(target.origin);
    record.hostName = hostName;
    record.hostKey = hostKey;
    record.deviceId = deviceId;
    record.connected = true;
    record.connectedAt = new Date().toISOString();
    this.save();
    return { ...record, usage: { ...record.usage } };
  }

  private async leaveRemote(host: HostRecord): Promise<void> {
    await this.authed(host, "POST", "/disconnect", { timeoutMs: 3_000 });
  }

  /** Tells the host (best effort: it may be off), then forgets it. */
  async leave(id: string): Promise<void> {
    const host = this.get(id);
    if (!host) throw new ClientError("bad_request", "That PC is not in your list.");
    await this.leaveRemote(host).catch(() => {});
    this.sessions.delete(id);
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
    const data = await this.authed(host, "GET", "/me");
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
    const data = await this.authed(host, "POST", "/runs", {
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
      `/runs/${runId}/poll?after=${Math.max(0, Math.trunc(after))}`,
      { timeoutMs: POLL_TIMEOUT_MS, signal }
    );
    const events = Array.isArray(data.events) ? (data.events as WireEvent[]) : [];
    return { events, finished: data.finished === true };
  }

  async stop(id: string, runId: string): Promise<void> {
    const host = this.get(id);
    if (!host || !RUN_ID_RE.test(runId)) return;
    await this.authed(host, "POST", `/runs/${runId}/stop`).catch(() => {});
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

function impostor(origin: string): ClientError {
  return new ClientError(
    "rejected",
    `${displayAddress(origin)} could not prove it is the PC that made this invite. ` +
      "Something on the network may be pretending to be it, so nothing was sent. Check the link with the host."
  );
}

function replyError(status: number, data: Record<string, unknown>, who: string): ClientError {
  const detail =
    typeof data.detail === "string" ? data.detail.slice(0, 300) : `${who} answered ${status}.`;
  return new ClientError(status === 409 || status === 429 ? "busy" : "rejected", detail);
}

/** Reads a JSON object body, refusing more than {@link MAX_REPLY_BYTES}. */
async function readLimitedJson(res: Response): Promise<Record<string, unknown>> {
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > MAX_REPLY_BYTES) throw new ClientError("failed", "The host sent too much data.");
  const reader = res.body?.getReader();
  if (!reader) return {};
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_REPLY_BYTES) {
      await reader.cancel().catch(() => {});
      throw new ClientError("failed", "The host sent too much data.");
    }
    chunks.push(value);
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // empty or non-JSON body
  }
  return {};
}
