import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatApp, type ChatOptions } from "../cli/teams/app";
import type { Frame } from "../cli/teams/render";
import type { Screen } from "../cli/teams/screen";
import { IntegrationError } from "../core/integrations/types";
import type { ChatInfo, GraphClient, Target, TeamsMessage } from "../core/teams/graph";

const waitFor = <T>(fn: () => T | Promise<T>) => vi.waitFor(fn, { timeout: 8000, interval: 15 });

class FakeScreen {
  frames: Frame[] = [];
  bells = 0;
  size() {
    return { cols: 110, rows: 30 };
  }
  enter() {}
  leave() {}
  invalidate() {}
  bell() {
    this.bells++;
  }
  draw(f: Frame) {
    this.frames.push(f);
  }
  get last(): Frame {
    return this.frames[this.frames.length - 1];
  }
  get text(): string {
    return this.last.rows.map((r) => r.replace(/\u001b\[[0-9;]*m/g, "")).join("\n");
  }
}

const T0 = Date.now();
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();
const msg = (id: string, minutes: number, text: string, fromId = "u-priya"): TeamsMessage => ({
  id,
  at: at(minutes),
  from: fromId === "u-me" ? "Alex" : "Priya Nair",
  fromId,
  text,
  images: [],
  files: [],
  system: false,
});

const keyOf = (t: Target) =>
  t.kind === "chat" ? `chat:${t.chatId}` : `ch:${t.teamId}:${t.channelId}`;

/** A fake Microsoft whose conversations can change while the chat is open. */
function world() {
  const state = {
    msgs: {
      "ch:t1:c1": [msg("a1", 1, "first in general")],
      "ch:t1:c2": [msg("r1", 1, "first in releases")],
      "chat:k1": [msg("p1", 1, "hi from priya")],
    } as Record<string, TeamsMessage[]>,
    older: {} as Record<string, TeamsMessage[]>,
    next: {} as Record<string, string | null>,
    chats: [
      {
        id: "k1",
        kind: "oneOnOne",
        title: "Priya Nair",
        lastAt: at(1),
        lastFromId: "u-priya",
        lastReadAt: at(1),
      },
    ] as ChatInfo[],
    failMessages: null as Error | null,
    failTeams: null as Error | null,
  };
  const graph = {
    joinedTeams: vi.fn(async () => {
      if (state.failTeams) throw state.failTeams;
      return [{ id: "t1", name: "Platform" }];
    }),
    channels: vi.fn(async () => [
      { id: "c1", name: "General" },
      { id: "c2", name: "Releases" },
    ]),
    chats: vi.fn(async () => state.chats.map((c) => ({ ...c }))),
    messagesPage: vi.fn(async (target: Target, o?: { top?: number; pageUrl?: string }) => {
      if (state.failMessages) throw state.failMessages;
      const key = keyOf(target);
      if (o?.pageUrl) return { messages: state.older[key] ?? [], next: null };
      return { messages: [...(state.msgs[key] ?? [])], next: state.next[key] ?? null };
    }),
    image: vi.fn(async () => ({ bytes: new Uint8Array(), contentType: "image/png" })),
    send: vi.fn(async (_t: Target, _d: unknown) => undefined),
    uploadFile: vi.fn(async () => "https://x/y"),
  };
  return { state, graph: graph as unknown as GraphClient & typeof graph };
}

const account = { id: "u-me", name: "Alex", scopes: [], signedInAt: "" };
const FAST = { focusedMs: 40, idleMs: 40, sidebarMs: 40, maxBackoffMs: 160, rateLimitMs: 80 };

describe("ChatApp automatic sync", () => {
  const apps: ChatApp[] = [];
  afterEach(() => {
    apps.splice(0).forEach((a) => a.quit());
  });

  async function start(
    w: ReturnType<typeof world>,
    opts: Partial<ChatOptions> = {},
    ready = "first in general"
  ) {
    const screen = new FakeScreen();
    const app = new ChatApp({
      graph: w.graph,
      account,
      canReadChannels: true,
      screen: screen as unknown as Screen,
      env: {} as NodeJS.ProcessEnv,
      sync: FAST,
      ...opts,
    });
    apps.push(app);
    const done = app.run();
    await waitFor(() => expect(screen.text).toContain(ready));
    return { app, screen, done };
  }

  const click = (app: ChatApp, f: Frame, pick: (a: Frame["hits"][number]["action"]) => boolean) => {
    const h = f.hits.find((x) => pick(x.action));
    expect(h, "a clickable region").toBeTruthy();
    app.handleEvent({ type: "mouse", action: "press", x: h!.x1, y: h!.y1 });
  };

  it("shows new messages in the open conversation by itself, and says who wrote", async () => {
    const w = world();
    const { screen } = await start(w);
    w.state.msgs["ch:t1:c1"].push(msg("a2", 2, "arrived while you watched"));
    await waitFor(() => expect(screen.text).toContain("arrived while you watched"));
    await waitFor(() => expect(screen.text).toContain("New message from Priya Nair"));
    expect(screen.text).toMatch(/synced \d\d:\d\d/);
  });

  it("shows an edit and removes a deleted message", async () => {
    const w = world();
    w.state.msgs["ch:t1:c1"] = [msg("a1", 1, "typo here"), msg("a2", 2, "going away")];
    const { screen } = await start(w, {}, "going away");
    w.state.msgs["ch:t1:c1"] = [msg("a1", 1, "fixed now")];
    await waitFor(() => expect(screen.text).toContain("fixed now"));
    expect(screen.text).not.toContain("going away");
  });

  it("marks a chat unread when it gets a message, announces it, and clears the mark when opened", async () => {
    const w = world();
    const { app, screen } = await start(w);
    expect(screen.text).not.toMatch(/Priya Nair\s+●/);
    w.state.chats = [{ ...w.state.chats[0], lastAt: at(5), lastFromId: "u-priya" }];
    await waitFor(() => expect(screen.text).toMatch(/Priya Nair\s+●/));
    await waitFor(() => expect(screen.text).toContain("New message in Priya Nair"));
    click(app, screen.last, (a) => a.type === "select" && a.key === "chat:k1");
    await waitFor(() => expect(screen.text).not.toMatch(/Priya Nair\s+●/));
  });

  it("marks chats that already have unseen messages on the first load, without announcing them", async () => {
    const w = world();
    w.state.chats = [{ ...w.state.chats[0], lastAt: at(9), lastReadAt: at(1) }];
    const { screen } = await start(w);
    await waitFor(() => expect(screen.text).toMatch(/Priya Nair\s+●/));
    expect(screen.text).not.toContain("New message in");
  });

  it("does not mark a chat unread for your own message", async () => {
    const w = world();
    const { screen } = await start(w);
    w.state.chats = [{ ...w.state.chats[0], lastAt: at(5), lastFromId: "u-me" }];
    await new Promise((r) => setTimeout(r, 200));
    expect(screen.text).not.toMatch(/Priya Nair\s+●/);
  });

  it("keeps a conversation you opened up to date in the background, and marks it unread", async () => {
    const w = world();
    const { app, screen } = await start(w);
    click(app, screen.last, (a) => a.type === "select" && a.key === "ch:t1:c2");
    await waitFor(() => expect(screen.text).toContain("first in releases"));
    click(app, screen.last, (a) => a.type === "select" && a.key === "ch:t1:c1");
    await waitFor(() => expect(screen.text).toContain("first in general"));
    w.state.msgs["ch:t1:c2"].push(msg("r2", 3, "news in releases"));
    await waitFor(() => expect(screen.text).toMatch(/# Releases\s+●/));
    expect(screen.text).toContain("New message in Releases");
    click(app, screen.last, (a) => a.type === "select" && a.key === "ch:t1:c2");
    await waitFor(() => expect(screen.text).toContain("news in releases"));
    await waitFor(() => expect(screen.text).not.toMatch(/# Releases\s+●/));
  });

  it("goes offline when the network fails, backs off, and recovers on its own", async () => {
    const w = world();
    const { screen } = await start(w);
    w.state.failMessages = new IntegrationError("network", "Could not reach Microsoft Graph.");
    await waitFor(() => expect(screen.text).toMatch(/offline, retry \d\d:\d\d:\d\d/));
    // The conversation stays on screen while offline.
    expect(screen.text).toContain("first in general");
    const calls = w.graph.messagesPage.mock.calls.length;
    await new Promise((r) => setTimeout(r, 400));
    // Backoff: far fewer attempts than one every 40 ms.
    expect(w.graph.messagesPage.mock.calls.length - calls).toBeLessThan(8);
    w.state.failMessages = null;
    await waitFor(() => expect(screen.text).toMatch(/synced \d\d:\d\d/));
  });

  it("loads the sidebar later when it could not load at start", async () => {
    const w = world();
    w.state.failTeams = new IntegrationError("network", "Could not reach Microsoft Graph.");
    const screen = new FakeScreen();
    const app = new ChatApp({
      graph: w.graph,
      account,
      canReadChannels: true,
      screen: screen as unknown as Screen,
      env: {} as NodeJS.ProcessEnv,
      sync: FAST,
    });
    apps.push(app);
    void app.run();
    await waitFor(() => expect(screen.text).toContain("offline"));
    w.state.failTeams = null;
    await waitFor(() => expect(screen.text).toContain("first in general"));
    expect(screen.text).toContain("# Releases");
  });

  it("stops and says so when the sign-in has expired", async () => {
    const w = world();
    const { screen } = await start(w);
    w.state.failMessages = new IntegrationError(
      "auth",
      "Your Microsoft Teams sign-in has expired."
    );
    await waitFor(() => expect(screen.text).toContain("sign-in expired"));
    expect(screen.text).toContain("kai integration teams");
    const calls = w.graph.messagesPage.mock.calls.length;
    await new Promise((r) => setTimeout(r, 300));
    expect(w.graph.messagesPage.mock.calls.length).toBe(calls);
  });

  it("slows down while the window is not focused, and syncs at once when it comes back", async () => {
    const w = world();
    const { app, screen } = await start(w, {
      sync: { ...FAST, focusedMs: 40, idleMs: 100_000, sidebarMs: 100_000 },
    });
    app.handleEvent({ type: "focus", focused: false });
    await new Promise((r) => setTimeout(r, 150));
    const calls = w.graph.messagesPage.mock.calls.length;
    w.state.msgs["ch:t1:c1"].push(msg("a2", 2, "while you were away"));
    await new Promise((r) => setTimeout(r, 150));
    expect(w.graph.messagesPage.mock.calls.length).toBe(calls);
    expect(screen.text).not.toContain("while you were away");
    app.handleEvent({ type: "focus", focused: true });
    await waitFor(() => expect(screen.text).toContain("while you were away"));
  });

  it("rings the bell for a new message only while the window is not focused", async () => {
    const w = world();
    const { app, screen } = await start(w);
    w.state.msgs["ch:t1:c1"].push(msg("a2", 2, "first ping"));
    await waitFor(() => expect(screen.text).toContain("first ping"));
    expect(screen.bells).toBe(0);
    app.handleEvent({ type: "focus", focused: false });
    w.state.msgs["ch:t1:c1"].push(msg("a3", 3, "second ping"));
    await waitFor(() => expect(screen.text).toContain("second ping"));
    expect(screen.bells).toBeGreaterThan(0);
  });

  it("loads earlier messages when you scroll to the top, or click the line", async () => {
    const w = world();
    w.state.msgs["ch:t1:c1"] = Array.from({ length: 30 }, (_, i) =>
      msg(`n${i}`, 100 + i, `recent ${i}`)
    );
    w.state.next["ch:t1:c1"] = "https://graph.microsoft.com/v1.0/older-page";
    w.state.older["ch:t1:c1"] = [msg("o1", 1, "ancient history")];
    const { app, screen } = await start(w, {}, "recent 29");
    expect(screen.text).not.toContain("ancient history");
    for (let i = 0; i < 40 && !screen.text.includes("earlier messages"); i++) {
      app.handleEvent({ type: "key", key: "pageup" });
      await new Promise((r) => setTimeout(r, 20));
    }
    await waitFor(() => expect(screen.text).toContain("ancient history"));
    expect(w.graph.messagesPage).toHaveBeenCalledWith(
      { kind: "channel", teamId: "t1", channelId: "c1" },
      { pageUrl: "https://graph.microsoft.com/v1.0/older-page" }
    );
    // Nothing older is left: the line is gone.
    await waitFor(() => expect(screen.text).not.toContain("earlier messages"));
  });

  it("shows your message at once as sending, and confirms it without showing it twice", async () => {
    const w = world();
    let release: () => void = () => {};
    w.graph.send.mockImplementationOnce(
      () => new Promise<undefined>((r) => (release = () => r(undefined)))
    );
    const { app, screen } = await start(w);
    app.handleEvent({ type: "text", text: "on my way" });
    app.handleEvent({ type: "key", key: "enter" });
    await waitFor(() => expect(screen.text).toContain("on my way"));
    expect(screen.text).toContain("sending...");
    // The box is free right away.
    expect(screen.text).not.toMatch(/›\s+on my way/);
    w.state.msgs["ch:t1:c1"].push(msg("a9", 2, "on my way", "u-me"));
    release();
    await waitFor(() => expect(screen.text).toContain("Sent."));
    await waitFor(() => expect(screen.text).not.toContain("sending..."));
    expect(screen.text.split("on my way").length - 1).toBe(1);
  });

  it("takes a failed message back and returns the text to the box", async () => {
    const w = world();
    w.graph.send.mockRejectedValueOnce(
      new IntegrationError("forbidden", "Microsoft Teams refused this request.")
    );
    const { app, screen } = await start(w);
    app.handleEvent({ type: "text", text: "this will fail" });
    app.handleEvent({ type: "key", key: "enter" });
    await waitFor(() => expect(screen.text).toContain("refused this request"));
    await waitFor(() => expect(screen.text).not.toContain("sending..."));
    expect(screen.text).toMatch(/›\s+this will fail/);
    // The failed message is not left in the conversation.
    expect(screen.text.split("this will fail").length - 1).toBe(1);
  });

  it("keeps a draft for each conversation", async () => {
    const w = world();
    const { app, screen } = await start(w);
    app.handleEvent({ type: "text", text: "draft for general" });
    click(app, screen.last, (a) => a.type === "select" && a.key === "ch:t1:c2");
    await waitFor(() => expect(screen.text).toContain("first in releases"));
    expect(screen.text).not.toContain("draft for general");
    app.handleEvent({ type: "text", text: "draft for releases" });
    click(app, screen.last, (a) => a.type === "select" && a.key === "ch:t1:c1");
    await waitFor(() => expect(screen.text).toMatch(/›\s+draft for general/));
    click(app, screen.last, (a) => a.type === "select" && a.key === "ch:t1:c2");
    await waitFor(() => expect(screen.text).toMatch(/›\s+draft for releases/));
  });

  it("orders chats by their latest activity", async () => {
    const w = world();
    w.state.chats = [
      {
        id: "k1",
        kind: "oneOnOne",
        title: "Older chat",
        lastAt: at(1),
        lastFromId: "u-priya",
        lastReadAt: at(1),
      },
      {
        id: "k2",
        kind: "group",
        title: "Newest chat",
        lastAt: at(9),
        lastFromId: "u-priya",
        lastReadAt: at(9),
      },
    ];
    w.state.msgs["chat:k2"] = [msg("g1", 9, "group hello")];
    const { screen } = await start(w);
    await waitFor(() => expect(screen.text).toContain("Newest chat"));
    expect(screen.text.indexOf("Newest chat")).toBeLessThan(screen.text.indexOf("Older chat"));
  });
});
