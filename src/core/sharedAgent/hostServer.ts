/**
 * The host: a small HTTP server that lets PCs on the same network chat with
 * this PC's agents. It speaks the Agent Bridge device protocol, so Agent
 * Bridge PCs can join a Kai host and Kai can join an Agent Bridge host.
 *
 * Security model (see SECURITY.md):
 *  - Off until a person turns sharing on in this session.
 *  - Only addresses on a subnet this PC is attached to (or this PC) are served,
 *    plus, only while the host has set an internet (tunnel) address, PCs that
 *    reach it through that tunnel (any HTTPS tunnel or reverse proxy). A
 *    relayed request is recognised by its forwarding headers or the tunnel's
 *    host name and never gets the trust of a local or LAN caller.
 *  - A PC joins with a one-time, expiring invite secret (256 bits, kept as a
 *    hash, rate limited per address). It then gets a random bearer token, kept
 *    as a hash. A token only works from the subnet it was issued on (a tunnel
 *    token only through the tunnel, and only while the tunnel is set).
 *  - Agents run read-only in an empty folder; no file, shell or MCP access.
 *  - Plain HTTP on the LAN: trusted networks only, never port-forward. Over the
 *    internet only through an HTTPS tunnel (it terminates TLS, then relays to
 *    this server).
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
  probeAgent,
  type AgentLocator,
  type AgentProbe,
  type OtherCliDetector,
  type Run,
} from "./agentRunner";
import {
  digest,
  grantsOf,
  inviteExpired,
  sameDigest,
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
import {
  MAX_TASKS_PER_DEVICE,
  MODEL_RE,
  SHARED_AGENT_IDS,
  SHARED_AGENT_NAMES,
  emptyUsage,
  isSharedAgentId,
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
const MAX_PROMPT_CHARS = 200_000;
const MAX_OPEN_INVITES = 10;
const MAX_DEVICES = 50;
const MAX_SESSIONS_PER_DEVICE = 60;
const KEY_MAX_FAILURES = 10; // wrong invite secrets allowed per address ...
const KEY_FAILURE_WINDOW_MS = 300_000; // ... in this long
const PROBE_TTL_MS = 60_000;
const POLL_WAIT_MS = 8_000;
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
    message: string
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
        client: tunnelClientIp(req.headers),
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
    await this.refreshProbes(true);
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
    // A no-time-limit invite lives for one sharing session; drop any left by a crash.
    this.cancelUntilOffInvites();
    return this.boundPort;
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
          inv.status = "cancelled";
          n++;
        }
      }
      return n > 0;
    });
    if (changed) this.opts.onChange?.();
  }

  // ---------------------------------------------------------------- admin (called by the service)

  async refreshProbes(force = false): Promise<void> {
    if (!force && Date.now() - this.probedAt < PROBE_TTL_MS) return;
    const probes = await Promise.all(SHARED_AGENT_IDS.map((a) => probeAgent(a, this.opts.locate)));
    this.probes = new Map(probes.map((p) => [p.id, p]));
    try {
      this.others = (this.opts.detectOtherClis ?? detectOtherClis)();
    } catch {
      this.others = []; // listing extra agents must never break sharing
    }
    this.probedAt = Date.now();
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

  /** The secret is returned once; only its hash is kept. */
  createInvite(minutes: InviteMinutes): {
    id: string;
    key: string;
    expiresInSeconds: number | null;
  } {
    if (this.openInvites().length >= MAX_OPEN_INVITES) {
      throw new HttpError(429, "Too many open invites. Cancel one first.");
    }
    const key = randomToken(32);
    const id = randomToken(9);
    this.opts.store.write((d) => {
      d.invites[id] = {
        id,
        keyHash: digest(key),
        status: "open",
        createdMs: Date.now(),
        createdAt: new Date().toISOString(),
        ttlSeconds: minutes * 60,
      };
    });
    this.opts.onChange?.();
    return { id, key, expiresInSeconds: minutes === 0 ? null : minutes * 60 };
  }

  cancelInvite(id: string): boolean {
    const ok = this.opts.store.write((d) => {
      const inv = d.invites[id];
      if (!inv) return false;
      if (inv.status === "open") inv.status = "cancelled";
      return true;
    });
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
        send(res, e.status, { detail: e.message });
      } else if (!res.headersSent) {
        send(res, 500, { detail: "Internal error" });
      }
    }
  }

  private async route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", "http://host");
    const p = url.pathname;

    if (method === "GET" && (p === "/" || p === "/join")) return landing(res);
    if (method === "GET" && p === "/api/health") {
      const { net } = this.origin(req);
      return send(res, 200, {
        ok: true,
        service: "kai-terminal",
        version: this.opts.version,
        time: new Date().toISOString(),
        same_network: net !== null,
        is_host: net === "loopback",
      });
    }
    if (method === "POST" && p === "/api/pair/key") return this.pair(req, res);

    if (p.startsWith("/api/device/")) {
      const device = this.requireDevice(req);
      if (method === "GET" && p === "/api/device/me") return this.me(res, device);
      if (method === "POST" && p === "/api/device/disconnect") return this.leave(res, device);
      if (method === "POST" && p === "/api/device/runs") return this.startRun(req, res, device);
      const m = /^\/api\/device\/runs\/([A-Za-z0-9_-]{4,40})\/(poll|stop)$/.exec(p);
      if (m) {
        const run = this.runs.get(m[1]);
        if (!run || run.init.deviceId !== device.id) throw new HttpError(404, "Run not found");
        if (method === "GET" && m[2] === "poll") return this.poll(res, run, url);
        if (method === "POST" && m[2] === "stop") {
          return send(res, 200, { stopped: this.runs.stop(run.id, "stopped by that PC") });
        }
      }
    }
    throw new HttpError(404, "Not found");
  }

  private requireDevice(req: http.IncomingMessage): DeviceRecord {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith("Bearer ")) {
      throw new HttpError(401, "Device token required. Join this host first.");
    }
    const hashed = digest(auth.slice(7).trim());
    const device = this.opts.store.read((d) =>
      Object.values(d.devices).find(
        (x) => x.status === "approved" && sameDigest(x.tokenHash, hashed)
      )
    );
    if (!device)
      throw new HttpError(401, "This PC is not approved (unknown or removed). Join again.");
    const { net, client, tunnel } = this.origin(req);
    if (net === null && tunnel) {
      throw new HttpError(403, "This host has turned internet access off.");
    }
    if (net === null || (net !== "loopback" && net !== device.network)) {
      throw new HttpError(
        403,
        device.network === TUNNEL_NETWORK
          ? "This PC joined over the internet. Connect through the host's internet link."
          : "This PC is not on the network it joined from. Connect to the host's LAN."
      );
    }
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

  private async pair(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const { net, client: remote, tunnel } = this.origin(req);
    if (net === null) {
      throw new HttpError(
        403,
        tunnel
          ? "This host has turned internet access off, so it can't be joined over the internet."
          : "This PC is not on the same local network as the host, so it can't join."
      );
    }
    if (!this.keyAttemptAllowed(remote)) {
      throw new HttpError(429, "Too many wrong invite attempts. Wait a few minutes and try again.");
    }
    const body = await readJson(req);
    const name = text(body.device_name, 2, 64, "device_name");
    const platform =
      body.platform === undefined ? "Windows" : text(body.platform, 1, 32, "platform");
    const key = text(body.key, 8, 128, "key").trim();
    const hashed = digest(key);
    const token = randomToken(40);

    const deviceId = this.opts.store.write((d) => {
      const now = Date.now();
      const invite = Object.values(d.invites).find(
        (i) => i.status === "open" && sameDigest(i.keyHash, hashed)
      );
      if (!invite || inviteExpired(invite, now)) return null;
      // The same PC joining again (same name and address) keeps its row and history.
      const old = Object.values(d.devices).find((x) => x.name === name && x.ip === remote);
      if (!old && Object.keys(d.devices).length >= MAX_DEVICES) return "full" as const;
      const rec: DeviceRecord = old ?? {
        id: randomToken(15),
        name,
        platform,
        ip: remote,
        network: net,
        status: "approved",
        tokenHash: "",
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
        tokenHash: digest(token),
        lastSeen: new Date(now).toISOString(),
        lastSeenMs: now,
      });
      d.devices[rec.id] = rec;
      invite.status = "used";
      invite.usedAt = new Date(now).toISOString();
      invite.deviceId = rec.id;
      return rec.id;
    });
    if (deviceId === "full")
      throw new HttpError(409, "This host has reached its limit of joined PCs.");
    if (!deviceId) {
      this.keyFailed(remote);
      throw new HttpError(
        401,
        "This invite link is wrong, already used, cancelled or expired. Ask the host for a new one."
      );
    }
    this.opts.onChange?.();
    send(res, 200, {
      status: "connected",
      device_id: deviceId,
      device_token: token,
      host_name: this.opts.hostName,
    });
  }

  private me(res: http.ServerResponse, device: DeviceRecord): void {
    const active = this.runs.activeFor(device.id);
    const grants = grantsOf(device);
    send(res, 200, {
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
        })),
      workspaces: [],
      allow_connectors: false,
      max_minutes: grants.maxMinutes,
      chat_workspace: "chat",
      host_name: this.opts.hostName,
      active_run: active ? { id: active.id, status: active.status } : null,
    });
  }

  private leave(res: http.ServerResponse, device: DeviceRecord): void {
    this.disconnectDevice(device.id);
    send(res, 200, { status: "disconnected" });
  }

  private async startRun(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    device: DeviceRecord
  ): Promise<void> {
    const body = await readJson(req);
    const agent = body.agent;
    const grants = grantsOf(device);
    if (!isSharedAgentId(agent) || !this.opts.store.agentEnabled(agent) || !grants.agents[agent]) {
      throw new HttpError(403, "This PC is not allowed to use that agent");
    }
    if (body.workspace !== "chat") {
      throw new HttpError(403, "Only plain chat is shared by this host");
    }
    const prompt = text(body.prompt, 1, MAX_PROMPT_CHARS, "prompt");
    // The host's choice for this PC wins over anything the PC asks for.
    const asked = typeof body.model === "string" ? body.model.trim() : "";
    const model = grants.models[agent] || asked || null;
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
        maxMinutes: grants.maxMinutes,
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
    send(res, 200, {
      run_id: run.id,
      session_id: sessionId,
      level: "read",
      resumed: Boolean(resume),
    });
  }

  private async poll(res: http.ServerResponse, run: Run, url: URL): Promise<void> {
    const after = Math.max(0, Number.parseInt(url.searchParams.get("after") ?? "0", 10) || 0);
    const { events, finished } = await run.wait(after, POLL_WAIT_MS);
    send(res, 200, { events, finished, status: run.status });
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
    this.keyFailures.set(ip, recent);
    return recent.length < KEY_MAX_FAILURES;
  }

  private keyFailed(ip: string): void {
    this.keyFailures.set(ip, [...(this.keyFailures.get(ip) ?? []), Date.now()]);
  }
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

const SECURITY_HEADERS: Record<string, string> = {
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

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const declared = Number(req.headers["content-length"] ?? 0);
  if (declared > MAX_BODY_BYTES) throw new HttpError(413, "Request too large");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "Request too large");
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
