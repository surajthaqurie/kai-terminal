import { EventEmitter } from "events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatApp, type ChatOptions } from "../cli/teams/app";
import { layout, type Frame, type ViewMessage, type ViewModel } from "../cli/teams/render";
import { Screen, type ScreenIO } from "../cli/teams/screen";
import type { ChatInfo, GraphClient, Target, TeamsMessage } from "../core/teams/graph";
import { buildTeamsSignal, parseTeamsSignal } from "../core/teamsSignal";

const waitFor = <T>(fn: () => T | Promise<T>) => vi.waitFor(fn, { timeout: 8000, interval: 15 });
// eslint-disable-next-line no-control-regex -- terminal escape sequences (ESC, BEL) are matched on purpose
const plain = (rows: string[]) => rows.map((r) => r.replace(/\u001b\[[0-9;]*m/g, "")).join("\n");

describe("Teams unread signal", () => {
  it("round-trips a count and the stop signal", () => {
    const body = (s: string) => s.slice("\u001b]1337;".length, -1);
    expect(parseTeamsSignal(body(buildTeamsSignal(7)))).toBe(7);
    expect(parseTeamsSignal(body(buildTeamsSignal(0)))).toBe(0);
    expect(parseTeamsSignal(body(buildTeamsSignal(null)))).toBe(0);
    expect(parseTeamsSignal(body(buildTeamsSignal(123456)))).toBe(9999);
  });

  it("ignores other OSC 1337 payloads and garbage", () => {
    expect(parseTeamsSignal("File=name=abc;inline=1:QUJD")).toBeNull();
    expect(parseTeamsSignal("KaiCodeMode=stop")).toBeNull();
    expect(parseTeamsSignal("KaiTeams=unread;")).toBeNull();
    expect(parseTeamsSignal("KaiTeams=unread;-3")).toBeNull();
    expect(parseTeamsSignal("KaiTeams=unread;12345")).toBeNull();
    expect(parseTeamsSignal("KaiTeams=unread;4x")).toBeNull();
  });
});

describe("layout: search, counts, jumping, cut-off pictures", () => {
  const base: ViewModel = {
    headerLeft: "Platform › # General",
    headerRight: "synced 10:00  ● Alex",
    sidebar: [
      { kind: "heading", label: "Chats" },
      { kind: "item", label: "Priya Nair", key: "chat:k1", unread: 12 },
      { kind: "item", label: "Quiet", key: "chat:k2" },
    ],
    convTitle: "",
    messages: [],
    convNote: null,
    older: "none",
    scroll: 0,
    input: "",
    cursor: 0,
    pending: [],
    notice: null,
    typing: "",
  };
  const m = (i: number, over: Partial<ViewMessage> = {}): ViewMessage => ({
    id: `m${i}`,
    time: "09:00",
    day: "Today",
    from: "Priya Nair",
    mine: false,
    system: false,
    text: `message number ${i}`,
    images: [],
    files: [],
    ...over,
  });
  const width = (s: string) => plain([s]).length;

  it("shows unread counts in the sidebar and the header, and a clickable Search button", () => {
    const f = layout({ ...base, unreadTotal: 12 }, 100, 30);
    const text = plain(f.rows).split("\n");
    expect(text[0]).toContain("12 unread");
    expect(text[0]).toContain("Search");
    // Row 1 is the CHATS heading; the count sits at the right edge of the sidebar.
    expect(text[2]).toMatch(/Priya Nair\s+12 │/);
    expect(f.hits.some((h) => h.action.type === "search" && h.y1 === 1)).toBe(true);
    f.rows.forEach((r) => expect(width(r)).toBe(100));
  });

  it("draws search results in the pane, grouped, each one clickable", () => {
    const f = layout(
      {
        ...base,
        search: {
          query: "pri",
          cursor: 3,
          selected: 1,
          results: [
            { kind: "person", title: "Priya Nair", detail: "2 conversations" },
            { kind: "conv", title: "Priya Nair", detail: "chat" },
            {
              kind: "message",
              title: "Priya Nair in General · Today 09:00",
              detail: "a print job",
            },
          ],
        },
      },
      100,
      30
    );
    const text = plain(f.rows);
    expect(text).toContain("3 results for “pri”");
    expect(text).toContain("PEOPLE");
    expect(text).toContain("CHATS AND CHANNELS");
    expect(text).toContain("MESSAGES");
    expect(text).toContain("Esc close");
    const results = f.hits.filter((h) => h.action.type === "result");
    expect(results.map((h) => (h.action as { index: number }).index)).toEqual([0, 1, 2]);
    // The selected result is marked.
    expect(text).toMatch(/❯ # Priya Nair/);
    f.rows.forEach((r) => expect(width(r)).toBe(100));
  });

  it("offers a jump to the newest message while scrolled up, with how many are new", () => {
    const messages = Array.from({ length: 40 }, (_, i) => m(i));
    const f = layout({ ...base, messages, scroll: 10, newBelow: 3 }, 100, 30);
    expect(plain(f.rows)).toContain("3 new messages");
    expect(f.hits.some((h) => h.action.type === "jump")).toBe(true);
    const bottom = layout({ ...base, messages }, 100, 30);
    expect(bottom.hits.some((h) => h.action.type === "jump")).toBe(false);
  });

  it("scrolls a found message into view and marks it", () => {
    const messages = Array.from({ length: 60 }, (_, i) => m(i));
    const f = layout(
      { ...base, messages, focusId: "m5", highlightId: "m5", highlightQuery: "number" },
      100,
      30
    );
    expect(f.scroll).toBeGreaterThan(0);
    expect(plain(f.rows)).toContain("message number 5");
    expect(plain(f.rows)).toContain("▶ 09:00 Priya Nair");
  });

  it("names a picture the pane edge cuts off instead of leaving a blank gap", () => {
    const pic = m(1, {
      text: "",
      images: [{ name: "whiteboard.png", state: "inline", b64: "QUJD", width: 400, height: 400 }],
    });
    const messages = [pic, ...Array.from({ length: 30 }, (_, i) => m(i + 2))];
    // Scrolled so only the bottom rows of the picture are on screen.
    const full = layout({ ...base, messages }, 100, 30);
    let cut: Frame | null = null;
    for (let s = 0; s <= full.maxScroll; s++) {
      const f = layout({ ...base, messages, scroll: s }, 100, 30);
      const placed = f.images.length > 0;
      const named = plain(f.rows).includes("▣ whiteboard.png");
      if (!placed && named) cut = f;
      // Never both: a drawn picture does not also get the placeholder line.
      expect(placed && named).toBe(false);
    }
    expect(cut, "a scroll position where the picture is cut off").not.toBeNull();
    expect(cut!.visibleIds).toContain("m1");
  });
});

describe("Screen: pictures that move", () => {
  it("rewrites the rows a picture left even when their text did not change", () => {
    const writes: string[] = [];
    const io = {
      out: { columns: 40, rows: 12, write: (s: string) => void writes.push(s) },
      inp: Object.assign(new EventEmitter(), {
        setRawMode: () => undefined,
        setEncoding: () => undefined,
        resume: () => undefined,
        pause: () => undefined,
      }),
    } as unknown as ScreenIO;
    const screen = new Screen(io);
    screen.enter(() => undefined);
    const rows = Array.from({ length: 12 }, () => " ".repeat(40));
    const base = {
      hits: [],
      cursor: { x: 1, y: 1 },
      pane: { x1: 1, y1: 1, x2: 1, y2: 1 },
      maxScroll: 0,
    };
    const pic = { id: "m1:0", row: 3, col: 4, cols: 10, rows: 3, b64: "QUJD", name: "a.png" };
    screen.draw({ ...base, rows, images: [pic] });
    writes.length = 0;
    screen.draw({ ...base, rows, images: [{ ...pic, row: 6 }] });
    const out = writes.join("");
    // The old rows 3-5 are cleared, and the picture is drawn again at row 6.
    for (const r of [3, 4, 5]) expect(out).toContain(`\u001b[${r};1H`);
    expect(out).toContain("\u001b[6;4H\u001b]1337;File=");
    writes.length = 0;
    screen.draw({ ...base, rows, images: [{ ...pic, row: 6 }] });
    // Nothing moved: nothing is redrawn.
    expect(writes.join("")).not.toContain("File=");
  });
});

// ---- the chat itself -----------------------------------------------------------

class FakeScreen {
  frames: Frame[] = [];
  signals: string[] = [];
  size() {
    return { cols: 110, rows: 30 };
  }
  enter() {}
  leave() {}
  invalidate() {}
  bell() {}
  signal(s: string) {
    this.signals.push(s);
  }
  draw(f: Frame) {
    this.frames.push(f);
  }
  get last(): Frame {
    return this.frames[this.frames.length - 1];
  }
  get text(): string {
    return plain(this.last.rows);
  }
}

const T0 = Date.now();
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();
const msg = (id: string, minutes: number, text: string, fromId = "u-priya"): TeamsMessage => ({
  id,
  at: at(minutes),
  from: fromId === "u-me" ? "Alex" : fromId === "u-omar" ? "Omar Haddad" : "Priya Nair",
  fromId,
  text,
  images: [],
  files: [],
  system: false,
});
const keyOf = (t: Target) =>
  t.kind === "chat" ? `chat:${t.chatId}` : `ch:${t.teamId}:${t.channelId}`;

function world() {
  const state = {
    msgs: {
      "ch:t1:c1": [
        msg("a0", 0, "the deploy checklist is in the wiki", "u-omar"),
        msg("a1", 1, "first in general"),
      ],
      "chat:k1": [msg("p1", 1, "hi from priya")],
      "chat:k2": [msg("o1", 1, "lunch?", "u-omar")],
    } as Record<string, TeamsMessage[]>,
    chats: [
      {
        id: "k1",
        kind: "oneOnOne",
        title: "Priya Nair",
        lastAt: at(1),
        lastFromId: "u-priya",
        lastReadAt: at(1),
        members: ["Priya Nair"],
      },
      {
        id: "k2",
        kind: "oneOnOne",
        title: "Omar Haddad",
        lastAt: at(1),
        lastFromId: "u-omar",
        lastReadAt: at(1),
        members: ["Omar Haddad"],
      },
    ] as ChatInfo[],
  };
  const graph = {
    joinedTeams: vi.fn(async () => [{ id: "t1", name: "Platform" }]),
    channels: vi.fn(async () => [{ id: "c1", name: "General" }]),
    chats: vi.fn(async () => state.chats.map((c) => ({ ...c }))),
    messagesPage: vi.fn(async (target: Target) => ({
      messages: [...(state.msgs[keyOf(target)] ?? [])],
      next: null,
    })),
    image: vi.fn(async () => ({ bytes: new Uint8Array(), contentType: "image/png" })),
    send: vi.fn(async () => undefined),
    uploadFile: vi.fn(async () => "https://x/y"),
  };
  return { state, graph: graph as unknown as GraphClient & typeof graph };
}

const account = { id: "u-me", name: "Alex", scopes: [], signedInAt: "" };
const FAST = { focusedMs: 40, idleMs: 40, sidebarMs: 40, maxBackoffMs: 160, rateLimitMs: 80 };

describe("ChatApp: search, unread counts and the tab signal", () => {
  const apps: ChatApp[] = [];
  afterEach(() => {
    apps.splice(0).forEach((a) => a.quit());
  });

  async function start(w: ReturnType<typeof world>, opts: Partial<ChatOptions> = {}) {
    const screen = new FakeScreen();
    const app = new ChatApp({
      graph: w.graph,
      account,
      canReadChannels: true,
      screen: screen as unknown as Screen,
      env: {},
      sync: FAST,
      ...opts,
    });
    apps.push(app);
    const done = app.run();
    await waitFor(() => expect(screen.text).toContain("first in general"));
    return { app, screen, done };
  }
  const type = (app: ChatApp, text: string) => app.handleEvent({ type: "text", text });

  it("finds a person by name and opens your chat with them", async () => {
    const { app, screen } = await start(world());
    app.handleEvent({ type: "ctrl", letter: "k" });
    await waitFor(() => expect(screen.text).toContain("Esc close"));
    type(app, "omar");
    await waitFor(() => expect(screen.text).toContain("PEOPLE"));
    expect(screen.text).toContain("Omar Haddad");
    app.handleEvent({ type: "key", key: "enter" });
    await waitFor(() => expect(screen.text).toContain("lunch?"));
    expect(screen.text).not.toContain("Esc close");
  });

  it("finds words in a loaded message and jumps to it", async () => {
    const { app, screen } = await start(world());
    // Click the Search button in the header.
    const btn = screen.last.hits.find((h) => h.action.type === "search")!;
    app.handleEvent({ type: "mouse", action: "press", x: btn.x1, y: btn.y1 });
    type(app, "checklist");
    await waitFor(() => expect(screen.text).toContain("MESSAGES"));
    const hit = screen.last.hits.find((h) => h.action.type === "result")!;
    app.handleEvent({ type: "mouse", action: "press", x: hit.x1, y: hit.y1 });
    await waitFor(() => expect(screen.text).toContain("▶"));
    expect(screen.text).toContain("deploy checklist");
  });

  it("Esc closes search without leaving the chat", async () => {
    const { app, screen } = await start(world());
    app.handleEvent({ type: "ctrl", letter: "k" });
    type(app, "zzz");
    await waitFor(() => expect(screen.text).toContain("No results"));
    app.handleEvent({ type: "key", key: "escape" });
    await waitFor(() => expect(screen.text).toContain("first in general"));
    expect(screen.text).not.toContain("No results");
  });

  it("counts messages in the open chat while the window is away, and tells the tab", async () => {
    const w = world();
    const { app, screen } = await start(w);
    app.handleEvent({ type: "focus", focused: false });
    w.state.msgs["ch:t1:c1"].push(msg("a2", 2, "while you were away"));
    w.state.msgs["ch:t1:c1"].push(msg("a3", 3, "and another"));
    await waitFor(() => expect(screen.text).toContain("2 unread"));
    await waitFor(() =>
      expect(screen.signals[screen.signals.length - 1]).toBe(buildTeamsSignal(2))
    );
    app.handleEvent({ type: "focus", focused: true });
    await waitFor(() => expect(screen.text).not.toContain("2 unread"));
    await waitFor(() =>
      expect(screen.signals[screen.signals.length - 1]).toBe(buildTeamsSignal(0))
    );
  });

  it("says stop to the tab when the chat closes", async () => {
    const { app, screen, done } = await start(world());
    app.quit();
    await done;
    expect(screen.signals[screen.signals.length - 1]).toBe(buildTeamsSignal(null));
  });

  it("scrolls the sidebar with the wheel", async () => {
    const w = world();
    w.state.chats = Array.from({ length: 40 }, (_, i) => ({
      id: `x${i}`,
      kind: "group" as const,
      title: `Group chat ${String(i).padStart(2, "0")}`,
      lastAt: at(-i),
      lastFromId: "u-me",
      lastReadAt: at(0),
      members: [],
    }));
    const { app, screen } = await start(w);
    await waitFor(() => expect(screen.text).toContain("Group chat 00"));
    const side = screen.last.sidebarPane!;
    for (let i = 0; i < 10; i++)
      app.handleEvent({ type: "mouse", action: "wheeldown", x: side.x1 + 1, y: side.y1 + 1 });
    await waitFor(() => expect(screen.text).toContain("Group chat 39"));
    expect(screen.text).not.toContain("Group chat 00");
  });
});
