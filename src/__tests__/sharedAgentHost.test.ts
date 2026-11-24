import fs from "fs";
import http from "http";
import type { AddressInfo } from "net";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentLocator } from "../core/sharedAgent/agentRunner";
import { ClientError, HostsClient } from "../core/sharedAgent/client";
import { HostServer, taskTitle, type HostServerOptions } from "../core/sharedAgent/hostServer";
import { HostStore, grantsOf } from "../core/sharedAgent/hostStore";
import { defaultGrants, type DeviceGrants } from "../core/sharedAgent/types";
import { buildInviteLink, parseInviteLink } from "../core/sharedAgent/invite";
import { fingerprint, generateKeyPair, seal } from "../core/sharedAgent/secureChannel";
import { MemorySecrets } from "./helpers/integrationsEnv";

const FAKE = path.join(__dirname, "helpers", "fakeSharedAgent.cjs");
const locate: AgentLocator = () => [process.execPath, FAKE];

/** What every Kai client sends; raw calls below add it to look like Kai. */
const KAI = { "x-kai-client": "kai-terminal", "Content-Type": "application/json" };

let dir: string;
let server: HostServer;
let store: HostStore;
let client: HostsClient;
let port: number;
let secrets: MemorySecrets;
let hostSecrets: MemorySecrets;

type Invite = { key: string; fingerprint: string };
const linkFor = (inv: Invite, origin = `http://127.0.0.1:${port}`) =>
  buildInviteLink(origin, inv.key, inv.fingerprint);

const hostOptions = (over: Partial<HostServerOptions> = {}): HostServerOptions => ({
  store,
  locate,
  hostName: "Office-PC",
  version: "9.9.9",
  chatDir: path.join(dir, "chat"),
  networks: () => [],
  secrets: hostSecrets,
  ...over,
});

async function join(name = "Laptop") {
  const invite = server.createInvite(15);
  const target = parseInviteLink(linkFor(invite));
  if (!target) throw new Error("bad link");
  return client.join(target, name);
}

async function runToEnd(hostId: string, message: string, session?: string) {
  const started = await client.startRun(hostId, { agent: "claude", message, session });
  const events: Array<Record<string, unknown>> = [];
  let after = 0;
  for (;;) {
    const r = await client.poll(hostId, started.runId, after);
    for (const e of r.events) {
      after = e.seq;
      events.push(e);
    }
    if (r.finished) break;
  }
  return { ...started, events };
}

/** A plain HTTP POST to the host, as anyone on the network could send. */
async function rawPost(route: string, body: unknown, headers: Record<string, string> = KAI) {
  const res = await fetch(`http://127.0.0.1:${port}${route}`, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

/** Everything that crosses the wire, both ways, as text: what a sniffer or tunnel sees. */
function wiretap(): { fetchImpl: typeof fetch; seen: string[]; calls: string[] } {
  const seen: string[] = [];
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push(String(input));
    seen.push(String(input), JSON.stringify(init?.headers ?? {}), String(init?.body ?? ""));
    const res = await fetch(input, init);
    const text = await res.text();
    seen.push(text);
    return new Response(text, { status: res.status, headers: res.headers });
  }) as typeof fetch;
  return { fetchImpl, seen, calls };
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-shared-host-"));
  secrets = new MemorySecrets();
  hostSecrets = new MemorySecrets();
  store = new HostStore(path.join(dir, "host.json"));
  server = new HostServer(hostOptions());
  port = await server.start(0, "127.0.0.1");
  client = new HostsClient({
    secrets,
    file: path.join(dir, "hosts.json"),
    clientName: "Laptop-PC",
  });
});

afterEach(async () => {
  await server.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("host server: joining", () => {
  it("serves a landing page and a health check that says nothing about this PC", async () => {
    const page = await fetch(`http://127.0.0.1:${port}/join`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Kai Terminal");
    expect(page.headers.get("x-content-type-options")).toBe("nosniff");
    expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
    const health = (await (await fetch(`http://127.0.0.1:${port}/api/health`)).json()) as Record<
      string,
      unknown
    >;
    expect(health).toEqual({ ok: true, service: "kai-terminal", protocol: "kai-sc-1" });
  });

  it("no longer serves the old plain-text endpoints", async () => {
    expect((await rawPost("/api/pair/key", { device_name: "x", key: "y" })).status).toBe(404);
    const me = await fetch(`http://127.0.0.1:${port}/api/device/me`, {
      headers: { ...KAI, Authorization: "Bearer anything" },
    });
    expect(me.status).toBe(404);
  });

  it("joins with an invite, keeping every secret out of the files", async () => {
    const invite = server.createInvite(15);
    const host = await client.join(parseInviteLink(linkFor(invite))!, "Amit-Laptop");
    // The name the person typed wins; the host's own name is kept alongside it.
    expect(host).toMatchObject({
      name: "Amit-Laptop",
      hostName: "Office-PC",
      connected: true,
      origin: `http://127.0.0.1:${port}`,
    });
    const stored = JSON.parse((await secrets.get(`kai/shared-agent/host/${host.id}`)) as string);
    expect(stored.privateKey).toBeTruthy();
    const hostKey = (await hostSecrets.get("kai/shared-agent/host-identity")) as string;
    expect(hostKey).toBeTruthy();
    // Only public keys and tags on disk: no private key and no invite secret.
    const files = [path.join(dir, "host.json"), path.join(dir, "hosts.json")]
      .map((f) => fs.readFileSync(f, "utf8"))
      .join("\n");
    for (const secret of [stored.privateKey, hostKey, invite.key]) {
      expect(files).not.toContain(secret);
    }
  });

  it("shows the same safety code on both PCs", async () => {
    const host = await join();
    expect(server.safetyCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(client.safetyCodeOf(host.id)).toBe(server.safetyCode);
  });

  it("names a joined PC after its host when no name is typed", async () => {
    const invite = server.createInvite(15);
    const host = await client.join(parseInviteLink(linkFor(invite))!);
    expect(host.name).toBe("Office-PC");
  });

  it("lets an invite work exactly once", async () => {
    const invite = server.createInvite(15);
    const target = parseInviteLink(linkFor(invite))!;
    await client.join(target);
    await expect(client.join(target)).rejects.toMatchObject({ code: "rejected" });
  });

  it("refuses a cancelled, expired or wrong invite", async () => {
    const cancelled = server.createInvite(5);
    server.cancelInvite(cancelled.id);
    await expect(client.join(parseInviteLink(linkFor(cancelled))!)).rejects.toBeInstanceOf(
      ClientError
    );

    const old = server.createInvite(5);
    server["opts"].store.write((d) => {
      d.invites[old.id].createdMs -= 6 * 60_000;
    });
    await expect(client.join(parseInviteLink(linkFor(old))!)).rejects.toMatchObject({
      code: "rejected",
    });

    const good = server.createInvite(5);
    const wrong = { key: "B".repeat(43), fingerprint: good.fingerprint };
    await expect(client.join(parseInviteLink(linkFor(wrong))!)).rejects.toMatchObject({
      code: "rejected",
    });
  });

  it("rate-limits wrong invite attempts per address", async () => {
    const valid = server.createInvite(5);
    const bad = parseInviteLink(linkFor({ key: "C".repeat(43), fingerprint: valid.fingerprint }))!;
    for (let i = 0; i < 10; i++) await client.join(bad).catch(() => {});
    await expect(client.join(bad)).rejects.toMatchObject({ code: "busy" });
    // Even a valid invite is refused while the address is locked out.
    await expect(client.join(parseInviteLink(linkFor(valid))!)).rejects.toMatchObject({
      code: "busy",
    });
  });

  it("gives a PC that joins again a new row, and cuts off the old one", async () => {
    const a = await join("Laptop");
    const b = await join("Laptop");
    expect(b.id).toBe(a.id); // the same entry on this PC ...
    const devices = server.devices();
    expect(devices).toHaveLength(2); // ... but never another PC's row on the host
    expect(devices.filter((d) => d.state === "disconnected")).toHaveLength(1);
    await expect(client.me(b.id)).resolves.toMatchObject({ hostName: "Office-PC" });
  });

  it("voids open invites when the host restarts (their secrets were in memory only)", async () => {
    const invite = server.createInvite(60);
    await server.stop();
    server = new HostServer(hostOptions());
    await server.start(port, "127.0.0.1");
    await expect(client.join(parseInviteLink(linkFor(invite))!)).rejects.toMatchObject({
      code: "rejected",
    });
  });
});

describe("host server: end-to-end encryption", () => {
  it("puts no secret, name, prompt or answer on the wire", async () => {
    const tap = wiretap();
    const watched = new HostsClient({
      secrets,
      file: path.join(dir, "hosts-tap.json"),
      clientName: "Laptop-PC",
      fetchImpl: tap.fetchImpl,
    });
    const invite = server.createInvite(15);
    const host = await watched.join(parseInviteLink(linkFor(invite))!);
    const { runId } = await watched.startRun(host.id, {
      agent: "claude",
      message: "classified briefing notes",
    });
    let after = 0;
    for (let done = false; !done;) {
      const r = await watched.poll(host.id, runId, after);
      for (const e of r.events) after = e.seq;
      done = r.finished;
    }
    const wire = tap.seen.join("\n");
    const deviceKey = JSON.parse(
      (await secrets.get(`kai/shared-agent/host/${host.id}`)) as string
    ).privateKey;
    const hostKey = (await hostSecrets.get("kai/shared-agent/host-identity")) as string;
    for (const s of [
      invite.key,
      invite.fingerprint,
      deviceKey,
      hostKey,
      "classified briefing notes",
      "echo:",
      "Laptop-PC",
      "Office-PC",
      "claude",
    ]) {
      expect(wire, s).not.toContain(s);
    }
    // Only the secure-channel endpoints were called.
    expect(new Set(tap.calls.map((u) => new URL(u).pathname))).toEqual(
      new Set(["/api/sc/hello", "/api/sc/call"])
    );
  });

  it("refuses a host that can't prove the key in the invite link, and sends it nothing", async () => {
    const tap = wiretap();
    const watched = new HostsClient({
      secrets,
      file: path.join(dir, "hosts-tap.json"),
      fetchImpl: tap.fetchImpl,
    });
    const invite = server.createInvite(15);
    // The link names some other host: whoever answers here is not it.
    const elsewhere = { key: invite.key, fingerprint: fingerprint(generateKeyPair().publicKey) };
    await expect(watched.join(parseInviteLink(linkFor(elsewhere))!)).rejects.toMatchObject({
      code: "rejected",
      message: expect.stringMatching(/could not prove/),
    });
    expect(tap.calls.map((u) => new URL(u).pathname)).toEqual(["/api/sc/hello"]);
    expect(server.devices()).toHaveLength(0);
  });

  it("refuses a host whose key changed after joining (someone took its address)", async () => {
    const host = await join();
    await server.stop();
    // Same address, same files, but a different identity key: an impostor.
    server = new HostServer(hostOptions({ secrets: new MemorySecrets() }));
    await server.start(port, "127.0.0.1");
    await expect(client.me(host.id)).rejects.toMatchObject({
      code: "rejected",
      message: expect.stringMatching(/could not prove/),
    });
  });

  it("keeps working across a host restart: the identity key is kept in the secret store", async () => {
    const host = await join();
    await server.stop();
    server = new HostServer(hostOptions());
    await server.start(port, "127.0.0.1");
    await expect(client.me(host.id)).resolves.toMatchObject({ hostName: "Office-PC" });
  });

  it("refuses a captured message sent again, and any altered message", async () => {
    const tap = wiretap();
    const watched = new HostsClient({
      secrets,
      file: path.join(dir, "hosts-tap.json"),
      fetchImpl: tap.fetchImpl,
    });
    const invite = server.createInvite(15);
    const host = await watched.join(parseInviteLink(linkFor(invite))!);
    await watched.me(host.id);
    const captured = tap.seen[tap.seen.length - 2]; // the request body of that /me call
    const replay = await rawPost("/api/sc/call", captured);
    expect(replay.status).toBe(409);

    const body = JSON.parse(captured) as { s: string; n: number; c: string };
    const flipped = body.c.slice(0, 10) + (body.c[10] === "A" ? "B" : "A") + body.c.slice(11);
    const altered = await rawPost("/api/sc/call", { ...body, n: body.n + 1, c: flipped });
    expect(altered.status).toBe(401);
    // The real client carries on.
    await expect(watched.me(host.id)).resolves.toMatchObject({ hostName: "Office-PC" });
  });

  it("one forged message cannot end somebody else's session (the session id is public)", async () => {
    const tap = wiretap();
    const watched = new HostsClient({
      secrets,
      file: path.join(dir, "hosts-tap2.json"),
      fetchImpl: tap.fetchImpl,
    });
    const host = await watched.join(parseInviteLink(linkFor(server.createInvite(15)))!);
    await watched.me(host.id);
    const captured = JSON.parse(tap.seen[tap.seen.length - 2]) as {
      s: string;
      n: number;
      c: string;
    };
    const handshakes = () => tap.calls.filter((u) => u.endsWith("/api/sc/hello")).length;
    const before = handshakes();

    const forged = await rawPost("/api/sc/call", { ...captured, n: captured.n + 1, c: "AAAA" });
    expect(forged.status).toBe(401);

    // Same session, no new handshake: the forgery did not end it.
    await expect(watched.me(host.id)).resolves.toMatchObject({ hostName: "Office-PC" });
    expect(handshakes()).toBe(before);
  });

  it("but a session that keeps receiving forgeries is dropped", async () => {
    const tap = wiretap();
    const watched = new HostsClient({
      secrets,
      file: path.join(dir, "hosts-tap3.json"),
      fetchImpl: tap.fetchImpl,
    });
    const host = await watched.join(parseInviteLink(linkFor(server.createInvite(15)))!);
    await watched.me(host.id);
    const captured = JSON.parse(tap.seen[tap.seen.length - 2]) as {
      s: string;
      n: number;
      c: string;
    };
    const handshakes = () => tap.calls.filter((u) => u.endsWith("/api/sc/hello")).length;
    const before = handshakes();

    for (let i = 0; i < 5; i++) {
      await rawPost("/api/sc/call", { ...captured, n: captured.n + 1 + i, c: "AAAA" });
    }
    await expect(watched.me(host.id)).resolves.toMatchObject({ hostName: "Office-PC" });
    expect(handshakes()).toBe(before + 1); // it had to reconnect
  });

  it("gives nothing to someone who knows a PC's id but not its key", async () => {
    await join();
    const [device] = server.devices();
    const hello = await rawPost("/api/sc/hello", {
      v: 1,
      mode: "device",
      tag: device.id,
      e: generateKeyPair().publicKey,
    });
    expect(hello.status).toBe(200); // the host proves itself to anyone who asks ...
    const sid = hello.json.sid as string;
    const guess = seal(Buffer.alloc(32, 7), sid, "c2s", 1, Buffer.alloc(32), "{}");
    const call = await rawPost("/api/sc/call", { s: sid, n: 1, c: guess });
    expect(call.status).toBe(401); // ... but nothing is answered without the PC's key
  });

  it("refuses a handshake or call from anything that is not Kai Terminal", async () => {
    const hello = await rawPost(
      "/api/sc/hello",
      { v: 1, mode: "pair", tag: "x".repeat(22), e: generateKeyPair().publicKey },
      { "Content-Type": "application/json" }
    );
    expect(hello.status).toBe(403);
    expect(hello.json.detail).toMatch(/Kai Terminal/);
    const call = await rawPost(
      "/api/sc/call",
      { s: "x", n: 1, c: "AAAA" },
      {
        "Content-Type": "application/json",
      }
    );
    expect(call.status).toBe(403);
  });

  it("marks every reply as Kai Terminal", async () => {
    const health = await fetch(`http://127.0.0.1:${port}/api/health`);
    expect(health.headers.get("x-kai-service")).toBe("kai-terminal");
    const refused = await fetch(`http://127.0.0.1:${port}/nope`);
    expect(refused.headers.get("x-kai-service")).toBe("kai-terminal");
  });

  it("will not join or use a host that is not Kai Terminal", async () => {
    // Plays an Agent Bridge host: answers anything, no Kai header.
    const other = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "connected", device_id: "d1", device_token: "t" }));
    });
    await new Promise<void>((r) => other.listen(0, "127.0.0.1", () => r()));
    const otherPort = (other.address() as AddressInfo).port;
    try {
      const invite = server.createInvite(15);
      const target = parseInviteLink(linkFor(invite, `http://127.0.0.1:${otherPort}`))!;
      await expect(client.join(target)).rejects.toMatchObject({
        code: "rejected",
        message: expect.stringMatching(/not a Kai Terminal host/),
      });
      expect(client.list()).toHaveLength(0);
    } finally {
      await new Promise<void>((r) => other.close(() => r()));
    }
  });

  it("calls a tunnel's gateway error unreachable, not a foreign host", async () => {
    const gateway: typeof fetch = async () => new Response("Bad Gateway", { status: 502 });
    const viaGateway = new HostsClient({
      secrets,
      file: path.join(dir, "hosts-gw.json"),
      fetchImpl: gateway,
    });
    const invite = server.createInvite(15);
    await expect(
      viaGateway.join(parseInviteLink(linkFor(invite, "https://share.example.com"))!)
    ).rejects.toMatchObject({ code: "unreachable" });
  });
});

describe("host server: authorization", () => {
  it("answers 404 for unknown routes and runs of another PC", async () => {
    const host = await join();
    expect((await client.deviceRequest(host.id, "GET", "/nope")).status).toBe(404);
    expect((await client.deviceRequest(host.id, "GET", "/runs/abcd1234/poll")).status).toBe(404);
  });

  it("stops working for a PC the host disconnected, and the client notices", async () => {
    const host = await join();
    await client.me(host.id);
    const [device] = server.devices();
    expect(server.disconnectDevice(device.id)).toBe(true);
    await expect(client.me(host.id)).rejects.toMatchObject({ code: "removed" });
    expect(client.get(host.id)?.connected).toBe(false);
    expect(await secrets.get(`kai/shared-agent/host/${host.id}`)).toBeNull();
    expect(server.devices()[0].state).toBe("disconnected");
  });

  it("removes a device and its history", async () => {
    await join();
    const [device] = server.devices();
    expect(server.removeDevice(device.id)).toBe(true);
    expect(server.devices()).toHaveLength(0);
  });

  it("lets a PC leave by itself", async () => {
    const host = await join();
    await client.leave(host.id);
    expect(client.list()).toHaveLength(0);
    expect(server.devices()[0].state).toBe("disconnected");
  });
});

describe("host server: chat runs", () => {
  it("lists the shared agents in /me", async () => {
    const host = await join();
    const me = await client.me(host.id);
    expect(me.hostName).toBe("Office-PC");
    expect(me.agents.find((a) => a.id === "claude")).toMatchObject({ available: true });
    expect(me.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("runs the agent and streams its events, then records usage", async () => {
    const host = await join("Amit-Laptop");
    const { events, sessionId } = await runToEnd(host.id, "hello there");
    expect(sessionId).toBeTruthy();
    const types = events.map((e) => e.type);
    expect(types[0]).toBe("start");
    expect(types).toContain("text");
    expect(events.find((e) => e.type === "text")).toMatchObject({ text: "echo: hello there" });
    const end = events[events.length - 1];
    expect(end).toMatchObject({ type: "end", status: "completed" });
    expect(end.tokens).toEqual({ input: 10, output: 5, cache_read: 2, cache_write: 1 });
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));

    const [device] = server.devices();
    expect(device.usage).toMatchObject({
      runs: 1,
      input: 10,
      output: 5,
      cacheRead: 2,
      cacheWrite: 1,
    });
    expect(device.usage.costUsd).toBeCloseTo(0.01);
  });

  it("resumes a conversation with the agent's own session id", async () => {
    const host = await join();
    const first = await runToEnd(host.id, "one");
    const second = await runToEnd(host.id, "two", first.sessionId);
    expect(second.sessionId).toBe(first.sessionId);
    const [device] = server.devices();
    expect(device.usage.runs).toBe(2);
  });

  it("runs in an empty folder it owns, never anywhere else", async () => {
    const host = await join();
    const res = await client.deviceRequest(host.id, "POST", "/runs", {
      agent: "claude",
      workspace: "C:\\Users\\me\\secrets",
      prompt: "x",
    });
    expect(res.status).toBe(403);
    // The refused request never created, let alone entered, a folder.
    expect(fs.existsSync(path.join(dir, "chat"))).toBe(false);
  });

  it("allows one task per PC at a time", async () => {
    const host = await join();
    const first = await client.startRun(host.id, { agent: "claude", message: "SLOW please" });
    await expect(
      client.startRun(host.id, { agent: "claude", message: "again" })
    ).rejects.toMatchObject({
      code: "busy",
    });
    await client.stop(host.id, first.runId);
    await server.runs.get(first.runId)?.done();
  });

  it("can stop a running task", async () => {
    const host = await join();
    const { runId } = await client.startRun(host.id, { agent: "claude", message: "SLOW" });
    await client.stop(host.id, runId);
    const run = server.runs.get(runId)!;
    await run.done();
    expect(run.status).toBe("stopped");
    expect(run.events[run.events.length - 1]).toMatchObject({ type: "end", status: "stopped" });
  });

  it("reports an agent that fails", async () => {
    const host = await join();
    const { events } = await runToEnd(host.id, "FAIL now");
    const end = events[events.length - 1];
    expect(end).toMatchObject({ type: "end", status: "failed" });
    expect(String(end.error)).toContain("fake agent exploded");
  });

  it("refuses an agent the host turned off", async () => {
    const host = await join();
    server.setAgentEnabled("claude", false);
    await expect(
      client.startRun(host.id, { agent: "claude", message: "hi" })
    ).rejects.toMatchObject({
      code: "rejected",
    });
    expect((await client.me(host.id)).agents.find((a) => a.id === "claude")).toBeUndefined();
  });

  it("stops every run when sharing is turned off", async () => {
    const host = await join();
    const { runId } = await client.startRun(host.id, { agent: "claude", message: "SLOW" });
    const run = server.runs.get(runId)!;
    await server.stop();
    await run.done();
    expect(run.status).toBe("stopped");
    await expect(client.me(host.id)).rejects.toMatchObject({ code: "unreachable" });
  });

  it("rejects oversized and malformed bodies", async () => {
    const host = await join();
    const huge = await client.deviceRequest(host.id, "POST", "/runs", {
      agent: "claude",
      workspace: "chat",
      prompt: "x".repeat(600 * 1024),
    });
    expect(huge.status).toBe(413);
    const junk = await client.deviceRequest(host.id, "POST", "/runs", [1, 2]);
    expect(junk.status).toBe(400);
    const missing = await client.deviceRequest(host.id, "POST", "/runs", {
      agent: "claude",
      workspace: "chat",
    });
    expect(missing.status).toBe(422);
  });
});

describe("host server: per-PC permissions and history", () => {
  /** A device-API call on the encrypted channel of `client`'s joined host. */
  async function raw(hostId: string, method: "GET" | "POST", route: string, body?: unknown) {
    const r = await client.deviceRequest(hostId, method, route, body ?? {});
    return { status: r.status, json: r.data };
  }

  const grants = (patch: Partial<DeviceGrants>): DeviceGrants => ({ ...defaultGrants(), ...patch });

  async function secondPc() {
    const other = new HostsClient({
      secrets: new MemorySecrets(),
      file: path.join(dir, "hosts-2.json"),
      clientName: "Desk-PC",
    });
    const invite = server.createInvite(15);
    const host = await other.join(parseInviteLink(linkFor(invite))!);
    return { other, host };
  }

  it("gives a new PC every shared agent, the agent's default model and a 10-minute limit", async () => {
    const host = await join();
    const [device] = server.devices();
    expect(device.grants).toEqual(defaultGrants());
    const me = await raw(host.id, "GET", "/me");
    expect(me.json.max_minutes).toBe(10);
    expect((me.json.agents as Array<Record<string, unknown>>).map((a) => [a.id, a.model])).toEqual([
      ["claude", ""],
      ["opencode", ""],
    ]);
  });

  it("applies permissions to one PC only", async () => {
    const host = await join();
    const { other, host: otherHost } = await secondPc();
    const laptop = server.devices().find((d) => d.name === "Laptop-PC")!;
    const off = grants({ agents: { claude: false, opencode: true } });
    expect(server.setDeviceGrants(laptop.id, off)).toBe(true);

    expect((await client.me(host.id)).agents.map((a) => a.id)).toEqual(["opencode"]);
    await expect(
      client.startRun(host.id, { agent: "claude", message: "hi" })
    ).rejects.toMatchObject({ code: "rejected" });
    // The other PC is untouched.
    expect((await other.me(otherHost.id)).agents.map((a) => a.id)).toContain("claude");
    expect(server.devices().find((d) => d.name === "Desk-PC")!.grants).toEqual(defaultGrants());
  });

  it("keeps the host-wide switch on top of a PC's permission", async () => {
    const host = await join();
    server.setAgentEnabled("claude", false);
    expect(server.devices()[0].grants.agents.claude).toBe(true);
    expect((await client.me(host.id)).agents.find((a) => a.id === "claude")).toBeUndefined();
  });

  it("runs with the model the host chose for that PC, over the one the PC asks for", async () => {
    const host = await join();
    const [device] = server.devices();
    server.setDeviceGrants(device.id, grants({ models: { claude: "claude-haiku-test" } }));
    const me = await raw(host.id, "GET", "/me");
    expect((me.json.agents as Array<Record<string, unknown>>)[0].model).toBe("claude-haiku-test");

    const started = await raw(host.id, "POST", "/runs", {
      agent: "claude",
      workspace: "chat",
      prompt: "which model",
      model: "something-else",
    });
    const run = server.runs.get(started.json.run_id as string)!;
    await run.done();
    expect(run.init.model).toBe("claude-haiku-test");
    expect(run.events.find((e) => e.type === "text")).toMatchObject({
      text: "echo: which model [model=claude-haiku-test]",
    });
  });

  it("never lets a PC pick the model: the host's account pays", async () => {
    const host = await join();
    const ok = await raw(host.id, "POST", "/runs", {
      agent: "claude",
      workspace: "chat",
      prompt: "hi",
      model: "the-most-expensive-model",
    });
    const run = server.runs.get(ok.json.run_id as string)!;
    await run.done();
    expect(run.init.model).toBeNull();
  });

  it("gives each run that PC's time limit", async () => {
    const host = await join();
    const [device] = server.devices();
    server.setDeviceGrants(device.id, grants({ maxMinutes: 3 }));
    expect((await raw(host.id, "GET", "/me")).json.max_minutes).toBe(3);
    const { runId } = await client.startRun(host.id, { agent: "claude", message: "SLOW" });
    const run = server.runs.get(runId)!;
    expect(run.init.maxMinutes).toBe(3);
    server.stopRun(runId);
    await run.done();
  });

  it("stops a running task when the host takes that agent away from the PC", async () => {
    const host = await join();
    const [device] = server.devices();
    const { runId } = await client.startRun(host.id, { agent: "claude", message: "SLOW" });
    const run = server.runs.get(runId)!;
    // A change that keeps the agent leaves the run alone.
    server.setDeviceGrants(device.id, grants({ maxMinutes: 5 }));
    expect(run.finished).toBe(false);
    server.setDeviceGrants(device.id, grants({ agents: { claude: false, opencode: true } }));
    await run.done();
    expect(run.status).toBe("stopped");
    expect(run.stopReason).toBe("permission removed by the host");
  });

  it("never hands a joining PC another PC's permissions; unknown PCs are refused", async () => {
    await join();
    const [device] = server.devices();
    server.setDeviceGrants(device.id, grants({ maxMinutes: 7 }));
    // Same name, same address, new invite: still a new row with the defaults.
    await join();
    const fresh = server.devices().find((d) => d.id !== device.id)!;
    expect(fresh.grants).toEqual(defaultGrants());
    expect(server.setDeviceGrants("nope", defaultGrants())).toBe(false);
    expect(server.deviceHistory("nope")).toBeNull();
  });

  it("records each task with its outcome, newest first, and totals per agent", async () => {
    const host = await join();
    const [device] = server.devices();
    expect(server.deviceHistory(device.id)).toMatchObject({ tasks: [], lastUsedAt: "" });

    await runToEnd(host.id, "  what   is\n a mutex?  ");
    await runToEnd(host.id, "FAIL please");
    const h = server.deviceHistory(device.id)!;
    expect(h.tasks.map((t) => [t.title, t.status, t.agent])).toEqual([
      ["FAIL please", "failed", "claude"],
      ["what is a mutex?", "completed", "claude"],
    ]);
    expect(h.tasks[1]).toMatchObject({
      tokens: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1 },
      costUsd: 0.01,
      model: "",
    });
    expect(h.tasks[0].error).toContain("fake agent exploded");
    expect(h.byAgent.claude).toMatchObject({ runs: 2, input: 10 });
    expect(h.byAgent.opencode).toBeUndefined();
    expect(h.usage.runs).toBe(2);
    expect(h.lastUsedAt).toBeTruthy();
    // Persisted: a fresh store sees the same history.
    const reloaded = new HostStore(path.join(dir, "host.json"));
    expect(reloaded.read((d) => d.devices[device.id].tasks)).toHaveLength(2);
  });

  it("keeps the last 100 tasks while the totals keep counting", async () => {
    const host = await join();
    const [device] = server.devices();
    store.write((d) => {
      const dev = d.devices[device.id];
      dev.usage.runs = 100;
      dev.tasks = Array.from({ length: 100 }, (_, i) => ({
        id: `old-${i}`,
        agent: "claude" as const,
        model: "",
        title: `old ${i}`,
        status: "completed" as const,
        startedAt: new Date(0).toISOString(),
        endedAt: new Date(0).toISOString(),
        durationS: 1,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        costUsd: 0,
        error: "",
      }));
    });
    await runToEnd(host.id, "newest");
    const h = server.deviceHistory(device.id)!;
    expect(h.tasks).toHaveLength(100);
    expect(h.tasks[0].title).toBe("newest");
    expect(h.tasks[h.tasks.length - 1].title).toBe("old 1");
    expect(h.usage.runs).toBe(101);
  });

  it("forgets a PC's history when it is removed", async () => {
    const host = await join();
    await runToEnd(host.id, "remember me");
    const [device] = server.devices();
    server.removeDevice(device.id);
    expect(server.deviceHistory(device.id)).toBeNull();
    expect(fs.readFileSync(path.join(dir, "host.json"), "utf8")).not.toContain("remember me");
  });

  it("reads devices saved before permissions existed with the defaults", () => {
    expect(grantsOf({})).toEqual(defaultGrants());
    const partial = { agents: { claude: false } } as unknown as DeviceGrants;
    expect(grantsOf({ grants: partial })).toEqual({
      ...defaultGrants(),
      agents: { claude: false, opencode: true },
    });
  });

  it("titles a task by its first words", () => {
    expect(taskTitle("  a\n\tb  ")).toBe("a b");
    const long = taskTitle("word ".repeat(100));
    expect(long.length).toBe(120);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("host server: internet tunnel", () => {
  const TUNNEL = "https://share.example.com";
  /** Plays a tunnel: the https address is relayed to the local server over loopback, with X-Forwarded-For. */
  const viaTunnel =
    (forwardedFor = "203.0.113.7"): typeof fetch =>
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const local = url.startsWith(TUNNEL)
        ? `http://127.0.0.1:${port}${url.slice(TUNNEL.length)}`
        : url;
      const headers = {
        ...((init?.headers as Record<string, string>) ?? {}),
        "x-forwarded-for": forwardedFor,
      };
      return fetch(local, { ...init, headers });
    };
  const remoteClient = (fetchImpl: typeof fetch = viaTunnel()) =>
    new HostsClient({
      secrets,
      file: path.join(dir, "hosts-remote.json"),
      clientName: "Remote-PC",
      fetchImpl,
    });
  const tunnelLink = (inv: Invite) => parseInviteLink(linkFor(inv, TUNNEL))!;

  it("refuses tunnel traffic until an internet address is set", async () => {
    const invite = server.createInvite(15);
    await expect(remoteClient().join(tunnelLink(invite))).rejects.toMatchObject({
      code: "rejected",
      message: expect.stringMatching(/internet access off/),
    });
  });

  it("joins and chats through the tunnel, and a tunnel PC is cut off when it is turned off", async () => {
    server.setPublicUrl(TUNNEL);
    expect(server.publicUrl).toBe(TUNNEL);
    const remote = remoteClient();
    const invite = server.createInvite(15);
    const host = await remote.join(tunnelLink(invite));
    expect(host.origin).toBe(TUNNEL);
    expect(server.devices()[0]).toMatchObject({ name: "Remote-PC", address: "203.0.113.7" });
    expect(store.read((d) => Object.values(d.devices)[0].network)).toBe("tunnel");
    expect((await remote.me(host.id)).hostName).toBe("Office-PC");

    server.setPublicUrl(null);
    await expect(remote.me(host.id)).rejects.toMatchObject({
      code: "rejected",
      message: expect.stringMatching(/internet access off/),
    });
  });

  it("keeps a PC on the kind of network it joined from (loopback is no wildcard)", async () => {
    server.setPublicUrl(TUNNEL);
    const invite = server.createInvite(15);
    const host = await remoteClient().join(tunnelLink(invite));
    // The same PC's key, but arriving as a direct local connection (a TCP forwarder
    // on the host, ssh -R, ngrok tcp): refused, because it joined through the tunnel.
    const direct = (async (input: string | URL | Request, init?: RequestInit) =>
      fetch(String(input).replace(TUNNEL, `http://127.0.0.1:${port}`), init)) as typeof fetch;
    await expect(remoteClient(direct).me(host.id)).rejects.toMatchObject({
      message: expect.stringMatching(/joined over the internet/),
    });
    // And a PC that joined locally can't come in through the tunnel.
    const local = await join();
    const rows = JSON.parse(fs.readFileSync(path.join(dir, "hosts.json"), "utf8"));
    rows.hosts[0].origin = TUNNEL;
    fs.writeFileSync(path.join(dir, "hosts-moved.json"), JSON.stringify(rows));
    const moved = new HostsClient({
      secrets,
      file: path.join(dir, "hosts-moved.json"),
      fetchImpl: viaTunnel(),
    });
    await expect(moved.me(local.id)).rejects.toMatchObject({
      message: expect.stringMatching(/network it joined from/),
    });
  });

  it("rate-limits wrong invite tags per internet client, not for the whole tunnel", async () => {
    server.setPublicUrl(TUNNEL);
    const attacker = viaTunnel("198.51.100.1");
    const attempt = () =>
      attacker(`${TUNNEL}/api/sc/hello`, {
        method: "POST",
        headers: KAI,
        body: JSON.stringify({
          v: 1,
          mode: "pair",
          tag: "Z".repeat(22),
          e: generateKeyPair().publicKey,
        }),
      });
    for (let i = 0; i < 10; i++) await attempt();
    expect((await attempt()).status).toBe(429);
    const invite = server.createInvite(15);
    await expect(remoteClient().join(tunnelLink(invite))).resolves.toMatchObject({
      connected: true,
    });
  });
});

describe("joined PCs file", () => {
  it("reads rows saved before internet links (ip + port) and drops unsafe ones", () => {
    const file = path.join(dir, "legacy-hosts.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        hosts: [
          { id: "a", name: "Office", ip: "192.168.1.20", port: 8765, connected: true },
          { id: "b", name: "Evil", ip: "8.8.8.8", port: 80, connected: true },
          { id: "c", name: "Cloud", origin: "https://share.example.com", connected: true },
          { id: "d", name: "Plain", origin: "http://share.example.com", connected: true },
        ],
      })
    );
    const list = new HostsClient({ secrets, file }).list();
    expect(list.map((h) => [h.id, h.origin])).toEqual([
      ["a", "http://192.168.1.20:8765"],
      ["c", "https://share.example.com"],
    ]);
    expect(list[0]).not.toHaveProperty("ip");
  });
});

describe("host server: other coding CLIs", () => {
  it("lists CLIs found on this PC that cannot be shared, with the reason", async () => {
    const other = new HostServer({
      store,
      locate,
      detectOtherClis: () => [{ id: "agy", name: "Antigravity (agy)", reason: "not read-only" }],
      hostName: "Office-PC",
      version: "9.9.9",
      chatDir: path.join(dir, "chat2"),
      networks: () => [],
    });
    await other.refreshProbes(true);
    expect(other.otherClis()).toEqual([
      { id: "agy", name: "Antigravity (agy)", reason: "not read-only" },
    ]);
    // Shareable agents stay in their own list; the others never get a switch.
    expect(other.agentRows().map((a) => a.id)).not.toContain("agy");
  });

  it("keeps sharing working when detection throws", async () => {
    const other = new HostServer({
      store,
      locate,
      detectOtherClis: () => {
        throw new Error("PATH unreadable");
      },
      hostName: "Office-PC",
      version: "9.9.9",
      chatDir: path.join(dir, "chat3"),
      networks: () => [],
    });
    await other.refreshProbes(true);
    expect(other.otherClis()).toEqual([]);
    expect(other.agentRows().length).toBeGreaterThan(0);
  });
});
