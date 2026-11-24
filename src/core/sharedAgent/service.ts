/**
 * The Shared Agent service: one long-lived Node process (the engine,
 * `dist/cli/shared-agent.js`) that the desktop app supervises. It owns:
 *  - the joined PCs (and a heartbeat that tells the UI which are reachable),
 *  - chat with a joined PC's agent (only ever a joined PC: there is no local fallback),
 *  - the optional host server that shares this PC's agents.
 * Requests are one JSON object each; answers and pushed events are one JSON
 * line each (see `types.ts`). Nothing here touches the UI.
 */
import os from "os";
import path from "path";
import type { SecretStore } from "../integrations/secretStore";
import { defaultSecretStore } from "../integrations/secretStore";
import {
  AgentError,
  RunRejected,
  defaultLocator,
  type AgentLocator,
  type OtherCliDetector,
} from "./agentRunner";
import {
  ClientError,
  HostsClient,
  displayAddress,
  type HostRecord,
  type WireEvent,
} from "./client";
import { fromWireTokens, textOf } from "./events";
import { HostStore, sharedAgentDir } from "./hostStore";
import { HostServer, HttpError, PortInUseError, isPortFree } from "./hostServer";
import { allowedOrigin, buildInviteLink, parseInviteLink, parsePublicUrl } from "./invite";
import { lanAddresses, type LocalNetwork } from "./netcheck";
import {
  INVITE_MINUTES,
  MAX_MESSAGE_CHARS,
  MAX_SHARE_PORT,
  MIN_SHARE_PORT,
  parseSharePort,
  type PortCheck,
  GrantsError,
  isSharedAgentId,
  parseGrants,
  type AgentView,
  type JoinedHost,
  type SharedAgentEvent,
  type SharedAgentRequest,
  type SharedAgentResponse,
  type ShareStatus,
  type SharedAgentErrorCode,
  type TokenTotals,
} from "./types";

export interface ServiceDeps {
  /** Where pushed events go (the desktop app turns them into UI events). */
  emit: (event: SharedAgentEvent) => void;
  secrets?: SecretStore;
  fetchImpl?: typeof fetch;
  locate?: AgentLocator;
  /** Finds the other (not shareable) coding CLIs; defaults to the real PATH. */
  detectOtherClis?: OtherCliDetector;
  networks?: () => LocalNetwork[];
  /** Heartbeat period; 0 turns it off (tests). */
  heartbeatMs?: number;
  version?: string;
  hostName?: string;
  /** Overrides `~/.kai/shared-agent` (tests). */
  dir?: string;
  /** Overrides the saved port (tests pass 0 for any free port). */
  sharePort?: number;
  /** Address the host listens on (default: every interface, so the LAN can reach it). */
  bindHost?: string;
}

interface HostStatus {
  online: boolean;
  latencyMs: number | null;
  checkedAt: string;
  agents: AgentView[];
  message?: string;
}

interface ChatState {
  id: string;
  aborter: AbortController;
  stopped: boolean;
  hostId: string | null;
  runId?: string;
}

const POLL_FAILURES_BEFORE_DROP = 3;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

class BadRequest extends Error {}

const fail = (code: SharedAgentErrorCode, message: string): SharedAgentResponse => ({
  ok: false,
  error: { code, message },
});

function str(v: unknown, field: string, max = 200): string {
  if (typeof v !== "string" || !v || v.length > max) throw new BadRequest(`Invalid ${field}.`);
  return v;
}

export class SharedAgentService {
  private readonly client: HostsClient;
  private readonly host: HostServer;
  private readonly store: HostStore;
  private readonly locate: AgentLocator;
  private readonly chatDir: string;
  private readonly chats = new Map<string, ChatState>();
  private readonly status = new Map<string, HostStatus>();
  private checking: Promise<void> | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private shareTimer: NodeJS.Timeout | null = null;
  private lastHostsJson = "";

  constructor(private readonly deps: ServiceDeps) {
    const dir = deps.dir ?? sharedAgentDir();
    this.locate = deps.locate ?? defaultLocator;
    this.chatDir = path.join(dir, "chat");
    const secrets = deps.secrets ?? defaultSecretStore();
    this.client = new HostsClient({
      secrets,
      fetchImpl: deps.fetchImpl,
      file: path.join(dir, "hosts.json"),
    });
    this.store = new HostStore(path.join(dir, "host.json"));
    this.host = new HostServer({
      store: this.store,
      locate: this.locate,
      detectOtherClis: deps.detectOtherClis,
      hostName: deps.hostName ?? (os.hostname() || "PC"),
      version: deps.version ?? "0.0.0",
      chatDir: this.chatDir,
      networks: deps.networks,
      secrets,
      onChange: () => this.shareChanged(),
    });
    const period = deps.heartbeatMs ?? 15_000;
    if (period > 0) {
      this.heartbeat = setInterval(() => void this.checkHosts().catch(() => {}), period);
      this.heartbeat.unref?.();
    }
  }

  // ---------------------------------------------------------------- dispatch

  async handle(req: SharedAgentRequest): Promise<SharedAgentResponse> {
    try {
      return await this.dispatch(req);
    } catch (e) {
      if (e instanceof BadRequest) return fail("bad_request", e.message);
      if (e instanceof ClientError) return fail(e.code, e.message);
      if (e instanceof HttpError) return fail(e.status === 429 ? "busy" : "rejected", e.message);
      if (e instanceof RunRejected) return fail("busy", e.message);
      if (e instanceof AgentError) return fail("unavailable", e.message);
      return fail("failed", e instanceof Error ? e.message : "Unexpected error.");
    }
  }

  private async dispatch(req: SharedAgentRequest): Promise<SharedAgentResponse> {
    switch (req.op) {
      case "ping":
        return { ok: true, pong: true };
      case "hosts_list": {
        // Answer at once with what is known; the check runs in the background and its
        // result arrives as a `hosts` event. Waiting on every PC (an offline one takes
        // seconds to time out) is what made the panel sit on "Loading…".
        if (req.refresh || this.status.size === 0) void this.checkHosts().catch(() => {});
        return { ok: true, hosts: this.hostsView() };
      }
      case "host_join": {
        const target = parseInviteLink(str(req.link, "link", 600));
        if (!target) throw new BadRequest("That is not a valid invite link.");
        const record = await this.client.join(target, req.name);
        await this.checkOne(record.id);
        this.pushHosts();
        return { ok: true, host: this.viewOf(this.client.get(record.id) ?? record) };
      }
      case "host_leave": {
        await this.client.leave(str(req.hostId, "hostId"));
        this.status.delete(req.hostId);
        this.pushHosts();
        return { ok: true };
      }
      case "chat_send":
        return this.chatSend(req);
      case "chat_stop":
        this.stopChat(str(req.chatId, "chatId"));
        return { ok: true };
      case "share_status":
        if (req.refresh) {
          // Looking for installed agents runs each one's `--version` (seconds on Windows).
          // Once they have been found, answer at once with what is known and push the
          // re-check's result as a `share` event; only the very first look has to wait.
          const check = this.host.refreshProbes(true).then(() => this.shareChanged());
          if (this.host.probed) check.catch(() => {});
          else await check.catch(() => {});
        }
        return { ok: true, share: this.shareStatus() };
      case "share_set": {
        if (req.port !== undefined) this.setPort(req.port);
        if (req.enabled) await this.startSharing();
        else {
          await this.host.stop();
          this.deps.emit({ event: "share" });
        }
        return { ok: true, share: this.shareStatus() };
      }
      case "port_check":
        return { ok: true, port: await this.checkPort(req.port) };
      case "share_agent": {
        if (!isSharedAgentId(req.agent)) throw new BadRequest("Unknown agent.");
        this.host.setAgentEnabled(req.agent, req.enabled === true);
        return { ok: true, share: this.shareStatus() };
      }
      case "share_public_url": {
        if (req.url === null || req.url === "") {
          this.host.setPublicUrl(null);
        } else {
          const url = parsePublicUrl(str(req.url, "url", 300));
          if (!url) {
            throw new BadRequest(
              "Paste the HTTPS address your tunnel gave you, e.g. https://my-pc.example.com"
            );
          }
          this.host.setPublicUrl(url);
        }
        return { ok: true, share: this.shareStatus() };
      }
      case "invite_create": {
        if (!(INVITE_MINUTES as readonly number[]).includes(req.expiresMinutes)) {
          throw new BadRequest(
            "Invite lifetime must be 5, 15 or 60 minutes, or until you turn it off."
          );
        }
        const port = this.host.port;
        if (port === null) throw new BadRequest("Turn sharing on first.");
        const invite = this.host.createInvite(req.expiresMinutes);
        const ip = lanAddresses(this.deps.networks?.())[0] ?? "127.0.0.1";
        const publicUrl = this.host.publicUrl;
        return {
          ok: true,
          share: this.shareStatus(),
          invite: {
            id: invite.id,
            link: buildInviteLink(`http://${ip}:${port}`, invite.key, invite.fingerprint),
            ...(publicUrl
              ? { internetLink: buildInviteLink(publicUrl, invite.key, invite.fingerprint) }
              : {}),
            expiresInSeconds: invite.expiresInSeconds,
          },
        };
      }
      case "invite_cancel":
        this.host.cancelInvite(str(req.id, "id"));
        return { ok: true, share: this.shareStatus() };
      case "device_disconnect":
        this.host.disconnectDevice(str(req.id, "id"));
        return { ok: true, share: this.shareStatus() };
      case "device_remove":
        this.host.removeDevice(str(req.id, "id"));
        return { ok: true, share: this.shareStatus() };
      case "device_grants": {
        let grants;
        try {
          grants = parseGrants(req.grants);
        } catch (e) {
          if (e instanceof GrantsError) throw new BadRequest(e.message);
          throw e;
        }
        if (!this.host.setDeviceGrants(str(req.id, "id"), grants)) {
          throw new BadRequest("That PC is not in the list any more.");
        }
        return { ok: true, share: this.shareStatus() };
      }
      case "device_history": {
        const history = this.host.deviceHistory(str(req.id, "id"));
        if (!history) throw new BadRequest("That PC is not in the list any more.");
        return { ok: true, history };
      }
      case "run_stop":
        this.host.stopRun(str(req.runId, "runId"));
        return { ok: true, share: this.shareStatus() };
      default:
        throw new BadRequest("Unknown request.");
    }
  }

  /** Stops sharing, ends every run and timer. Safe to call twice. */
  async close(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.shareTimer) clearTimeout(this.shareTimer);
    for (const chat of this.chats.values()) this.abortChat(chat);
    await this.host.stop();
  }

  // ---------------------------------------------------------------- joined PCs

  private viewOf(h: HostRecord): JoinedHost {
    const s = this.status.get(h.id);
    return {
      id: h.id,
      name: h.name,
      hostName: h.hostName,
      address: displayAddress(h.origin),
      internet: allowedOrigin(h.origin)?.tunnel === true,
      connectedAt: h.connectedAt,
      connected: h.connected,
      safetyCode: this.client.safetyCodeOf(h.id),
      online: h.connected ? (s?.online ?? null) : null,
      latencyMs: s?.latencyMs ?? null,
      checkedAt: s?.checkedAt ?? null,
      agents: s?.agents ?? [],
      usage: { ...h.usage },
      ...(s?.message ? { message: s.message } : {}),
    };
  }

  private hostsView(): JoinedHost[] {
    return this.client.list().map((h) => this.viewOf(h));
  }

  private pushHosts(force = false): void {
    const hosts = this.hostsView();
    // Latency jitters; only push when something a person would notice changed.
    const key = JSON.stringify(hosts.map((h) => ({ ...h, latencyMs: null, checkedAt: null })));
    if (!force && key === this.lastHostsJson) return;
    this.lastHostsJson = key;
    this.deps.emit({ event: "hosts", hosts });
  }

  private async checkOne(id: string): Promise<void> {
    const host = this.client.get(id);
    if (!host || !host.connected) return;
    const checkedAt = new Date().toISOString();
    try {
      const me = await this.client.me(id);
      this.status.set(id, { online: true, latencyMs: me.latencyMs, checkedAt, agents: me.agents });
    } catch (e) {
      const message = e instanceof Error ? e.message : "";
      const prev = this.status.get(id);
      if (e instanceof ClientError && e.code === "unreachable") {
        this.status.set(id, {
          online: false,
          latencyMs: null,
          checkedAt,
          agents: prev?.agents ?? [],
          message,
        });
      } else if (e instanceof ClientError && e.code === "removed") {
        this.status.delete(id);
      } else {
        this.status.set(id, {
          online: true,
          latencyMs: null,
          checkedAt,
          agents: prev?.agents ?? [],
          message,
        });
      }
    }
  }

  /** Checks every joined PC. Overlapping calls share one check. */
  private checkHosts(): Promise<void> {
    if (this.checking) return this.checking;
    const ids = this.client
      .list()
      .filter((h) => h.connected)
      .map((h) => h.id);
    const run = async () => {
      if (ids.length) await Promise.all(ids.map((id) => this.checkOne(id)));
      this.pushHosts();
    };
    // `.finally` always runs after this assignment, even when `run` finishes at once.
    const check = run().finally(() => {
      if (this.checking === check) this.checking = null;
    });
    this.checking = check;
    return check;
  }

  // ---------------------------------------------------------------- chat

  private emitChat(chatId: string, kind: string, payload: Record<string, unknown> = {}): void {
    this.deps.emit({ event: "chat", chatId, kind, ...payload } as SharedAgentEvent);
  }

  private chatSend(req: Extract<SharedAgentRequest, { op: "chat_send" }>): SharedAgentResponse {
    const chatId = str(req.chatId, "chatId", 80);
    if (!isSharedAgentId(req.agent)) throw new BadRequest("Unknown agent.");
    if (
      typeof req.message !== "string" ||
      !req.message.trim() ||
      req.message.length > MAX_MESSAGE_CHARS
    ) {
      throw new BadRequest(`Messages must be 1 to ${MAX_MESSAGE_CHARS} characters.`);
    }
    if (this.chats.has(chatId))
      return fail("busy", "That chat is already answering. Stop it first.");
    const hostId = req.hostId === null ? null : str(req.hostId, "hostId");
    if (!hostId || !this.client.get(hostId)?.connected) {
      throw new BadRequest("Join a PC first: paste its invite link, then chat with its agent.");
    }
    const chat: ChatState = { id: chatId, aborter: new AbortController(), stopped: false, hostId };
    this.chats.set(chatId, chat);
    void this.runChat(chat, req)
      .catch((e: unknown) => {
        const message = e instanceof Error ? e.message : "The chat failed.";
        this.emitChat(chatId, "end", { status: "failed", error: message, route: "none" });
      })
      .finally(() => this.chats.delete(chatId));
    return { ok: true, chatId };
  }

  /** Chat with the joined PC's agent. Only ever that PC: nothing runs on this one. */
  private async runChat(
    chat: ChatState,
    req: Extract<SharedAgentRequest, { op: "chat_send" }>
  ): Promise<void> {
    const host = chat.hostId ? this.client.get(chat.hostId) : undefined;
    if (!host?.connected) {
      this.emitChat(chat.id, "end", {
        status: "failed",
        route: "shared",
        error: "That PC is not joined any more. Join it again with a new invite link.",
      });
      return;
    }
    await this.runShared(chat, req, host);
  }

  /** Forwards one wire event to the UI. Returns the `end` payload when it is the last one. */
  private forward(chat: ChatState, ev: WireEvent): WireEvent | null {
    switch (ev.type) {
      case "text":
        this.emitChat(chat.id, "text", { text: textOf(ev.text) });
        break;
      case "delta":
        // A piece of the answer as it is written (newer hosts); `text` follows with the whole block.
        this.emitChat(chat.id, "delta", { text: textOf(ev.text) });
        break;
      case "tool":
        this.emitChat(chat.id, "tool", {
          name: textOf(ev.name, "tool"),
          detail: textOf(ev.detail),
        });
        break;
      case "tool_result":
        this.emitChat(chat.id, "tool_result", {
          error: ev.error === true,
          text: textOf(ev.text),
        });
        break;
      case "denied":
        this.emitChat(chat.id, "denied", {
          tool: textOf(ev.tool, "tool"),
          text: textOf(ev.text),
        });
        break;
      case "log":
      case "error":
        this.emitChat(chat.id, "log", { text: textOf(ev.text) });
        break;
      case "end":
        return ev;
      default:
        break; // start, session, ping: nothing to show
    }
    return null;
  }

  private finishChat(
    chat: ChatState,
    end: WireEvent | null,
    sessionId?: string
  ): { status: string; tokens: TokenTotals; costUsd: unknown } {
    const tokens = fromWireTokens(end?.tokens);
    const status = chat.stopped ? "stopped" : textOf(end?.status, "failed");
    const error = textOf(end?.error);
    this.emitChat(chat.id, "end", {
      status,
      error,
      route: "shared",
      tokens,
      costUsd: end?.cost_usd ?? null,
      ...(sessionId ? { sessionId } : {}),
    });
    return { status, tokens, costUsd: end?.cost_usd ?? null };
  }

  private async runShared(
    chat: ChatState,
    req: Extract<SharedAgentRequest, { op: "chat_send" }>,
    host: HostRecord
  ): Promise<void> {
    let started: { runId: string; sessionId: string };
    try {
      started = await this.client.startRun(host.id, {
        agent: req.agent,
        message: req.message,
        session: req.session,
      });
    } catch (e) {
      if (e instanceof ClientError && (e.code === "unreachable" || e.code === "removed")) {
        this.markOffline(host.id, e);
      }
      const why = e instanceof Error && e.message ? e.message : "it could not start the chat";
      this.emitChat(chat.id, "end", {
        status: chat.stopped ? "stopped" : "failed",
        route: "shared",
        error: `${host.name}: ${why}`,
      });
      return;
    }
    chat.runId = started.runId;
    this.emitChat(chat.id, "route", { route: "shared", hostId: host.id, hostName: host.name });
    this.emitChat(chat.id, "session", { sessionId: started.sessionId });

    let after = 0;
    let failures = 0;
    let end: WireEvent | null = null;
    for (;;) {
      if (chat.stopped) {
        await this.client.stop(host.id, started.runId);
        await this.waitForHostToEnd(host.id, started.runId, after);
        this.finishChat(chat, null, started.sessionId);
        return;
      }
      let batch: { events: WireEvent[]; finished: boolean };
      try {
        batch = await this.client.poll(host.id, started.runId, after, chat.aborter.signal);
        failures = 0;
      } catch (e) {
        if (chat.stopped) continue; // the stop check above ends the run
        if (e instanceof ClientError && (e.code === "unreachable" || e.code === "removed")) {
          if (e.code === "unreachable" && ++failures < POLL_FAILURES_BEFORE_DROP) {
            await sleep(1000);
            continue;
          }
          this.markOffline(host.id, e);
          this.emitChat(chat.id, "end", {
            status: "failed",
            route: "shared",
            error: `${host.name} stopped answering. Send your message again when it is back.`,
          });
          return;
        }
        throw e;
      }
      for (const ev of batch.events) {
        after = Math.max(after, ev.seq);
        end = this.forward(chat, ev) ?? end;
      }
      if (batch.finished) break;
    }
    const outcome = this.finishChat(chat, end, started.sessionId);
    if (outcome.status !== "stopped") {
      // Whatever the run used (a failed one too) counts against that PC.
      this.client.addUsage(host.id, outcome.tokens, outcome.costUsd);
      this.pushHosts(true);
    }
  }

  /**
   * After a stop, waits until the host reports the run really ended, so an immediate
   * next message is not refused as "already running". Bounded: the host may be gone.
   */
  private async waitForHostToEnd(hostId: string, runId: string, after: number): Promise<void> {
    const deadline = Date.now() + 4000;
    let seen = after;
    while (Date.now() < deadline) {
      const batch = await this.client
        .poll(hostId, runId, seen, AbortSignal.timeout(Math.max(250, deadline - Date.now())))
        .catch(() => null);
      if (!batch || batch.finished) return;
      for (const ev of batch.events) seen = Math.max(seen, ev.seq);
    }
  }

  private markOffline(hostId: string, e: ClientError): void {
    const prev = this.status.get(hostId);
    if (e.code === "removed") this.status.delete(hostId);
    else {
      this.status.set(hostId, {
        online: false,
        latencyMs: null,
        checkedAt: new Date().toISOString(),
        agents: prev?.agents ?? [],
        message: e.message,
      });
    }
    this.pushHosts();
  }

  private stopChat(chatId: string): void {
    const chat = this.chats.get(chatId);
    if (!chat) return;
    this.abortChat(chat);
  }

  private abortChat(chat: ChatState): void {
    chat.stopped = true;
    chat.aborter.abort();
  }

  // ---------------------------------------------------------------- share

  private async startSharing(): Promise<void> {
    if (this.host.port !== null) return;
    try {
      await this.host.start(this.deps.sharePort ?? this.store.port, this.deps.bindHost);
    } catch (e) {
      if (e instanceof PortInUseError) throw new ClientError("unavailable", e.message);
      throw new ClientError(
        "unavailable",
        `Could not start sharing: ${e instanceof Error ? e.message : "unknown error"}`
      );
    }
    this.deps.emit({ event: "share" });
  }

  /** Changes the port sharing uses next. Only while sharing is off. */
  private setPort(value: unknown): void {
    const port = parseSharePort(value);
    if (port === null) {
      throw new BadRequest(`Port must be a number from ${MIN_SHARE_PORT} to ${MAX_SHARE_PORT}.`);
    }
    if (this.host.port !== null && this.host.port !== port) {
      throw new BadRequest("Stop sharing before changing the port.");
    }
    this.store.setPort(port);
  }

  private async checkPort(value: unknown): Promise<PortCheck> {
    const port = parseSharePort(value);
    if (port === null) {
      throw new BadRequest(`Port must be a number from ${MIN_SHARE_PORT} to ${MAX_SHARE_PORT}.`);
    }
    if (this.host.port === port) {
      return { port, available: true, ours: true, message: `Kai is sharing on port ${port}.` };
    }
    const available = await isPortFree(port, this.deps.bindHost);
    return {
      port,
      available,
      ours: false,
      message: available
        ? `Port ${port} is free.`
        : `Port ${port} is already in use by another program. Choose another port.`,
    };
  }

  shareStatus(): ShareStatus {
    const port = this.host.port;
    return {
      enabled: port !== null,
      port: port ?? this.store.port,
      listening:
        port === null
          ? null
          : {
              port,
              urls: lanAddresses(this.deps.networks?.()).map((ip) => `http://${ip}:${port}`),
            },
      publicUrl: this.host.publicUrl,
      agents: this.host.agentRows(),
      otherClis: this.host.otherClis(),
      invites: this.host.openInvites(),
      devices: this.host.devices(),
      runs: this.host.activeRuns(),
      safetyCode: port === null ? null : this.host.safetyCode,
    };
  }

  /** Coalesces bursts (a run emits many changes) into one UI refresh. */
  private shareChanged(): void {
    if (this.shareTimer) return;
    this.shareTimer = setTimeout(() => {
      this.shareTimer = null;
      this.deps.emit({ event: "share" });
    }, 250);
    this.shareTimer.unref?.();
  }
}
