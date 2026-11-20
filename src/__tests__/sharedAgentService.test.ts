import fs from "fs";
import os from "os";
import path from "path";
import { PassThrough } from "stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runEngine, serveLoop } from "../core/sharedAgent/serve";
import type { AgentLocator } from "../core/sharedAgent/agentRunner";
import { SharedAgentService } from "../core/sharedAgent/service";
import {
  defaultGrants,
  type AgentView,
  type CreatedInvite,
  type JoinedHost,
  type SharedAgentEvent,
  type SharedAgentRequest,
  type SharedAgentResponse,
  type ShareStatus,
} from "../core/sharedAgent/types";
import { MemorySecrets } from "./helpers/integrationsEnv";

const FAKE = path.join(__dirname, "helpers", "fakeSharedAgent.cjs");
const locate: AgentLocator = () => [process.execPath, FAKE];
const loopback = [
  { address: "127.0.0.1", cidr: "127.0.0.0/8", base: 0x7f000000, mask: 0xff000000 },
];

interface Side {
  svc: SharedAgentService;
  events: SharedAgentEvent[];
}

let dir: string;
let sides: Side[];
let chatSeq = 0;

function makeSide(name: string, extra: { heartbeatMs?: number; located?: boolean } = {}): Side {
  const events: SharedAgentEvent[] = [];
  const svc = new SharedAgentService({
    emit: (e) => events.push(e),
    secrets: new MemorySecrets(),
    locate:
      extra.located === false
        ? () => {
            throw new Error("not installed");
          }
        : locate,
    networks: () => loopback,
    heartbeatMs: extra.heartbeatMs ?? 0,
    hostName: name,
    dir: path.join(dir, name),
    sharePort: 0,
    bindHost: "127.0.0.1",
  });
  const side = { svc, events };
  sides.push(side);
  return side;
}

/** Every field any successful answer can carry (the test knows which one it asked for). */
interface OkAnswer {
  pong?: true;
  hosts: JoinedHost[];
  ownAgents: AgentView[];
  host: JoinedHost;
  chatId: string;
  share: ShareStatus;
  invite: CreatedInvite;
}

async function ok(p: Promise<SharedAgentResponse>): Promise<OkAnswer> {
  const r = await p;
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r as unknown as OkAnswer;
}

async function waitFor<T>(fn: () => T | undefined | false, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 15));
  }
}

type Chat = Array<Record<string, unknown>>;
const chatEvents = (side: Side, id: string): Chat =>
  side.events.filter((e) => e.event === "chat" && e.chatId === id) as unknown as Chat;

async function sendChat(
  side: Side,
  hostId: string | null,
  message: string,
  opts: {
    session?: string | null;
    wait?: boolean;
  } = {}
): Promise<{ id: string; events: () => Chat }> {
  const id = `chat-${++chatSeq}`;
  await ok(
    side.svc.handle({
      op: "chat_send",
      chatId: id,
      hostId,
      agent: "claude",
      message,
      session: opts.session ?? null,
    })
  );
  if (opts.wait !== false) await waitFor(() => chatEvents(side, id).some((e) => e.kind === "end"));
  return { id, events: () => chatEvents(side, id) };
}

/** A host (A) that is sharing, and a receiver (B) that has joined it. */
async function pair(bExtra: { heartbeatMs?: number } = {}) {
  const a = makeSide("Office-PC");
  const b = makeSide("Laptop", bExtra);
  const on = await ok(a.svc.handle({ op: "share_set", enabled: true }));
  expect(on.share.enabled).toBe(true);
  const inv = await ok(a.svc.handle({ op: "invite_create", expiresMinutes: 15 }));
  const joined = await ok(b.svc.handle({ op: "host_join", link: inv.invite.link }));
  return { a, b, host: joined.host };
}

const endOf = (events: Chat) => events.find((e) => e.kind === "end") as Record<string, unknown>;
const kinds = (events: Chat) => events.map((e) => e.kind);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-shared-svc-"));
  sides = [];
});

afterEach(async () => {
  await Promise.all(sides.map((s) => s.svc.close()));
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("sharing and joining", () => {
  it("shares, creates an invite, and another PC joins", async () => {
    const { a, b, host } = await pair();
    const share = (await ok(a.svc.handle({ op: "share_status" }))).share;
    expect(share.listening?.urls[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(share.devices).toHaveLength(1);
    expect(share.invites).toHaveLength(0); // the invite was used up

    expect(host).toMatchObject({ name: "Office-PC", connected: true, online: true });
    expect(host.agents.find((x) => x.id === "claude")?.available).toBe(true);
    const list = await ok(b.svc.handle({ op: "hosts_list" }));
    expect(list.hosts).toHaveLength(1);
    expect(list.ownAgents.find((x) => x.id === "claude")?.available).toBe(true);
  });

  it("needs sharing on before an invite can be made", async () => {
    const a = makeSide("Office-PC");
    const r = await a.svc.handle({ op: "invite_create", expiresMinutes: 15 });
    expect(r).toMatchObject({ ok: false, error: { code: "bad_request" } });
  });

  it("lists, cancels and disconnects", async () => {
    const { a, b, host } = await pair();
    const inv = await ok(a.svc.handle({ op: "invite_create", expiresMinutes: 5 }));
    expect((await ok(a.svc.handle({ op: "share_status" }))).share.invites).toHaveLength(1);
    const after = await ok(a.svc.handle({ op: "invite_cancel", id: inv.invite.id }));
    expect(after.share.invites).toHaveLength(0);
    expect(await b.svc.handle({ op: "host_join", link: inv.invite.link })).toMatchObject({
      ok: false,
    });

    const device = after.share.devices[0];
    const cut = await ok(a.svc.handle({ op: "device_disconnect", id: device.id }));
    expect(cut.share.devices[0].state).toBe("disconnected");
    // The receiver finds out on its next check, and shows it as needing a new link.
    const list = await ok(b.svc.handle({ op: "hosts_list", refresh: true }));
    expect(list.hosts[0]).toMatchObject({ id: host.id, connected: false, online: null });
    const gone = await ok(a.svc.handle({ op: "device_remove", id: device.id }));
    expect(gone.share.devices).toHaveLength(0);
  });

  it("sets one PC's permissions and reads its history", async () => {
    const { a, b, host } = await pair();
    const [device] = (await ok(a.svc.handle({ op: "share_status" }))).share.devices;
    expect(device.grants).toEqual(defaultGrants());

    const set = await ok(
      a.svc.handle({
        op: "device_grants",
        id: device.id,
        grants: { ...defaultGrants(), models: { claude: "  claude-test  " }, maxMinutes: 30 },
      })
    );
    // Stored trimmed, and shown back to the UI.
    expect(set.share.devices[0].grants).toMatchObject({
      models: { claude: "claude-test" },
      maxMinutes: 30,
    });

    const chat = await sendChat(b, host.id, "hello");
    expect(chat.events().find((e) => e.kind === "text")).toMatchObject({
      text: "echo: hello [model=claude-test]",
    });

    const res = await a.svc.handle({ op: "device_history", id: device.id });
    if (!res.ok || !("history" in res)) throw new Error("no history");
    expect(res.history.tasks).toHaveLength(1);
    expect(res.history.tasks[0]).toMatchObject({
      title: "hello",
      model: "claude-test",
      status: "completed",
    });
    expect(res.history.byAgent.claude?.runs).toBe(1);
  });

  it("leaves a host", async () => {
    const { b, host } = await pair();
    await ok(b.svc.handle({ op: "host_leave", hostId: host.id }));
    expect((await ok(b.svc.handle({ op: "hosts_list" }))).hosts).toHaveLength(0);
  });

  it("turns agents off and sharing off", async () => {
    const { a } = await pair();
    const off = await ok(a.svc.handle({ op: "share_agent", agent: "claude", enabled: false }));
    expect(off.share.agents.find((x) => x.id === "claude")?.enabled).toBe(false);
    const stopped = await ok(a.svc.handle({ op: "share_set", enabled: false }));
    expect(stopped.share).toMatchObject({ enabled: false, listening: null });
  });

  it("tells the UI when the host's state changes", async () => {
    const { a } = await pair();
    await ok(a.svc.handle({ op: "invite_create", expiresMinutes: 5 }));
    await waitFor(() => a.events.some((e) => e.event === "share"));
  });

  it("notices a host going away by itself (heartbeat)", async () => {
    const { a, b } = await pair({ heartbeatMs: 40 });
    await ok(a.svc.handle({ op: "share_set", enabled: false }));
    const hosts = await waitFor(() => {
      const last = [...b.events].reverse().find((e) => e.event === "hosts") as
        { hosts: JoinedHost[] } | undefined;
      return last?.hosts[0]?.online === false ? last.hosts : undefined;
    });
    expect(hosts[0].online).toBe(false);
  });
});

describe("chat routing", () => {
  it("answers from the shared agent and counts the tokens against that PC", async () => {
    const { a, b, host } = await pair();
    const chat = await sendChat(b, host.id, "hello shared");
    const events = chat.events();
    expect(kinds(events)).toEqual(expect.arrayContaining(["route", "session", "text", "end"]));
    expect(events.find((e) => e.kind === "route")).toMatchObject({
      route: "shared",
      hostName: "Office-PC",
    });
    expect(events.find((e) => e.kind === "text")).toMatchObject({ text: "echo: hello shared" });
    expect(endOf(events)).toMatchObject({
      status: "completed",
      route: "shared",
      tokens: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1 },
    });

    const list = await ok(b.svc.handle({ op: "hosts_list" }));
    expect(list.hosts[0].usage).toMatchObject({ runs: 1, input: 10, output: 5 });
    const share = (await ok(a.svc.handle({ op: "share_status" }))).share as ShareStatus;
    expect(share.devices[0].usage).toMatchObject({ runs: 1, input: 10, output: 5 });
    // The receiver was told its usage changed.
    expect(b.events.some((e) => e.event === "hosts")).toBe(true);
  });

  it("continues a conversation on the shared agent", async () => {
    const { b, host } = await pair();
    const first = await sendChat(b, host.id, "one");
    const sessionId = String(first.events().find((e) => e.kind === "session")?.sessionId);
    const second = await sendChat(b, host.id, "two", { session: sessionId });
    expect(endOf(second.events())).toMatchObject({ status: "completed", sessionId });
  });

  it("falls back to its own agent automatically when the host is gone", async () => {
    const { a, b, host } = await pair();
    await ok(a.svc.handle({ op: "share_set", enabled: false }));
    const chat = await sendChat(b, host.id, "still there?");
    const events = chat.events();
    expect(events.filter((e) => e.kind === "route").map((e) => e.route)).toEqual(["own"]);
    expect(events.find((e) => e.kind === "text")).toMatchObject({ text: "echo: still there?" });
    expect(endOf(events)).toMatchObject({ status: "completed", route: "own" });
    expect(
      events.some(
        (e) =>
          e.kind === "log" && /your own agent on this PC is answering instead/.test(String(e.text))
      )
    ).toBe(true);
    // Own-agent usage is not counted against the host.
    expect((await ok(b.svc.handle({ op: "hosts_list" }))).hosts[0].usage.runs).toBe(0);
  });

  it("uses its own agent when no PC is joined", async () => {
    const b = makeSide("Laptop");
    const own = (await sendChat(b, null, "solo")).events();
    expect(endOf(own)).toMatchObject({ status: "completed", route: "own" });
  });

  it("says so when its own agent is not installed", async () => {
    const b = makeSide("Laptop", { located: false });
    const events = (await sendChat(b, null, "solo")).events();
    expect(endOf(events)).toMatchObject({ status: "failed", route: "own" });
    expect(String(endOf(events).error)).toMatch(/not available/);
  });

  it("stops a shared run on request", async () => {
    const { a, b, host } = await pair();
    const chat = await sendChat(b, host.id, "SLOW", { wait: false });
    await waitFor(() => chat.events().some((e) => e.kind === "route"));
    await ok(b.svc.handle({ op: "chat_stop", chatId: chat.id }));
    await waitFor(() => chat.events().some((e) => e.kind === "end"));
    expect(endOf(chat.events()).status).toBe("stopped");
    // The receiver only reports "stopped" once the host confirms the run ended,
    // so the host is free for the very next message.
    expect(a.svc.shareStatus().runs).toHaveLength(0);
    const next = await sendChat(b, host.id, "right after stopping");
    expect(endOf(next.events())).toMatchObject({ status: "completed", route: "shared" });
  });

  it("stops its own run on request", async () => {
    const b = makeSide("Laptop");
    const chat = await sendChat(b, null, "SLOW", { wait: false });
    await waitFor(() => chat.events().some((e) => e.kind === "route"));
    await ok(b.svc.handle({ op: "chat_stop", chatId: chat.id }));
    await waitFor(() => chat.events().some((e) => e.kind === "end"));
    expect(endOf(chat.events()).status).toBe("stopped");
  });

  it("switches to its own agent when the host's agent fails before answering", async () => {
    const { b, host } = await pair();
    const events = (await sendChat(b, host.id, "FAIL")).events();
    // The host was tried first, then this PC's own agent (which fails the same way here).
    expect(events.filter((e) => e.kind === "route").map((e) => e.route)).toEqual(["shared", "own"]);
    expect(events.some((e) => e.kind === "log" && /exploded/.test(String(e.text)))).toBe(true);
    expect(endOf(events)).toMatchObject({ route: "own" });
    // The failed run on the host still counts against it.
    expect((await ok(b.svc.handle({ op: "hosts_list" }))).hosts[0].usage.runs).toBe(1);
  });

  it("switches to its own agent when the host is busy or refuses", async () => {
    const { a, b, host } = await pair();
    // The host turns its only agent off: the run is refused, and this PC answers instead.
    await ok(a.svc.handle({ op: "share_agent", agent: "claude", enabled: false }));
    const events = (await sendChat(b, host.id, "refused?")).events();
    expect(events.filter((e) => e.kind === "route").map((e) => e.route)).toEqual(["own"]);
    expect(endOf(events)).toMatchObject({ status: "completed", route: "own" });
  });

  it("goes to its own agent when the host removed this PC", async () => {
    const { a, b, host } = await pair();
    const id = (await ok(a.svc.handle({ op: "share_status" }))).share.devices[0].id;
    await ok(a.svc.handle({ op: "device_remove", id }));
    const events = (await sendChat(b, host.id, "after removal")).events();
    expect(endOf(events)).toMatchObject({ status: "completed", route: "own" });
  });
});

describe("request validation", () => {
  it.each<[string, SharedAgentRequest]>([
    ["a bad link", { op: "host_join", link: "http://8.8.8.8:1/join#abcdefgh" }],
    [
      "an empty message",
      {
        op: "chat_send",
        chatId: "c",
        hostId: null,
        agent: "claude",
        message: "  ",
      },
    ],
    [
      "a huge message",
      {
        op: "chat_send",
        chatId: "c",
        hostId: null,
        agent: "claude",
        message: "x".repeat(20_001),
      },
    ],
    [
      "an unknown agent",
      {
        op: "chat_send",
        chatId: "c",
        hostId: null,
        agent: "evil" as never,
        message: "hi",
      },
    ],
    ["an odd invite lifetime", { op: "invite_create", expiresMinutes: 9999 as never }],
    ["an unknown agent to share", { op: "share_agent", agent: "evil" as never, enabled: true }],
    ["permissions for an unknown PC", { op: "device_grants", id: "nope", grants: defaultGrants() }],
    [
      "a zero time limit",
      { op: "device_grants", id: "nope", grants: { ...defaultGrants(), maxMinutes: 0 } },
    ],
    [
      "a model with shell characters",
      {
        op: "device_grants",
        id: "nope",
        grants: { ...defaultGrants(), models: { claude: "a b" } },
      },
    ],
    ["missing permissions", { op: "device_grants", id: "nope", grants: null as never }],
    ["the history of an unknown PC", { op: "device_history", id: "nope" }],
    ["an unknown op", { op: "nope" } as never],
  ])("rejects %s", async (_n, req) => {
    const svc = makeSide("X").svc;
    expect(await svc.handle(req)).toMatchObject({ ok: false, error: { code: "bad_request" } });
  });

  it("refuses a second chat with the same id", async () => {
    const b = makeSide("Laptop");
    const chat = await sendChat(b, null, "SLOW", { wait: false });
    const again = await b.svc.handle({
      op: "chat_send",
      chatId: chat.id,
      hostId: null,
      agent: "claude",
      message: "x",
    });
    expect(again).toMatchObject({ ok: false, error: { code: "busy" } });
    await ok(b.svc.handle({ op: "chat_stop", chatId: chat.id }));
    await waitFor(() => chat.events().some((e) => e.kind === "end"));
  });

  it("explains an unreachable host when joining", async () => {
    const b = makeSide("Laptop");
    const r = await b.svc.handle({ op: "host_join", link: "http://127.0.0.1:1/join#abcdefghij" });
    expect(r).toMatchObject({ ok: false, error: { code: "unreachable" } });
  });
});

describe("engine process loop (stdio)", () => {
  function loop() {
    const input = new PassThrough();
    const output = new PassThrough();
    const lines: Array<Record<string, unknown>> = [];
    let buf = "";
    output.on("data", (c: Buffer) => {
      buf += c.toString();
      let nl = buf.indexOf("\n");
      while (nl >= 0) {
        lines.push(JSON.parse(buf.slice(0, nl)));
        buf = buf.slice(nl + 1);
        nl = buf.indexOf("\n");
      }
    });
    const done = serveLoop(input, output, {
      secrets: new MemorySecrets(),
      locate,
      networks: () => loopback,
      heartbeatMs: 0,
      dir: path.join(dir, "cli"),
      sharePort: 0,
      bindHost: "127.0.0.1",
    });
    return { input, lines, done };
  }

  it("answers each request with its id, and ends cleanly when input closes", async () => {
    const { input, lines, done } = loop();
    input.write('{"id":1,"op":"ping"}\n{"id":2,"op":"share_status"}\n');
    await waitFor(() => lines.length >= 2);
    expect(lines.find((l) => l.id === 1)).toMatchObject({ ok: true, pong: true });
    expect(lines.find((l) => l.id === 2)).toMatchObject({ ok: true, share: { enabled: false } });
    input.end();
    expect(await done).toBe(0);
  });

  it("answers garbage with an error instead of crashing, and keeps the id", async () => {
    const { input, lines, done } = loop();
    input.write('not json\n[1]\n{"id":5}\n{"id":6,"op":"ping"}\n');
    await waitFor(() => lines.length >= 4);
    expect(lines.filter((l) => l.ok === false)).toHaveLength(3);
    expect(lines.find((l) => l.id === 5)).toMatchObject({ ok: false });
    expect(lines.find((l) => l.id === 6)).toMatchObject({ ok: true });
    input.end();
    await done;
  });

  it("pushes events as lines with an event key and no id", async () => {
    const { input, lines, done } = loop();
    input.write('{"id":1,"op":"share_set","enabled":true}\n');
    await waitFor(() => lines.some((l) => l.id === 1));
    input.write('{"id":2,"op":"invite_create","expiresMinutes":5}\n');
    await waitFor(() => lines.some((l) => l.event === "share"));
    expect(lines.find((l) => l.event === "share")).not.toHaveProperty("id");
    input.end();
    await done;
  });
});

describe("engine entry", () => {
  it("refuses to start when an AI agent launched it, naming the right thing", async () => {
    const errors = new PassThrough();
    let said = "";
    errors.on("data", (c: Buffer) => (said += c.toString()));
    const code = await runEngine({
      env: { CLAUDECODE: "1" },
      processes: async () => [],
      input: new PassThrough(),
      errors,
    });
    expect(code).toBe(1);
    expect(said).toContain("Shared Agent is not available inside an AI agent's session");
    expect(said).not.toContain("Teams");
  });

  it("serves the app's requests when a person started it", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let out = "";
    output.on("data", (c: Buffer) => (out += c.toString()));
    const done = runEngine({
      env: {},
      processes: async () => [],
      input,
      output,
      service: { secrets: new MemorySecrets(), heartbeatMs: 0, dir: path.join(dir, "engine") },
    });
    input.end('{"id":1,"op":"ping"}\n');
    expect(await done).toBe(0);
    expect(JSON.parse(out.trim())).toMatchObject({ id: 1, ok: true, pong: true });
  });
});

describe("sharing on and off", () => {
  it("tells the UI when sharing turns off, not only when it turns on", async () => {
    const a = makeSide("Office-PC");
    await ok(a.svc.handle({ op: "share_set", enabled: true }));
    const before = a.events.filter((e) => e.event === "share").length;
    await ok(a.svc.handle({ op: "share_set", enabled: false }));
    expect(a.events.filter((e) => e.event === "share").length).toBe(before + 1);
  });
});

describe("internet access (tunnel)", () => {
  it("sets, validates and removes the internet address, and invites carry both links", async () => {
    const a = makeSide("Office-PC");
    await ok(a.svc.handle({ op: "share_set", enabled: true }));
    expect((await ok(a.svc.handle({ op: "share_status" }))).share.publicUrl).toBeNull();
    const lanOnly = await ok(a.svc.handle({ op: "invite_create", expiresMinutes: 15 }));
    expect(lanOnly.invite.internetLink).toBeUndefined();

    expect(
      await a.svc.handle({ op: "share_public_url", url: "http://share.example.com" })
    ).toMatchObject({ ok: false, error: { code: "bad_request" } });

    const set = await ok(
      a.svc.handle({ op: "share_public_url", url: "https://share.example.com/" })
    );
    expect(set.share.publicUrl).toBe("https://share.example.com");
    const inv = await ok(a.svc.handle({ op: "invite_create", expiresMinutes: 15 }));
    const key = inv.invite.link.split("#")[1];
    expect(inv.invite.internetLink).toBe(`https://share.example.com/join#${key}`);

    const off = await ok(a.svc.handle({ op: "share_public_url", url: null }));
    expect(off.share.publicUrl).toBeNull();
  });
});
