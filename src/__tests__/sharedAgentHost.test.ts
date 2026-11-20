import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentLocator } from "../core/sharedAgent/agentRunner";
import { ClientError, HostsClient } from "../core/sharedAgent/client";
import { HostServer, taskTitle } from "../core/sharedAgent/hostServer";
import { HostStore, grantsOf } from "../core/sharedAgent/hostStore";
import { defaultGrants, type DeviceGrants } from "../core/sharedAgent/types";
import { parseInviteLink } from "../core/sharedAgent/invite";
import { MemorySecrets } from "./helpers/integrationsEnv";

const FAKE = path.join(__dirname, "helpers", "fakeSharedAgent.cjs");
const locate: AgentLocator = () => [process.execPath, FAKE];

let dir: string;
let server: HostServer;
let store: HostStore;
let client: HostsClient;
let port: number;
let secrets: MemorySecrets;

const linkFor = (key: string) => `http://127.0.0.1:${port}/join#${key}`;

async function join(name = "Laptop") {
  const invite = server.createInvite(15);
  const target = parseInviteLink(linkFor(invite.key));
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

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-shared-host-"));
  secrets = new MemorySecrets();
  store = new HostStore(path.join(dir, "host.json"));
  server = new HostServer({
    store,
    locate,
    hostName: "Office-PC",
    version: "9.9.9",
    chatDir: path.join(dir, "chat"),
    networks: () => [],
  });
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
  it("serves a landing page and health, with hardening headers", async () => {
    const page = await fetch(`http://127.0.0.1:${port}/join`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Kai Terminal");
    expect(page.headers.get("x-content-type-options")).toBe("nosniff");
    expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
    const health = (await (await fetch(`http://127.0.0.1:${port}/api/health`)).json()) as Record<
      string,
      unknown
    >;
    expect(health).toMatchObject({
      ok: true,
      service: "kai-terminal",
      version: "9.9.9",
      is_host: true,
    });
  });

  it("joins with an invite, keeping every secret out of the files", async () => {
    const invite = server.createInvite(15);
    const host = await client.join(parseInviteLink(linkFor(invite.key))!, "Amit-Laptop");
    // The name the person typed wins; the host's own name is kept alongside it.
    expect(host).toMatchObject({
      name: "Amit-Laptop",
      hostName: "Office-PC",
      connected: true,
      origin: `http://127.0.0.1:${port}`,
    });
    const token = (await secrets.get(`kai/shared-agent/host/${host.id}`)) as string;
    expect(token).toBeTruthy();
    // Only hashes on the host, and no token on the joining PC: neither file holds a secret.
    const files = [path.join(dir, "host.json"), path.join(dir, "hosts.json")]
      .map((f) => fs.readFileSync(f, "utf8"))
      .join("\n");
    expect(files).not.toContain(token);
    expect(files).not.toContain(invite.key);
  });

  it("names a joined PC after its host when no name is typed", async () => {
    const invite = server.createInvite(15);
    const host = await client.join(parseInviteLink(linkFor(invite.key))!);
    expect(host.name).toBe("Office-PC");
  });

  it("lets an invite work exactly once", async () => {
    const invite = server.createInvite(15);
    const target = parseInviteLink(linkFor(invite.key))!;
    await client.join(target);
    await expect(client.join(target)).rejects.toMatchObject({ code: "rejected" });
  });

  it("refuses a cancelled, expired or wrong invite", async () => {
    const cancelled = server.createInvite(5);
    server.cancelInvite(cancelled.id);
    await expect(client.join(parseInviteLink(linkFor(cancelled.key))!)).rejects.toBeInstanceOf(
      ClientError
    );

    const old = server.createInvite(5);
    new HostStore(path.join(dir, "host.json")); // a second reader sees the same file
    server["opts"].store.write((d) => {
      d.invites[old.id].createdMs -= 6 * 60_000;
    });
    await expect(client.join(parseInviteLink(linkFor(old.key))!)).rejects.toMatchObject({
      code: "rejected",
    });

    await expect(client.join(parseInviteLink(linkFor("B".repeat(43)))!)).rejects.toMatchObject({
      code: "rejected",
    });
  });

  it("rate-limits wrong invite attempts per address", async () => {
    const bad = parseInviteLink(linkFor("C".repeat(43)))!;
    for (let i = 0; i < 10; i++) await client.join(bad).catch(() => {});
    await expect(client.join(bad)).rejects.toMatchObject({ code: "busy" });
    // Even a valid invite is refused while the address is locked out.
    const valid = server.createInvite(5);
    await expect(client.join(parseInviteLink(linkFor(valid.key))!)).rejects.toMatchObject({
      code: "busy",
    });
  });

  it("keeps the same row when the same PC joins again", async () => {
    const a = await join("Laptop");
    const b = await join("Laptop");
    expect(b.id).toBe(a.id);
    expect(server.devices()).toHaveLength(1);
  });
});

describe("host server: authorization", () => {
  it("rejects a missing or wrong token", async () => {
    const none = await fetch(`http://127.0.0.1:${port}/api/device/me`);
    expect(none.status).toBe(401);
    const wrong = await fetch(`http://127.0.0.1:${port}/api/device/me`, {
      headers: { Authorization: "Bearer not-a-real-token" },
    });
    expect(wrong.status).toBe(401);
  });

  it("answers 404 for unknown routes and runs of another PC", async () => {
    const host = await join();
    const token = (await secrets.get(`kai/shared-agent/host/${host.id}`)) as string;
    const unknown = await fetch(`http://127.0.0.1:${port}/api/device/nope`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(unknown.status).toBe(404);
    const missing = await fetch(`http://127.0.0.1:${port}/api/device/runs/abcd1234/poll`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(missing.status).toBe(404);
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
    const token = (await secrets.get(`kai/shared-agent/host/${host.id}`)) as string;
    const res = await fetch(`http://127.0.0.1:${port}/api/device/runs`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ agent: "claude", workspace: "C:\\Users\\me\\secrets", prompt: "x" }),
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
    const token = (await secrets.get(`kai/shared-agent/host/${host.id}`)) as string;
    const h = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    const huge = await fetch(`http://127.0.0.1:${port}/api/device/runs`, {
      method: "POST",
      headers: h,
      body: JSON.stringify({ agent: "claude", workspace: "chat", prompt: "x".repeat(600 * 1024) }),
    });
    expect(huge.status).toBe(413);
    const junk = await fetch(`http://127.0.0.1:${port}/api/device/runs`, {
      method: "POST",
      headers: h,
      body: "[1,2]",
    });
    expect(junk.status).toBe(400);
    const missing = await fetch(`http://127.0.0.1:${port}/api/device/runs`, {
      method: "POST",
      headers: h,
      body: JSON.stringify({ agent: "claude", workspace: "chat" }),
    });
    expect(missing.status).toBe(422);
  });
});

describe("host server: per-PC permissions and history", () => {
  /** A device-API call with the token the given PC saved for that host. */
  async function raw(
    keys: MemorySecrets,
    hostId: string,
    method: string,
    route: string,
    body?: unknown
  ) {
    const token = (await keys.get(`kai/shared-agent/host/${hostId}`)) as string;
    const res = await fetch(`http://127.0.0.1:${port}${route}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  }

  const grants = (patch: Partial<DeviceGrants>): DeviceGrants => ({ ...defaultGrants(), ...patch });

  async function secondPc() {
    const other = new HostsClient({
      secrets: new MemorySecrets(),
      file: path.join(dir, "hosts-2.json"),
      clientName: "Desk-PC",
    });
    const invite = server.createInvite(15);
    const host = await other.join(parseInviteLink(linkFor(invite.key))!);
    return { other, host };
  }

  it("gives a new PC every shared agent, the agent's default model and a 10-minute limit", async () => {
    const host = await join();
    const [device] = server.devices();
    expect(device.grants).toEqual(defaultGrants());
    const me = await raw(secrets, host.id, "GET", "/api/device/me");
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
    const me = await raw(secrets, host.id, "GET", "/api/device/me");
    expect((me.json.agents as Array<Record<string, unknown>>)[0].model).toBe("claude-haiku-test");

    const started = await raw(secrets, host.id, "POST", "/api/device/runs", {
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

  it("uses the model a PC asks for when the host set none, and refuses a malformed one", async () => {
    const host = await join();
    const ok = await raw(secrets, host.id, "POST", "/api/device/runs", {
      agent: "claude",
      workspace: "chat",
      prompt: "hi",
      model: "sonnet",
    });
    const run = server.runs.get(ok.json.run_id as string)!;
    await run.done();
    expect(run.init.model).toBe("sonnet");

    const bad = await raw(secrets, host.id, "POST", "/api/device/runs", {
      agent: "claude",
      workspace: "chat",
      prompt: "hi",
      model: "x; rm -rf /",
    });
    expect(bad.status).toBe(422);
  });

  it("gives each run that PC's time limit", async () => {
    const host = await join();
    const [device] = server.devices();
    server.setDeviceGrants(device.id, grants({ maxMinutes: 3 }));
    expect((await raw(secrets, host.id, "GET", "/api/device/me")).json.max_minutes).toBe(3);
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

  it("keeps permissions when the same PC joins again; unknown PCs are refused", async () => {
    await join();
    const [device] = server.devices();
    server.setDeviceGrants(device.id, grants({ maxMinutes: 7 }));
    server.disconnectDevice(device.id);
    await join();
    expect(server.devices()).toHaveLength(1);
    expect(server.devices()[0].grants.maxMinutes).toBe(7);
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
  const viaTunnel = (forwardedFor = "203.0.113.7"): typeof fetch =>
    (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const local = url.startsWith(TUNNEL)
        ? `http://127.0.0.1:${port}${url.slice(TUNNEL.length)}`
        : url;
      const headers = {
        ...((init?.headers as Record<string, string>) ?? {}),
        "x-forwarded-for": forwardedFor,
      };
      return fetch(local, { ...init, headers });
    }) as typeof fetch;
  const remoteClient = () =>
    new HostsClient({
      secrets,
      file: path.join(dir, "hosts-remote.json"),
      clientName: "Remote-PC",
      fetchImpl: viaTunnel(),
    });

  it("refuses tunnel traffic, and never calls it the host, until an internet address is set", async () => {
    const invite = server.createInvite(15);
    await expect(
      remoteClient().join(parseInviteLink(`${TUNNEL}/join#${invite.key}`)!)
    ).rejects.toMatchObject({
      code: "rejected",
      message: expect.stringMatching(/internet access off/),
    });
    const health = (await (await viaTunnel()(`${TUNNEL}/api/health`)).json()) as Record<
      string,
      unknown
    >;
    expect(health).toMatchObject({ same_network: false, is_host: false });
  });

  it("joins and chats through the tunnel, and a tunnel PC is cut off when it is turned off", async () => {
    server.setPublicUrl(TUNNEL);
    expect(server.publicUrl).toBe(TUNNEL);
    const remote = remoteClient();
    const invite = server.createInvite(15);
    const host = await remote.join(parseInviteLink(`${TUNNEL}/join#${invite.key}`)!);
    expect(host.origin).toBe(TUNNEL);
    expect(server.devices()[0]).toMatchObject({ name: "Remote-PC", address: "203.0.113.7" });
    expect(store.read((d) => Object.values(d.devices)[0].network)).toBe("tunnel");
    expect((await remote.me(host.id)).hostName).toBe("Office-PC");

    // A PC that joined locally can't take its token out through the tunnel.
    const local = await join();
    const token = await secrets.get(`kai/shared-agent/host/${local.id}`);
    const r = await viaTunnel()(`${TUNNEL}/api/device/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(r.status).toBe(403);

    server.setPublicUrl(null);
    await expect(remote.me(host.id)).rejects.toMatchObject({
      code: "rejected",
      message: expect.stringMatching(/internet access off/),
    });
  });

  it("rate-limits wrong invite secrets per internet client, not for the whole tunnel", async () => {
    server.setPublicUrl(TUNNEL);
    const attacker = viaTunnel("198.51.100.1");
    for (let i = 0; i < 10; i++) {
      await attacker(`${TUNNEL}/api/pair/key`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ device_name: "Bad", key: "Z".repeat(43) }),
      });
    }
    const blocked = await attacker(`${TUNNEL}/api/pair/key`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_name: "Bad", key: "Z".repeat(43) }),
    });
    expect(blocked.status).toBe(429);
    const invite = server.createInvite(15);
    await expect(
      remoteClient().join(parseInviteLink(`${TUNNEL}/join#${invite.key}`)!)
    ).resolves.toMatchObject({ connected: true });
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
