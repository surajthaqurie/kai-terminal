import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatApp, timeParts, type ChatOptions } from "../cli/teams/app";
import { hitAt, layout, type Frame, type ViewModel } from "../cli/teams/render";
import type { Screen } from "../cli/teams/screen";
import type { GraphClient, TeamsMessage } from "../core/teams/graph";

/** Waits for the screen to catch up; generous because the whole suite runs in parallel. */
const waitFor = <T>(fn: () => T | Promise<T>) => vi.waitFor(fn, { timeout: 8000, interval: 20 });

class FakeScreen {
  frames: Frame[] = [];
  entered = false;
  left = false;
  size() {
    return { cols: 100, rows: 30 };
  }
  enter() {
    this.entered = true;
  }
  leave() {
    this.left = true;
  }
  invalidate() {}
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

const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 1,
  0x40, 0, 0, 0, 0xb4,
]);

/** A fixed time, so repeated refreshes of the fake return the same messages. */
const BASE_AT = new Date().toISOString();

const msg = (over: Partial<TeamsMessage>): TeamsMessage => ({
  id: "m1",
  at: BASE_AT,
  from: "Marcus Webb",
  fromId: "u-marcus",
  text: "hello there",
  images: [],
  files: [],
  system: false,
  ...over,
});

function fakeGraph(over: Record<string, unknown> = {}) {
  const g = {
    joinedTeams: vi.fn(async () => [{ id: "t1", name: "Platform Engineering" }]),
    channels: vi.fn(async () => [
      { id: "c1", name: "General" },
      { id: "c2", name: "Releases" },
    ]),
    chats: vi.fn(async () => [{ id: "chat1", kind: "oneOnOne", title: "Priya Nair" }]),
    messages: vi.fn(async (_target: unknown, _top?: number) => [msg({})]),
    messagesPage: undefined as unknown,
    image: vi.fn(async () => ({ bytes: PNG, contentType: "image/png" })),
    send: vi.fn(
      async (
        _target: unknown,
        _draft: {
          text: string;
          images: Array<{ name: string; contentType: string }>;
          links: unknown[];
        }
      ) => undefined
    ),
    uploadFile: vi.fn(async () => "https://contoso.sharepoint.com/s/x"),
    ...over,
  };
  if (!over.messagesPage) {
    g.messagesPage = vi.fn(async (target: unknown, o?: { top?: number; pageUrl?: string }) => ({
      messages: await g.messages(target, o?.top),
      next: null,
    }));
  }
  return g as typeof g & GraphClient;
}

const account = { id: "u-me", name: "Alex", scopes: [], signedInAt: "" };

describe("ChatApp", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-chat-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  async function start(
    graph = fakeGraph(),
    opts: Partial<ChatOptions> = {},
    ready = "hello there"
  ) {
    const screen = new FakeScreen();
    const app = new ChatApp({
      graph,
      account,
      canReadChannels: true,
      screen: screen as unknown as Screen,
      env: {} as NodeJS.ProcessEnv,
      pollMs: 3_600_000,
      tmpDir: dir,
      ...opts,
    });
    const done = app.run();
    await waitFor(() => expect(screen.text).toContain(ready));
    return { app, screen, graph, done, stop: async () => (app.quit(), await done) };
  }

  const type = (app: ChatApp, text: string) => app.handleEvent({ type: "text", text });
  const key = (app: ChatApp, k: "enter" | "escape" | "up" | "down" | "backspace") =>
    app.handleEvent({ type: "key", key: k });
  const click = (app: ChatApp, f: Frame, pick: (a: Frame["hits"][number]["action"]) => boolean) => {
    const h = f.hits.find((x) => pick(x.action));
    expect(h, "a clickable region").toBeTruthy();
    app.handleEvent({ type: "mouse", action: "press", x: h!.x1, y: h!.y1 });
  };

  it("loads teams, channels and chats and opens the first channel", async () => {
    const t = await start();
    expect(t.screen.entered).toBe(true);
    expect(t.screen.text).toContain("Platform Engineering");
    expect(t.screen.text).toContain("# General");
    expect(t.screen.text).toContain("Priya Nair");
    expect(t.screen.text).toContain("Marcus Webb");
    expect(t.graph.messages).toHaveBeenCalledWith(
      { kind: "channel", teamId: "t1", channelId: "c1" },
      30
    );
    await t.stop();
    expect(t.screen.left).toBe(true);
  });

  it("opens a conversation when its name is clicked", async () => {
    const t = await start();
    click(t.app, t.screen.last, (a) => a.type === "select" && a.key === "chat:chat1");
    await waitFor(() =>
      expect(t.graph.messages).toHaveBeenCalledWith({ kind: "chat", chatId: "chat1" }, 30)
    );
    await t.stop();
  });

  it("switches conversations with the arrow keys only while the message box is empty", async () => {
    const t = await start();
    key(t.app, "down");
    await waitFor(() =>
      expect(t.graph.messages).toHaveBeenLastCalledWith(
        { kind: "channel", teamId: "t1", channelId: "c2" },
        30
      )
    );
    type(t.app, "draft");
    const calls = t.graph.messages.mock.calls.length;
    key(t.app, "down");
    expect(t.graph.messages.mock.calls.length).toBe(calls);
    await t.stop();
  });

  it("sends typed text and clears the box; a failed send keeps it and shows why", async () => {
    const t = await start();
    type(t.app, "ship it");
    key(t.app, "enter");
    await waitFor(() => expect(t.graph.send).toHaveBeenCalledTimes(1));
    expect(t.graph.send).toHaveBeenCalledWith(
      { kind: "channel", teamId: "t1", channelId: "c1" },
      { text: "ship it", images: [], links: [] }
    );
    await waitFor(() => expect(t.screen.text).toContain("Sent."));

    t.graph.send.mockRejectedValueOnce(
      Object.assign(new Error("Microsoft Teams refused this request."), {
        hint: "Ask an administrator.",
      })
    );
    type(t.app, "again");
    key(t.app, "enter");
    await waitFor(() => expect(t.screen.text).toContain("refused this request"));
    expect(t.screen.text).toContain("again");
    await t.stop();
  });

  it("attaches an image whose path is pasted, then sends it inline", async () => {
    const png = path.join(dir, "My Shot.png");
    fs.writeFileSync(png, PNG);
    const t = await start();
    t.app.handleEvent({ type: "paste", text: `"${png}" ` });
    await waitFor(() => expect(t.screen.text).toContain("My Shot.png"));
    type(t.app, "look");
    key(t.app, "enter");
    await waitFor(() => expect(t.graph.send).toHaveBeenCalled());
    const draft = t.graph.send.mock.calls[0][1];
    expect(draft.text).toBe("look");
    expect(draft.images).toHaveLength(1);
    expect(draft.images[0]).toMatchObject({ name: "My Shot.png", contentType: "image/png" });
    await t.stop();
  });

  it("uploads other files and sends them as links", async () => {
    const pdf = path.join(dir, "plan.pdf");
    fs.writeFileSync(pdf, "%PDF-1.4 hello");
    const t = await start();
    t.app.handleEvent({ type: "paste", text: pdf });
    await waitFor(() => expect(t.screen.text).toContain("plan.pdf"));
    key(t.app, "enter");
    await waitFor(() => expect(t.graph.send).toHaveBeenCalled());
    expect(t.graph.uploadFile).toHaveBeenCalledWith(
      "plan.pdf",
      expect.any(Uint8Array),
      expect.any(Function)
    );
    expect(t.graph.send.mock.calls[0][1].links).toEqual([
      { name: "plan.pdf", url: "https://contoso.sharepoint.com/s/x" },
    ]);
    await t.stop();
  });

  it("uploads a file over 4 MB, and sends a picture over 4 MB as a link instead of inline", async () => {
    const big = path.join(dir, "movie.bin");
    fs.writeFileSync(big, Buffer.alloc(5 * 1024 * 1024));
    const bigPng = path.join(dir, "poster.png");
    fs.writeFileSync(bigPng, Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)]));
    const t = await start();
    t.app.handleEvent({ type: "paste", text: `"${big}" "${bigPng}"` });
    await waitFor(() => expect(t.screen.text).toContain("poster.png"));
    key(t.app, "enter");
    await waitFor(() => expect(t.graph.send).toHaveBeenCalled());
    expect(t.graph.uploadFile).toHaveBeenCalledTimes(2);
    const draft = t.graph.send.mock.calls[0][1];
    expect(draft.images).toHaveLength(0);
    expect((draft.links as Array<{ name: string }>).map((l) => l.name)).toEqual([
      "movie.bin",
      "poster.png",
    ]);
    await t.stop();
  });

  it("inserts pasted text that is not a file, and refuses files over 250 MB", async () => {
    const big = path.join(dir, "big.bin");
    fs.writeFileSync(big, "");
    fs.truncateSync(big, 250 * 1024 * 1024 + 1); // sparse: never read, only measured
    const t = await start();
    t.app.handleEvent({ type: "paste", text: "just some words" });
    await waitFor(() => expect(t.screen.text).toContain("just some words"));
    t.app.handleEvent({ type: "paste", text: big });
    await waitFor(() => expect(t.screen.text).toContain("larger than 250 MB"));
    await t.stop();
  });

  it("attaches what is on the clipboard with Ctrl+V and the Attach button, and says when there is nothing", async () => {
    const shot = path.join(dir, "shot.png");
    fs.writeFileSync(shot, PNG);
    const readClipboard = vi.fn(async () => [shot]);
    const t = await start(fakeGraph(), { readClipboard });
    t.app.handleEvent({ type: "ctrl", letter: "v" });
    await waitFor(() => expect(t.screen.text).toContain("shot.png"));
    readClipboard.mockResolvedValueOnce([]);
    click(t.app, t.screen.last, (a) => a.type === "attach");
    await waitFor(() => expect(t.screen.text).toContain("Nothing to attach"));
    await t.stop();
  });

  it("removes an attachment with its x, with Backspace on an empty box, and with Esc", async () => {
    const shot = path.join(dir, "shot.png");
    fs.writeFileSync(shot, PNG);
    const t = await start();
    t.app.handleEvent({ type: "paste", text: shot });
    await waitFor(() => expect(t.screen.text).toContain("shot.png"));
    click(t.app, t.screen.last, (a) => a.type === "unattach");
    await waitFor(() => expect(t.screen.text).not.toContain("shot.png"));
    t.app.handleEvent({ type: "paste", text: shot });
    await waitFor(() => expect(t.screen.text).toContain("shot.png"));
    key(t.app, "backspace");
    await waitFor(() => expect(t.screen.text).not.toContain("shot.png"));
    t.app.handleEvent({ type: "paste", text: shot });
    await waitFor(() => expect(t.screen.text).toContain("shot.png"));
    key(t.app, "escape");
    await waitFor(() => expect(t.screen.text).not.toContain("shot.png"));
    await t.stop();
  });

  it("leaves on Esc (nothing to clear) and on Ctrl+C", async () => {
    const a = await start();
    key(a.app, "escape");
    await a.done;
    const b = await start();
    b.app.handleEvent({ type: "ctrl", letter: "c" });
    await b.done;
  });

  it("explains that channel messages need approval, but still lets you send", async () => {
    const t = await start(fakeGraph(), { canReadChannels: false }, "administrator");
    await waitFor(() => expect(t.screen.text).toContain("administrator"));
    expect(t.graph.messages).not.toHaveBeenCalledWith(
      expect.objectContaining({ kind: "channel" }),
      expect.anything()
    );
    type(t.app, "hi channel");
    key(t.app, "enter");
    await waitFor(() => expect(t.graph.send).toHaveBeenCalled());
    await t.stop();
  });
});

describe("ChatApp images", () => {
  const withImage = () =>
    fakeGraph({
      messages: vi.fn(async () => [
        msg({
          text: "see this",
          images: [
            {
              url: "https://graph.microsoft.com/v1.0/chats/c/messages/m1/hostedContents/h/$value",
              alt: "build",
              fetchable: true,
            },
          ],
        }),
      ]),
    });

  it("draws images inline where the terminal supports it", async () => {
    const graph = withImage();
    const screen = new FakeScreen();
    const app = new ChatApp({
      graph,
      account,
      canReadChannels: true,
      screen: screen as unknown as Screen,
      env: { TERM_PROGRAM: "iTerm.app" } as NodeJS.ProcessEnv,
      pollMs: 3_600_000,
    });
    const done = app.run();
    await waitFor(() => expect(screen.last.images.length).toBe(1));
    expect(screen.last.images[0]).toMatchObject({ cols: 44, rows: 13 });
    expect(graph.image).toHaveBeenCalledTimes(1);
    app.quit();
    await done;
  });

  it("shows a clickable line instead, and opens the image in the system viewer on click", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kai-chat-"));
    const openFile = vi.fn();
    const graph = withImage();
    const screen = new FakeScreen();
    const app = new ChatApp({
      graph,
      account,
      canReadChannels: true,
      screen: screen as unknown as Screen,
      env: {} as NodeJS.ProcessEnv,
      openFile,
      pollMs: 3_600_000,
      tmpDir: dir,
    });
    const done = app.run();
    await waitFor(() => expect(screen.text).toContain("click to open"));
    expect(graph.image).not.toHaveBeenCalled();
    expect(screen.last.images).toEqual([]);
    const hit = screen.last.hits.find((h) => h.action.type === "open")!;
    app.handleEvent({ type: "mouse", action: "press", x: hit.x1, y: hit.y1 });
    await waitFor(() => expect(openFile).toHaveBeenCalledTimes(1));
    const file = openFile.mock.calls[0][0] as string;
    expect(file.endsWith(".png")).toBe(true);
    expect(fs.readFileSync(file)).toEqual(Buffer.from(PNG));
    app.quit();
    await done;
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("ChatApp links", () => {
  it("says which site a link opens, so a link cannot pass for a picture", async () => {
    const openUrl = vi.fn();
    const graph = fakeGraph({
      messages: vi.fn(async () => [
        msg({
          text: "invoice",
          images: [
            { url: "https://files.evil.example/invoice.png", alt: "invoice.png", fetchable: false },
          ],
          files: [{ name: "plan.xlsx", url: "https://contoso.sharepoint.com/plan.xlsx" }],
        }),
      ]),
    });
    const screen = new FakeScreen();
    const app = new ChatApp({
      graph,
      account,
      canReadChannels: true,
      screen: screen as unknown as Screen,
      env: {} as NodeJS.ProcessEnv,
      openUrl,
      pollMs: 3_600_000,
    });
    const done = app.run();
    await waitFor(() => expect(screen.text).toContain("opens files.evil.example in your browser"));
    expect(screen.text).toContain("opens contoso.sharepoint.com in your browser");
    const hit = screen.last.hits.find((h) => h.action.type === "open")!;
    app.handleEvent({ type: "mouse", action: "press", x: hit.x1, y: hit.y1 });
    await waitFor(() =>
      expect(openUrl).toHaveBeenCalledWith("https://files.evil.example/invoice.png")
    );
    expect(graph.image).not.toHaveBeenCalled();
    app.quit();
    await done;
  });
});

describe("layout", () => {
  const base: ViewModel = {
    headerLeft: "kai teams",
    headerRight: "● Alex",
    sidebar: [
      { kind: "heading", label: "Teams" },
      { kind: "team", label: "Platform Engineering" },
      { kind: "item", label: "# General", key: "ch:a:b", selected: true },
    ],
    convTitle: "Message # General",
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
  const width = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, "").length;

  it("fills every row to exactly the terminal width", () => {
    const messages = Array.from({ length: 40 }, (_, i) => ({
      id: `m${i}`,
      time: "09:12",
      day: "Today",
      from: "Marcus Webb",
      mine: i % 3 === 0,
      system: false,
      text: "a fairly long message that has to wrap around the narrow pane at least once or twice",
      images: [],
      files: [],
    }));
    for (const [cols, rows] of [
      [100, 30],
      [64, 12],
      [40, 10],
    ]) {
      const f = layout({ ...base, messages, input: "hello", cursor: 5 }, cols, rows);
      expect(f.rows).toHaveLength(rows);
      f.rows.forEach((r) => expect(width(r)).toBe(cols));
    }
  });

  it("puts a dot on conversations with unseen messages, kept inside the sidebar width", () => {
    const f = layout(
      {
        ...base,
        sidebar: [
          {
            kind: "item",
            label: "# A very long channel name that must be cut",
            key: "a",
            unread: true,
          },
          { kind: "item", label: "# Quiet", key: "b" },
          { kind: "item", label: "# Open and unread", key: "c", selected: true, unread: true },
        ],
      },
      100,
      30
    );
    const text = f.rows.map((r) => r.replace(/\u001b\[[0-9;]*m/g, ""));
    expect(text[1]).toContain("\u25cf");
    expect(text[1].indexOf("\u25cf")).toBeLessThan(28);
    expect(text[2]).not.toContain("\u25cf");
    expect(text[3]).toContain("\u25cf");
    f.rows.forEach((r) => expect(width(r)).toBe(100));
  });

  it("offers earlier messages as a clickable line, and shows when they are loading", () => {
    const available = layout({ ...base, older: "available" }, 100, 30);
    expect(available.rows.join("\n")).toContain("earlier messages");
    expect(available.hits.some((h) => h.action.type === "older")).toBe(true);
    const loading = layout({ ...base, older: "loading" }, 100, 30);
    expect(loading.rows.join("\n")).toContain("loading earlier messages");
    expect(loading.hits.some((h) => h.action.type === "older")).toBe(false);
  });

  it("marks a message that is still being sent", () => {
    const f = layout(
      {
        ...base,
        messages: [
          {
            id: "l1",
            time: "09:00",
            day: "Today",
            from: "Alex",
            mine: true,
            system: false,
            text: "on it",
            images: [],
            files: [],
            pending: true,
          },
        ],
      },
      100,
      30
    );
    expect(f.rows.join("\n")).toContain("sending...");
  });

  it("asks for a bigger window instead of drawing garbage", () => {
    const f = layout(base, 30, 6);
    expect(f.rows[0]).toContain("bigger");
    expect(f.hits).toEqual([]);
  });

  it("scrolls from the newest message and clamps the scroll", () => {
    const messages = Array.from({ length: 30 }, (_, i) => ({
      id: `m${i}`,
      time: "09:00",
      day: "Today",
      from: "A",
      mine: false,
      system: false,
      text: `message number ${i}`,
      images: [],
      files: [],
    }));
    const bottom = layout({ ...base, messages }, 100, 20);
    expect(bottom.rows.join("\n")).toContain("message number 29");
    expect(bottom.maxScroll).toBeGreaterThan(0);
    const top = layout({ ...base, messages, scroll: 9999 }, 100, 20);
    expect(top.rows.join("\n")).toContain("message number 0");
    expect(top.rows.join("\n")).not.toContain("message number 29");
  });

  it("makes the sidebar, Attach, Send and attachment buttons clickable", () => {
    const f = layout({ ...base, pending: [{ name: "a.png", size: "1 KB", image: true }] }, 100, 30);
    const types = f.hits.map((h) => h.action.type);
    expect(types).toEqual(expect.arrayContaining(["select", "attach", "send", "unattach"]));
    const send = f.hits.find((h) => h.action.type === "send")!;
    expect(hitAt(f, send.x1, send.y1)).toEqual({ type: "send" });
    expect(hitAt(f, 1, 1)).toBeNull();
  });

  it("puts the caret inside the message box", () => {
    const f = layout({ ...base, input: "hello", cursor: 5 }, 100, 30);
    expect(f.cursor.y).toBe(29);
    expect(f.cursor.x).toBe(4 + 5);
  });
});

describe("timeParts", () => {
  it("labels today, yesterday and older days", () => {
    const now = new Date(2026, 10, 4, 12, 0);
    expect(timeParts(new Date(2026, 10, 4, 9, 5).toISOString(), now)).toEqual({
      time: "09:05",
      day: "Today",
    });
    expect(timeParts(new Date(2026, 10, 3, 23, 59).toISOString(), now).day).toBe("Yesterday");
    expect(timeParts(new Date(2026, 9, 20, 8, 0).toISOString(), now).day).toBe("2026-10-20");
    expect(timeParts("nonsense", now)).toEqual({ time: "", day: "" });
  });
});
