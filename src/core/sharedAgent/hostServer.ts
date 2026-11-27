/**
 * The host: a small HTTP server that lets other Kai Terminal PCs chat with
 * this PC's agents, on the LAN or through any tunnel (ngrok, Cloudflare
 * Tunnel, a reverse proxy).
 *
 * Security model (see SECURITY.md section 5):
 *  - Off until a person turns sharing on in this session.
 *  - The network is untrusted. Everything after the handshake is end-to-end
 *    encrypted and authenticated (`secureChannel.ts`): a LAN sniffer or the
 *    tunnel provider sees only ciphertext. No secret, token or prompt is ever
 *    sent in the clear, and there is no bearer token to steal or replay.
 *  - The host proves its identity key (pinned by the fingerprint in the invite
 *    link); each PC proves the key it registered when it joined.
 *  - A PC joins with a one-time, expiring invite secret (256 bits) that never
 *    leaves the link: only a tag derived from it is sent, and the derived key
 *    is kept in memory only. Failed attempts are rate limited per address.
 *  - Defence in depth on top: only callers on a subnet this PC is attached to
 *    (or this PC), plus tunnel traffic while a tunnel address is set; a PC only
 *    works from the kind of network it joined from; only Kai clients are served.
 *  - Agents run read-only in an empty folder; no file, shell or MCP access.
 */
import crypto from "crypto";
import http from "http";
import net, { type AddressInfo } from "net";
import {
  RunManager,
  RunRejected,
  AgentError,
  addUsage,
  detectOtherClis,
  ensureChatDir,
  locateAgent,
  probeAgent,
  type AgentLocator,
  type AgentProbe,
  type OtherCliDetector,
  type Run,
} from "./agentRunner";
import {
  agentUseOf,
  grantsOf,
  inviteExpired,
  localDay,
  type DeviceRecord,
  type HostStore,
  newDeviceUsage,
} from "./hostStore";
import {
  TUNNEL_NETWORK,
  classifyRequest,
  localNetworks,
  normalizeRemote,
  tunnelClientIp,
  type LocalNetwork,
} from "./netcheck";
import type { SecretStore } from "../integrations/secretStore";
import {
  CONFIRM_COUNTER,
  CONFIRM_TEXT,
  ChannelError,
  PROTOCOL,
  ReplayWindow,
  b64u,
  fingerprint,
  fromB64u,
  generateKeyPair,
  hostKeys,
  inviteMaterial,
  keyPairFromPrivate,
  open,
  safetyCode,
  sameBytes,
  seal,
  type HandshakeMode,
  type KeyPair,
  type SessionKeys,
} from "./secureChannel";
import {
  KAI_CLIENT_HEADER,
  KAI_SERVICE,
  KAI_SERVICE_HEADER,
  MAX_TASKS_PER_DEVICE,
  MODEL_RE,
  NOT_KAI_CLIENT,
  SHARED_AGENT_IDS,
  SHARED_AGENT_NAMES,
  emptyUsage,
  isSharedAgentId,
  limitsFor,
  totalTokens,
  type AgentUse,
  type DeviceGrants,
  type DeviceHistory,
  type DeviceState,
  type TaskStatus,
  type InviteMinutes,
  type SharedAgentId,
  type ShareAgentRow,
  type ShareOtherCli,
  type ShareDevice,
  type ShareInvite,
  type ShareRun,
} from "./types";

const ONLINE_WINDOW_MS = 120_000;
const PERSIST_SEEN_MS = 30_000;
const MAX_BODY_BYTES = 512 * 1024;
/**
 * Calls that fail to decrypt before a session is dropped. The session id travels in clear, so
 * anyone on the network could end a session with one forged POST if a single bad call did it
 * (SEC-11). A real client sends none; an attacker needs this many forgeries per session, and each
 * one also counts against the per-address limit (keyFailed).
 */
const MAX_BAD_CALLS_PER_SESSION = 5;
const MAX_HELLO_BYTES = 2 * 1024;
const MAX_PROMPT_CHARS = 200_000;
const MAX_OPEN_INVITES = 10;
const MAX_DEVICES = 50;
const MAX_SESSIONS_PER_DEVICE = 60;
const KEY_MAX_FAILURES = 10; // wrong invite secrets allowed per address ...
const KEY_FAILURE_WINDOW_MS = 300_000; // ... in this long
const PROBE_TTL_MS = 60_000;
const POLL_WAIT_MS = 8_000;
/** Secure sessions: idle limit, idle limit before the client proved its keys, hard limit. */
const SESSION_IDLE_MS = 15 * 60_000;
const UNPROVEN_SESSION_MS = 30_000;
const SESSION_MAX_MS = 8 * 3600_000;
const MAX_SESSIONS = 200;
const MAX_SESSIONS_PER_PC = 4;
const MAX_HELLOS_PER_MINUTE = 30;
/** Addresses tracked for rate limiting; the oldest is forgotten past this. */
const MAX_TRACKED_ADDRESSES = 4096;
/** Where the host's private identity key is kept (OS secret store). */
export const HOST_IDENTITY_SECRET = "kai/shared-agent/host-identity";
/** The port is taken by another program. */
export class PortInUseError extends Error {
  constructor(readonly port: number) {
    super(`Port ${port} is already in use by another program. Choose another port.`);
  }
}

/**
 * Opens `port` for a moment and closes it again: true when it is free.
 * Uses the same address sharing would, so the answer matches what a start would do.
 */
export async function isPortFree(port: number, bindHost = "0.0.0.0"): Promise<boolean> {
  const probe = net.createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      probe.once("error", reject);
      probe.listen({ port, host: bindHost, exclusive: true }, () => resolve());
    });
  } catch {
    return false;
  }
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return true;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Machine-readable reason the client acts on ("session", "device", "replay"). */
    readonly code?: string
  ) {
    super(message);
  }
}

export interface HostServerOptions {
  store: HostStore;
  locate: AgentLocator;
  /** Finds the other coding CLIs on this PC (listed, not shareable). Defaults to the real PATH. */
  detectOtherClis?: OtherCliDetector;
  hostName: string;
  version: string;
  /**
   * Keeps the host's identity key between runs (the OS secret store). Without
   * one (tests) a new key is made each run, so earlier joins stop working.
   */
  secrets?: SecretStore;
  /** The empty folder every shared chat runs in. */
  chatDir: string;
  /** Overridable so tests can pretend to be on a LAN. */
  networks?: () => LocalNetwork[];
  /** Called when something a person watching the panel would care about changed. */
  onChange?: () => void;
  maxConcurrentRuns?: number;
}

const randomToken = (bytes: number): string => crypto.randomBytes(bytes).toString("base64url");

export class HostServer {
  readonly runs: RunManager;
  private server: http.Server | null = null;
  private boundPort = 0;
  private probes = new Map<SharedAgentId, AgentProbe>();
  private others: ShareOtherCli[] = [];
  private probedAt = 0;
  private keyFailures = new Map<string, number[]>();
  private hellos = new Map<string, number[]>();
  private identity: KeyPair | null = null;
  /** Invite PSKs by invite id. Memory only: a restart voids open invites. */
  private invitePsk = new Map<string, Buffer>();
  private sessions = new Map<string, SecureSession>();
  private lastPersist = new Map<string, number>();
  private readonly networks: () => LocalNetwork[];

  constructor(private readonly opts: HostServerOptions) {
    this.networks = opts.networks ?? localNetworks;
    this.runs = new RunManager({
      locate: opts.locate,
      maxConcurrent: opts.maxConcurrentRuns,
      onFinish: (run) => this.recordFinished(run),
    });
  }

  get port(): number | null {
    return this.server ? this.boundPort : null;
  }

  /** The internet (tunnel) address PCs may also use, or null for LAN only. */
  get publicUrl(): string | null {
    return this.opts.store.publicUrl;
  }

  setPublicUrl(url: string | null): void {
    this.opts.store.setPublicUrl(url);
    this.opts.onChange?.();
  }

  /**
   * Where a request came from: a subnet, "loopback", "tunnel" (only while a
   * tunnel address is set), or null (refused). `client` is the caller's
   * address for rate limiting and display.
   */
  private origin(req: http.IncomingMessage): {
    net: string | null;
    client: string;
    tunnel: boolean;
  } {
    const remote = normalizeRemote(req.socket.remoteAddress);
    const publicUrl = this.publicUrl;
    const publicHost = publicUrl ? new URL(publicUrl).hostname : null;
    const net = classifyRequest(remote, req.headers, this.networks(), publicHost);
    if (net === TUNNEL_NETWORK) {
      return {
        net: publicUrl ? net : null,
        // Forwarding headers name the internet client only when the tunnel agent runs on
        // this PC. From any other peer they are the caller's own words: rate limiting goes
        // by the real peer address, so made-up headers can't buy more attempts.
        client:
          remote === "::1" || remote.startsWith("127.") ? tunnelClientIp(req.headers) : remote,
        tunnel: true,
      };
    }
    return { net, client: remote, tunnel: false };
  }

  // ---------------------------------------------------------------- lifecycle

  /**
   * Starts listening on exactly `port` (0 picks any free port, for tests).
   * A port another program holds is an error, never silently swapped for another:
   * the person chose it, and tunnels and firewall rules point at it.
   */
  async start(port: number, bindHost = "0.0.0.0"): Promise<number> {
    if (this.server) return this.boundPort;
    this.identity = await this.loadIdentity();
    // Starting never waits on each agent's `--version` (seconds on Windows): a PATH
    // lookup says what is installed, and the versions follow in the background.
    if (!this.probed) this.quickProbe();
    void this.refreshProbes().then(
      () => this.opts.onChange?.(),
      () => {}
    );
    const server = http.createServer((req, res) => void this.handle(req, res));
    server.headersTimeout = 15_000;
    server.requestTimeout = 60_000;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen({ port, host: bindHost, exclusive: true }, () => {
          server.off("error", reject);
          resolve();
        });
      });
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "EADDRINUSE" || code === "EACCES") throw new PortInUseError(port);
      throw e;
    }
    server.on("error", () => {});
    this.server = server;
    this.boundPort = (server.address() as AddressInfo).port;
    // An invite's key lives only in memory: any open invite from an earlier run is void.
    this.cancelInvitesWithoutSecret();
    return this.boundPort;
  }

  /** The host's identity key from the secret store, made on first use. */
  private async loadIdentity(): Promise<KeyPair> {
    if (this.identity) return this.identity;
    const secrets = this.opts.secrets;
    const stored = secrets ? await secrets.get(HOST_IDENTITY_SECRET).catch(() => null) : null;
    if (stored) {
      try {
        return keyPairFromPrivate(stored);
      } catch {
        // Damaged: make a new one (joined PCs will be told to join again).
      }
    }
    const fresh = generateKeyPair();
    if (secrets) await secrets.set(HOST_IDENTITY_SECRET, fresh.privateKey);
    return fresh;
  }

  /** The safety code people compare between PCs; null until sharing has started once. */
  get safetyCode(): string | null {
    return this.identity ? safetyCode(this.identity.publicKey) : null;
  }

  private cancelInvitesWithoutSecret(): void {
    const changed = this.opts.store.write((d) => {
      let n = 0;
      for (const inv of Object.values(d.invites)) {
        if (inv.status === "open" && !this.invitePsk.has(inv.id)) {
          inv.status = "cancelled";
          n++;
        }
      }
      return n > 0;
    });
    if (changed) this.opts.onChange?.();
  }

  /**
   * Stops listening and releases the port: every run ends, every open connection
   * (long polls included) is cut, and this resolves only once the socket is closed,
   * so the port is free for the next start or another program.
   */
  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.runs.stopAll("sharing turned off");
    await this.runs.settle(3000);
    this.sessions.clear();
    this.cancelUntilOffInvites();
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  }

  /** "Until I turn it off" invites end when sharing does. */
  private cancelUntilOffInvites(): void {
    const changed = this.opts.store.write((d) => {
      let n = 0;
      for (const inv of Object.values(d.invites)) {
        if (inv.status === "open" && inv.ttlSeconds === 0) {
          this.invitePsk.delete(inv.id);
          inv.status = "cancelled";
          n++;
        }
      }
      return n > 0;
    });
    if (changed) this.opts.onChange?.();
  }

  // ---------------------------------------------------------------- admin (called by the service)

  /** True once the installed agents have been looked for at least once. */
  get probed(): boolean {
    return this.probedAt > 0;
  }

  /** True while the installed agents' versions are being fetched. */
  get checking(): boolean {
    return this.probing !== null;
  }

  /**
   * Which agents are installed, from a PATH lookup only (no process started).
   * Fills the list at once; {@link refreshProbes} adds versions later. Does not
   * count as a full look, so the next refresh still fetches versions.
   */
  quickProbe(): void {
    const known = this.probes;
    this.probes = new Map(
      SHARED_AGENT_IDS.map((a) => {
        const { info } = locateAgent(a, this.opts.locate);
        // Keep a version already fetched for an agent that is still there.
        const prev = known.get(a);
        if (info.available && prev?.available) info.version = prev.version;
        return [a, info];
      })
    );
    try {
      this.others = (this.opts.detectOtherClis ?? detectOtherClis)();
    } catch {
      this.others = [];
    }
  }

  /** A probe already running, so overlapping callers share it instead of spawning again. */
  private probing: Promise<void> | null = null;

  async refreshProbes(force = false): Promise<void> {
    if (this.probing) return this.probing;
    if (!force && Date.now() - this.probedAt < PROBE_TTL_MS) return;
    const run = (async () => {
      const probes = await Promise.all(
        SHARED_AGENT_IDS.map((a) => probeAgent(a, this.opts.locate))
      );
      this.probes = new Map(probes.map((p) => [p.id, p]));
      try {
        this.others = (this.opts.detectOtherClis ?? detectOtherClis)();
      } catch {
        this.others = []; // listing extra agents must never break sharing
      }
      this.probedAt = Date.now();
    })();
    this.probing = run.finally(() => {
      this.probing = null;
    });
    return this.probing;
  }

  /** Coding CLIs found on this PC that cannot be shared, with the reason. */
  otherClis(): ShareOtherCli[] {
    return this.others.map((o) => ({ ...o }));
  }

  agentRows(): ShareAgentRow[] {
    return SHARED_AGENT_IDS.map((id) => {
      const p = this.probes.get(id);
      return {
        id,
        name: SHARED_AGENT_NAMES[id],
        available: p?.available ?? false,
        version: p?.version ?? "",
        error: p?.error ?? "",
        enabled: this.opts.store.agentEnabled(id),
      };
    });
  }

  setAgentEnabled(agent: SharedAgentId, enabled: boolean): void {
    this.opts.store.write((d) => {
      d.agents[agent] = { enabled };
    });
    this.opts.onChange?.();
  }

  openInvites(): ShareInvite[] {
    const now = Date.now();
    return this.opts.store.write((d) => {
      for (const inv of Object.values(d.invites)) {
        if (inv.status === "open" && inviteExpired(inv, now)) {
          inv.status = "expired";
        }
      }
      for (const [id, inv] of Object.entries(d.invites)) {
        if (inv.status !== "open" && now - inv.createdMs > 86_400_000) delete d.invites[id];
      }
      return Object.values(d.invites)
        .filter((i) => i.status === "open")
        .sort((a, b) => b.createdMs - a.createdMs)
        .map((i) => ({
          id: i.id,
          createdAt: i.createdAt,
          expiresInSeconds:
            i.ttlSeconds === 0
              ? null
              : Math.max(0, Math.round((i.createdMs + i.ttlSeconds * 1000 - now) / 1000)),
        }));
    });
  }

  /**
   * The secret is returned once, with the host key's fingerprint for the link.
   * The file keeps only a lookup tag; the derived PSK stays in memory.
   */
  createInvite(minutes: InviteMinutes): {
    id: string;
    key: string;
    fingerprint: string;
    expiresInSeconds: number | null;
  } {
    const identity = this.identity;
    if (!identity || !this.server) throw new HttpError(409, "Turn sharing on first.");
    if (this.openInvites().length >= MAX_OPEN_INVITES) {
      throw new HttpError(429, "Too many open invites. Cancel one first.");
    }
    const key = randomToken(32);
    const id = randomToken(9);
    const { tag, psk } = inviteMaterial(key);
    this.invitePsk.set(id, psk);
    this.opts.store.write((d) => {
      d.invites[id] = {
        id,
        tag,
        status: "open",
        createdMs: Date.now(),
        createdAt: new Date().toISOString(),
        ttlSeconds: minutes * 60,
      };
    });
    this.opts.onChange?.();
    return {
      id,
      key,
      fingerprint: fingerprint(identity.publicKey),
      expiresInSeconds: minutes === 0 ? null : minutes * 60,
    };
  }

  cancelInvite(id: string): boolean {
    const ok = this.opts.store.write((d) => {
      const inv = d.invites[id];
      if (!inv) return false;
      if (inv.status === "open") inv.status = "cancelled";
      return true;
    });
    this.invitePsk.delete(id);
    for (const [sid, s] of this.sessions) if (s.inviteId === id) this.sessions.delete(sid);
    if (ok) this.opts.onChange?.();
    return ok;
  }

  devices(): ShareDevice[] {
    const now = Date.now();
    return Object.values(this.opts.store.read((d) => d.devices))
      .map((x) => ({
        id: x.id,
        name: x.name,
        address: x.ip,
        state: deviceState(x, now),
        lastSeen: x.lastSeen,
        usage: { ...x.usage },
        activeRunId: this.runs.activeFor(x.id)?.id ?? null,
        grants: grantsOf(x),
        today: Object.fromEntries(
          SHARED_AGENT_IDS.map((id) => [id, agentUseOf(x, id, now)])
        ) as Record<SharedAgentId, AgentUse>,
      }))
      .sort(
        (a, b) =>
          Number(a.state === "disconnected") - Number(b.state === "disconnected") ||
          a.name.localeCompare(b.name)
      );
  }

  activeRuns(): ShareRun[] {
    return this.runs.active().map((r) => ({
      id: r.id,
      deviceName: r.init.deviceName,
      agent: r.init.agent,
      startedAt: r.startedAt,
    }));
  }

  /** Cuts a PC off. It stays listed (as disconnected) until removed. */
  disconnectDevice(id: string): boolean {
    const ok = this.opts.store.write((d) => {
      const dev = d.devices[id];
      if (!dev) return false;
      dev.status = "revoked";
      return true;
    });
    this.dropSessionsOf(id);
    if (ok) {
      this.runs.stopDevice(id, "disconnected by the host");
      this.opts.onChange?.();
    }
    return ok;
  }

  removeDevice(id: string): boolean {
    const ok = this.opts.store.write((d) => {
      if (!d.devices[id]) return false;
      delete d.devices[id];
      for (const [sid, s] of Object.entries(d.sessions))
        if (s.deviceId === id) delete d.sessions[sid];
      return true;
    });
    this.dropSessionsOf(id);
    if (ok) {
      this.runs.stopDevice(id, "removed by the host");
      this.opts.onChange?.();
    }
    return ok;
  }

  /**
   * Sets what one PC may do. A run already going with an agent the PC just
   * lost is stopped; a new model or time limit applies from its next run.
   */
  setDeviceGrants(id: string, grants: DeviceGrants): boolean {
    const ok = this.opts.store.write((d) => {
      const dev = d.devices[id];
      if (!dev) return false;
      dev.grants = grants;
      return true;
    });
    if (!ok) return false;
    const active = this.runs.activeFor(id);
    if (active && !grants.agents[active.init.agent]) {
      this.runs.stop(active.id, "permission removed by the host");
    }
    this.opts.onChange?.();
    return true;
  }

  /** One PC's totals (overall and per agent) and its recent tasks, newest first. */
  deviceHistory(id: string): DeviceHistory | null {
    return this.opts.store.read((d) => {
      const dev = d.devices[id];
      if (!dev) return null;
      const byAgent: DeviceHistory["byAgent"] = {};
      for (const [agent, u] of Object.entries(dev.usageByAgent ?? {})) {
        if (isSharedAgentId(agent) && u) byAgent[agent] = { ...u };
      }
      return {
        deviceId: dev.id,
        usage: { ...dev.usage },
        byAgent,
        lastUsedAt: dev.lastUsedAt ?? "",
        tasks: [...(dev.tasks ?? [])].reverse().map((t) => ({ ...t, tokens: { ...t.tokens } })),
      };
    });
  }

  stopRun(runId: string): boolean {
    return this.runs.stop(runId, "stopped by the host");
  }

  // ---------------------------------------------------------------- request handling

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      await this.route(req, res);
    } catch (e) {
      if (e instanceof HttpError) {
        send(res, e.status, { detail: e.message, ...(e.code ? { code: e.code } : {}) });
      } else if (!res.headersSent) {
        send(res, 500, { detail: "Internal error" });
      }
    }
  }

  /**
   * Only these are served in the clear: the landing page, a health check that
   * says nothing about this PC, and the two secure-channel endpoints, whose
   * bodies are a handshake or ciphertext.
   */
  private async route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const method = req.method ?? "GET";
    const p = new URL(req.url ?? "/", "http://host").pathname;

    if (method === "GET" && (p === "/" || p === "/join")) return landing(res);
    if (method === "GET" && p === "/api/health") {
      return send(res, 200, { ok: true, service: KAI_SERVICE, protocol: PROTOCOL });
    }
    if (method === "POST" && p === "/api/sc/hello") return this.hello(req, res);
    if (method === "POST" && p === "/api/sc/call") return this.sealedCall(req, res);
    throw new HttpError(404, "Not found");
  }

  /** Where the caller is; refused unless it is a Kai client on a network we serve. */
  private admit(req: http.IncomingMessage): { net: string; client: string } {
    requireKaiClient(req);
    const { net, client, tunnel } = this.origin(req);
    if (net === null) {
      throw new HttpError(
        403,
        tunnel
          ? "This host has turned internet access off."
          : "This PC is not on the same local network as the host."
      );
    }
    return { net, client };
  }

  // -------------------------------------------------- handshake

  private async hello(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const { net, client } = this.admit(req);
    if (!this.keyAttemptAllowed(client)) {
      throw new HttpError(429, "Too many failed attempts. Wait a few minutes and try again.");
    }
    if (!this.helloAllowed(client)) {
      throw new HttpError(429, "Too many connection attempts. Wait a minute and try again.");
    }
    const identity = this.identity;
    if (!identity) throw new HttpError(503, "Sharing is off.");
    const body = await readJson(req, MAX_HELLO_BYTES);
    if (body.v !== 1 || (body.mode !== "pair" && body.mode !== "device")) {
      throw new HttpError(
        426,
        "This Kai Terminal speaks a different sharing version. Update both PCs."
      );
    }
    const mode: HandshakeMode = body.mode;
    const tag = text(body.tag, 8, 64, "tag");
    let clientEphemeral: string;
    try {
      clientEphemeral = b64u(fromB64u(body.e, 32));
    } catch {
      throw new HttpError(422, "Bad handshake");
    }

    let psk: Buffer | undefined;
    let clientStatic: string | undefined;
    let deviceId: string | undefined;
    let inviteId: string | undefined;
    if (mode === "pair") {
      const now = Date.now();
      const invite = this.opts.store.read((d) =>
        Object.values(d.invites).find(
          (i) => i.status === "open" && !inviteExpired(i, now) && sameBytes(i.tag, tag)
        )
      );
      psk = invite ? this.invitePsk.get(invite.id) : undefined;
      if (!invite || !psk) {
        this.keyFailed(client);
        throw new HttpError(
          401,
          "This invite link is wrong, already used, cancelled or expired. Ask the host for a new one."
        );
      }
      inviteId = invite.id;
    } else {
      const device = this.opts.store.read((d) => d.devices[tag]);
      if (!device || device.status !== "approved" || !device.publicKey) {
        this.keyFailed(client);
        throw new HttpError(
          401,
          "This PC is not approved (unknown or removed). Join again.",
          "device"
        );
      }
      this.checkNetwork(device, net);
      clientStatic = device.publicKey;
      deviceId = device.id;
    }

    this.dropStaleSessions();
    if (this.sessions.size >= MAX_SESSIONS) {
      throw new HttpError(503, "This host is busy. Try again in a minute.");
    }
    const mine = [...this.sessions.entries()].filter(
      ([, s]) => (deviceId && s.deviceId === deviceId) || (inviteId && s.inviteId === inviteId)
    );
    if (mine.length >= MAX_SESSIONS_PER_PC) {
      // Oldest goes: a PC that reconnects many times keeps working.
      mine.sort((a, b) => a[1].lastMs - b[1].lastMs);
      this.sessions.delete(mine[0][0]);
    }

    const ephemeral = generateKeyPair();
    const sid = randomToken(18);
    let keys: SessionKeys;
    try {
      keys = hostKeys(
        {
          mode,
          tag,
          clientEphemeral,
          hostEphemeral: ephemeral.publicKey,
          hostStatic: identity.publicKey,
          clientStatic,
          sid,
        },
        identity.privateKey,
        ephemeral.privateKey,
        psk
      );
    } catch (e) {
      if (e instanceof ChannelError) {
        this.keyFailed(client);
        throw new HttpError(422, "Bad handshake");
      }
      throw e;
    }
    const now = Date.now();
    this.sessions.set(sid, {
      keys,
      mode,
      deviceId,
      inviteId,
      net,
      createdMs: now,
      lastMs: now,
      replay: new ReplayWindow(),
      proven: false,
      badCalls: 0,
    });
    send(res, 200, {
      v: 1,
      sid,
      h: identity.publicKey,
      e: ephemeral.publicKey,
      confirm: seal(keys.send, sid, "s2c", CONFIRM_COUNTER, keys.transcript, CONFIRM_TEXT),
    });
  }

  private dropStaleSessions(now = Date.now()): void {
    for (const [sid, s] of this.sessions) {
      const idleLimit = s.proven ? SESSION_IDLE_MS : UNPROVEN_SESSION_MS;
      if (now - s.lastMs > idleLimit || now - s.createdMs > SESSION_MAX_MS) {
        this.sessions.delete(sid);
      }
    }
  }

  private dropSessionsOf(deviceId: string): void {
    for (const [sid, s] of this.sessions) if (s.deviceId === deviceId) this.sessions.delete(sid);
  }

  // -------------------------------------------------- sealed calls

  private async sealedCall(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const { net, client } = this.admit(req);
    if (!this.keyAttemptAllowed(client)) {
      throw new HttpError(429, "Too many failed attempts. Wait a few minutes and try again.");
    }
    const body = await readJson(req, MAX_BODY_BYTES);
    const sid = typeof body.s === "string" ? body.s : "";
    const n = body.n;
    this.dropStaleSessions();
    const session = this.sessions.get(sid);
    if (!session) throw new HttpError(401, "Session ended. Reconnect.", "session");
    if (session.net !== net) {
      // Refused, not ended: the session id is public, so a call from elsewhere must not be
      // able to end the real client's session.
      this.keyFailed(client);
      throw new HttpError(401, "Session ended. Reconnect.", "session");
    }
    if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 1) {
      throw new HttpError(422, "Bad counter");
    }
    let plain: string;
    try {
      plain = open(session.keys.recv, sid, "c2s", n, session.keys.transcript, body.c);
    } catch {
      // Wrong key, tampered or forged: whoever sent it does not hold the session keys.
      this.keyFailed(client);
      session.badCalls += 1;
      if (session.badCalls >= MAX_BAD_CALLS_PER_SESSION) this.sessions.delete(sid);
      throw new HttpError(401, "Session ended. Reconnect.", "session");
    }
    session.badCalls = 0;
    // Checked only after it decrypted, so nobody without the keys can burn counters.
    if (!session.replay.accept(n)) throw new HttpError(409, "Replayed message refused.", "replay");
    session.proven = true;
    session.lastMs = Date.now();

    let status = 200;
    let reply: unknown;
    try {
      reply = await this.dispatchInner(session, parseInner(plain), net, client);
    } catch (e) {
      if (e instanceof HttpError) {
        status = e.status;
        reply = { detail: e.message, ...(e.code ? { code: e.code } : {}) };
      } else {
        status = 500;
        reply = { detail: "Internal error" };
      }
    }
    session.lastMs = Date.now(); // a long poll counts as activity until it answers
    send(res, 200, {
      n,
      c: seal(
        session.keys.send,
        sid,
        "s2c",
        n,
        session.keys.transcript,
        JSON.stringify({ status, body: reply })
      ),
    });
  }

  private async dispatchInner(
    session: SecureSession,
    inner: InnerRequest,
    net: string,
    client: string
  ): Promise<unknown> {
    const { method, path: p, body } = inner;
    if (session.mode === "pair") {
      if (method === "POST" && p === "/pair") return this.pair(session, body, net, client);
      throw new HttpError(404, "Not found");
    }
    const device = this.requireDevice(session, net, client);
    if (method === "GET" && p === "/me") return this.me(device);
    if (method === "POST" && p === "/disconnect") {
      this.disconnectDevice(device.id);
      return { status: "disconnected" };
    }
    if (method === "POST" && p === "/runs") return this.startRun(body, device);
    const url = new URL(p, "http://inner");
    const m = /^\/runs\/([A-Za-z0-9_-]{4,40})\/(poll|stop)$/.exec(url.pathname);
    if (m) {
      const run = this.runs.get(m[1]);
      if (!run || run.init.deviceId !== device.id) throw new HttpError(404, "Run not found");
      if (method === "GET" && m[2] === "poll") return this.poll(run, url);
      if (method === "POST" && m[2] === "stop") {
        return { stopped: this.runs.stop(run.id, "stopped by that PC") };
      }
    }
    throw new HttpError(404, "Not found");
  }

  /**
   * A PC works only from the kind of network it joined from. Loopback is not a
   * wildcard: a TCP forwarder on this PC (ssh -R, ngrok tcp) looks local.
   */
  private checkNetwork(device: DeviceRecord, net: string): void {
    if (net !== device.network) {
      throw new HttpError(
        403,
        device.network === TUNNEL_NETWORK
          ? "This PC joined over the internet. Connect through the host's internet link."
          : "This PC is not on the network it joined from. Connect to the host's LAN."
      );
    }
  }

  /** The session's device: still approved, on the network it joined from. */
  private requireDevice(session: SecureSession, net: string, client: string): DeviceRecord {
    const id = session.deviceId;
    const device = id ? this.opts.store.read((d) => d.devices[id]) : undefined;
    if (!device || device.status !== "approved") {
      throw new HttpError(
        401,
        "This PC is not approved (unknown or removed). Join again.",
        "device"
      );
    }
    this.checkNetwork(device, net);
    const now = Date.now();
    device.lastSeenMs = now;
    device.lastSeen = new Date(now).toISOString();
    device.ip = client || device.ip;
    if (now - (this.lastPersist.get(device.id) ?? 0) > PERSIST_SEEN_MS) {
      this.lastPersist.set(device.id, now);
      this.opts.store.save();
      this.opts.onChange?.();
    }
    return device;
  }

  /** Inside a pairing session: the session keys already prove the invite secret. */
  private pair(
    session: SecureSession,
    body: Record<string, unknown>,
    net: string,
    remote: string
  ): Record<string, unknown> {
    const name = text(body.device_name, 2, 64, "device_name");
    const platform =
      body.platform === undefined ? "Windows" : text(body.platform, 1, 32, "platform");
    let publicKey: string;
    try {
      publicKey = b64u(fromB64u(body.public_key, 32));
    } catch {
      throw new HttpError(422, "public_key must be an X25519 public key");
    }
    const inviteId = session.inviteId as string;

    const deviceId = this.opts.store.write((d) => {
      const now = Date.now();
      const invite = d.invites[inviteId];
      if (!invite || invite.status !== "open" || inviteExpired(invite, now)) return null;
      // Always a new row: matching an old one by name and address would let anyone
      // with an invite take over another PC's permissions and history.
      if (Object.keys(d.devices).length >= MAX_DEVICES) return "full" as const;
      const rec: DeviceRecord = {
        id: randomToken(15),
        name,
        platform,
        ip: remote,
        network: net,
        status: "approved",
        publicKey: "",
        createdAt: new Date(now).toISOString(),
        lastSeen: new Date(now).toISOString(),
        lastSeenMs: now,
        usage: newDeviceUsage(),
      };
      Object.assign(rec, {
        platform,
        ip: remote,
        network: net,
        status: "approved" as const,
        publicKey,
        lastSeen: new Date(now).toISOString(),
        lastSeenMs: now,
      });
      d.devices[rec.id] = rec;
      invite.status = "used";
      invite.usedAt = new Date(now).toISOString();
      invite.deviceId = rec.id;
      return rec.id;
    });
    if (deviceId === "full") {
      throw new HttpError(409, "This host has reached its limit of joined PCs.");
    }
    if (!deviceId) {
      throw new HttpError(
        401,
        "This invite link is wrong, already used, cancelled or expired. Ask the host for a new one."
      );
    }
    // The invite is spent: forget its secret and end every session made with it.
    this.invitePsk.delete(inviteId);
    for (const [sid, s] of this.sessions) if (s.inviteId === inviteId) this.sessions.delete(sid);
    this.opts.onChange?.();
    return { status: "connected", device_id: deviceId, host_name: this.opts.hostName };
  }

  private me(device: DeviceRecord): Record<string, unknown> {
    const active = this.runs.activeFor(device.id);
    const grants = grantsOf(device);
    return {
      device: {
        id: device.id,
        name: device.name,
        network: device.network,
        paired_at: device.createdAt,
      },
      agents: this.agentRows()
        .filter((a) => a.enabled && grants.agents[a.id])
        .map((a) => ({
          id: a.id,
          name: a.name,
          level: "read",
          level_label: "Read-only: chat only",
          available: a.available,
          model_hint: "",
          model: grants.models[a.id] ?? "",
          max_minutes: limitsFor(grants, a.id).maxMinutes,
        })),
      workspaces: [],
      allow_connectors: false,
      max_minutes: Math.max(
        1,
        ...SHARED_AGENT_IDS.filter((id) => grants.agents[id]).map(
          (id) => limitsFor(grants, id).maxMinutes
        )
      ),
      chat_workspace: "chat",
      host_name: this.opts.hostName,
      active_run: active ? { id: active.id, status: active.status } : null,
    };
  }

  private async startRun(
    body: Record<string, unknown>,
    device: DeviceRecord
  ): Promise<Record<string, unknown>> {
    const agent = body.agent;
    const grants = grantsOf(device);
    if (!isSharedAgentId(agent) || !this.opts.store.agentEnabled(agent) || !grants.agents[agent]) {
      throw new HttpError(403, "This PC is not allowed to use that agent");
    }
    if (body.workspace !== "chat") {
      throw new HttpError(403, "Only plain chat is shared by this host");
    }
    // Checked when a run starts: one already going finishes even if it passes a limit.
    const limits = limitsFor(grants, agent);
    const use = agentUseOf(device, agent);
    const name = SHARED_AGENT_NAMES[agent];
    if (limits.dailyTokens !== null && use.tokens >= limits.dailyTokens) {
      throw new HttpError(
        429,
        `This PC has used today's ${name} limit on this host (${limits.dailyTokens.toLocaleString("en-US")} tokens). It resets at midnight, host time.`,
        "limit"
      );
    }
    if (limits.perHour !== null && use.lastHour >= limits.perHour) {
      throw new HttpError(
        429,
        `This PC may send ${limits.perHour} ${name} request${limits.perHour === 1 ? "" : "s"} an hour to this host. Try again a little later.`,
        "limit"
      );
    }
    const prompt = text(body.prompt, 1, MAX_PROMPT_CHARS, "prompt");
    // Only the host picks the model (its account pays): what the PC asks for is ignored.
    const model = grants.models[agent] || null;
    if (model && !MODEL_RE.test(model)) {
      throw new HttpError(422, "Model name has invalid characters");
    }
    await this.refreshProbes(!this.probes.get(agent)?.available);
    if (!this.probes.get(agent)?.available) {
      throw new HttpError(503, `${SHARED_AGENT_NAMES[agent]} is not installed on the host`);
    }

    let sessionId = typeof body.session === "string" ? body.session.trim() : "";
    let resume: string | undefined;
    if (sessionId && sessionId !== "new") {
      const s = this.opts.store.read((d) => d.sessions[sessionId]);
      if (!s || s.deviceId !== device.id) throw new HttpError(404, "Session not found");
      if (s.agent !== agent) throw new HttpError(409, "That session belongs to a different agent");
      resume = s.agentSessionId;
    } else {
      sessionId = randomToken(9);
    }

    let run: Run;
    try {
      run = this.runs.start({
        agent,
        prompt,
        cwd: ensureChatDir(this.opts.chatDir),
        deviceId: device.id,
        deviceName: device.name,
        resume,
        model,
        maxMinutes: limits.maxMinutes,
        sessionKey: sessionId,
      });
    } catch (e) {
      if (e instanceof RunRejected) throw new HttpError(409, e.message);
      if (e instanceof AgentError) throw new HttpError(400, e.message);
      throw e;
    }
    this.opts.store.write((d) => {
      d.sessions[sessionId] = {
        ...(d.sessions[sessionId] ?? { id: sessionId, deviceId: device.id, agent }),
        updatedAt: new Date().toISOString(),
      };
      const mine = Object.values(d.sessions)
        .filter((s) => s.deviceId === device.id)
        .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
      for (const old of mine.slice(0, Math.max(0, mine.length - MAX_SESSIONS_PER_DEVICE))) {
        delete d.sessions[old.id];
      }
    });
    this.opts.onChange?.();
    return { run_id: run.id, session_id: sessionId, level: "read", resumed: Boolean(resume) };
  }

  private async poll(run: Run, url: URL): Promise<Record<string, unknown>> {
    const after = Math.max(0, Number.parseInt(url.searchParams.get("after") ?? "0", 10) || 0);
    const { events, finished } = await run.wait(after, POLL_WAIT_MS);
    return { events, finished, status: run.status };
  }

  private recordFinished(run: Run): void {
    const deviceId = run.init.deviceId;
    this.opts.store.write((d) => {
      const device = d.devices[deviceId];
      if (device) recordTask(device, run);
      const sid = run.init.sessionKey;
      const session = sid ? d.sessions[sid] : undefined;
      if (session) {
        if (run.state.sessionId) session.agentSessionId = run.state.sessionId;
        session.updatedAt = new Date().toISOString();
      }
    });
    this.opts.onChange?.();
  }

  private keyAttemptAllowed(ip: string): boolean {
    const now = Date.now();
    const recent = (this.keyFailures.get(ip) ?? []).filter((t) => now - t < KEY_FAILURE_WINDOW_MS);
    if (recent.length) this.keyFailures.set(ip, recent);
    else this.keyFailures.delete(ip);
    return recent.length < KEY_MAX_FAILURES;
  }

  private keyFailed(ip: string): void {
    if (this.keyFailures.size >= MAX_TRACKED_ADDRESSES && !this.keyFailures.has(ip)) {
      const oldest = this.keyFailures.keys().next().value;
      if (oldest !== undefined) this.keyFailures.delete(oldest);
    }
    this.keyFailures.set(ip, [...(this.keyFailures.get(ip) ?? []), Date.now()]);
  }

  /** Handshakes per address per minute (each costs the host a few X25519 operations). */
  private helloAllowed(ip: string): boolean {
    const now = Date.now();
    const recent = (this.hellos.get(ip) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= MAX_HELLOS_PER_MINUTE) {
      this.hellos.set(ip, recent);
      return false;
    }
    if (this.hellos.size >= MAX_TRACKED_ADDRESSES && !this.hellos.has(ip)) {
      const oldest = this.hellos.keys().next().value;
      if (oldest !== undefined) this.hellos.delete(oldest);
    }
    recent.push(now);
    this.hellos.set(ip, recent);
    return true;
  }
}

interface SecureSession {
  keys: SessionKeys;
  mode: HandshakeMode;
  deviceId?: string;
  inviteId?: string;
  /** The network the handshake came from; the session works only from there. */
  net: string;
  createdMs: number;
  lastMs: number;
  replay: ReplayWindow;
  /** True once a sealed call decrypted: the client really holds the keys. */
  proven: boolean;
  /** Calls in a row that failed to decrypt (see MAX_BAD_CALLS_PER_SESSION). */
  badCalls: number;
}

interface InnerRequest {
  method: "GET" | "POST";
  path: string;
  body: Record<string, unknown>;
}

function parseInner(plain: string): InnerRequest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(plain);
  } catch {
    throw new HttpError(400, "Body must be a JSON object");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HttpError(400, "Body must be a JSON object");
  }
  const o = parsed as Record<string, unknown>;
  if (o.m !== "GET" && o.m !== "POST") throw new HttpError(400, "Bad method");
  if (typeof o.p !== "string" || !o.p.startsWith("/") || o.p.length > 300) {
    throw new HttpError(400, "Bad path");
  }
  const b = o.b ?? {};
  if (!b || typeof b !== "object" || Array.isArray(b)) {
    throw new HttpError(400, "Body must be a JSON object");
  }
  return { method: o.m, path: o.p, body: b as Record<string, unknown> };
}

const TITLE_CHARS = 120;

/** "  what  is\na mutex? " -> "what is a mutex?", cut to {@link TITLE_CHARS}. */
export function taskTitle(prompt: string): string {
  const flat = prompt.replace(/\s+/g, " ").trim();
  return flat.length <= TITLE_CHARS ? flat : `${flat.slice(0, TITLE_CHARS - 1).trimEnd()}…`;
}

/** Folds a finished run into the PC's totals and history. */
function recordTask(device: DeviceRecord, run: Run): void {
  const agent = run.init.agent;
  addUsage(device.usage, run);
  device.usageByAgent ??= {};
  addUsage((device.usageByAgent[agent] ??= emptyUsage()), run);
  device.lastUsedAt = run.endedAt || new Date().toISOString();
  // Counted on the day the run ends (today), so a run across midnight never resets today.
  const day = localDay();
  if (device.daily?.day !== day) device.daily = { day, tokens: {} };
  device.daily.tokens[agent] = (device.daily.tokens[agent] ?? 0) + totalTokens(run.tokens);
  const tasks = (device.tasks ??= []);
  tasks.push({
    id: run.id,
    agent,
    model: run.init.model ?? "",
    title: taskTitle(run.init.prompt),
    status: run.status as TaskStatus,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    durationS: run.durationS,
    tokens: { ...run.tokens },
    costUsd: run.state.costUsd ?? 0,
    error: (run.state.error ?? "").slice(0, 300),
  });
  tasks.splice(0, Math.max(0, tasks.length - MAX_TASKS_PER_DEVICE));
}

function deviceState(x: DeviceRecord, now: number): DeviceState {
  if (x.status !== "approved") return "disconnected";
  return now - x.lastSeenMs < ONLINE_WINDOW_MS ? "connected" : "offline";
}

/** True when the caller says it is Kai Terminal. */
function isKaiClient(req: http.IncomingMessage): boolean {
  const v = req.headers[KAI_CLIENT_HEADER];
  return typeof v === "string" && v.trim().toLowerCase() === KAI_SERVICE;
}

function requireKaiClient(req: http.IncomingMessage): void {
  if (!isKaiClient(req)) throw new HttpError(403, NOT_KAI_CLIENT);
}

const SECURITY_HEADERS: Record<string, string> = {
  [KAI_SERVICE_HEADER]: KAI_SERVICE,
  "Content-Security-Policy":
    "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Cache-Control": "no-store",
};

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

/** What someone sees if they open an invite link in a browser instead of Kai. */
function landing(res: http.ServerResponse): void {
  const html =
    "<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'>" +
    "<title>Kai Terminal: shared agent</title>" +
    "<body style='font:16px system-ui;max-width:34rem;margin:15vh auto;padding:0 1rem;color:#222'>" +
    "<h1 style='font-size:1.3rem'>This PC is sharing an agent</h1>" +
    "<p>Open <b>Kai Terminal</b>, go to <b>AI Providers → Shared Agent → Use a shared agent</b> " +
    "and paste this page's full link into <b>Join a PC</b>.</p>" +
    "<p style='color:#666'>The link works once and expires. Nothing is installed or joined until you do.</p>";
  res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

async function readJson(
  req: http.IncomingMessage,
  limit: number
): Promise<Record<string, unknown>> {
  const declared = Number(req.headers["content-length"] ?? 0);
  if (declared > limit) throw new HttpError(413, "Request too large");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, "Request too large");
    chunks.push(chunk as Buffer);
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  throw new HttpError(400, "Body must be a JSON object");
}

function text(value: unknown, min: number, max: number, field: string): string {
  if (typeof value !== "string" || value.length < min || value.length > max) {
    throw new HttpError(422, `${field} must be ${min} to ${max} characters`);
  }
  return value;
}
