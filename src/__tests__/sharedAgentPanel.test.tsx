// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  defaultGrants,
  emptyUsage,
  type DeviceHistory,
  type JoinedHost,
  type ShareDevice,
  type SharedAgentEvent,
  type ShareStatus,
} from "../core/sharedAgent/types";

const svc = vi.hoisted(() => ({
  listHosts: vi.fn(),
  joinHost: vi.fn(),
  leaveHost: vi.fn(),
  sendChat: vi.fn(),
  stopChat: vi.fn(),
  getShareStatus: vi.fn(),
  setSharing: vi.fn(),
  checkPort: vi.fn(),
  setAgentShared: vi.fn(),
  createInvite: vi.fn(),
  cancelInvite: vi.fn(),
  disconnectDevice: vi.fn(),
  removeDevice: vi.fn(),
  stopHostRun: vi.fn(),
  setDeviceGrants: vi.fn(),
  getDeviceHistory: vi.fn(),
  onSharedAgentEvent: vi.fn(),
  setPublicUrl: vi.fn(),
}));
vi.mock("../services/sharedAgentService", () => svc);

const desktop = vi.hoisted(() => ({ tauri: false }));
vi.mock("../services/ptyService", () => ({ isTauriAvailable: () => desktop.tauri }));
const chatWindow = vi.hoisted(() => ({
  popOutChat: vi.fn(),
  closeChatWindow: vi.fn(),
  closed: null as null | ((open: boolean) => void),
}));
vi.mock("../services/sharedChatWindow", async (orig) => ({
  ...(await orig<typeof import("../services/sharedChatWindow")>()),
  popOutChat: chatWindow.popOutChat,
  closeChatWindow: chatWindow.closeChatWindow,
  isChatPoppedOut: () => false,
  onChatPoppedOut: (fn: (open: boolean) => void) => {
    chatWindow.closed = fn;
    return () => {};
  },
}));

import { SharedAgentPanel } from "../components/SharedAgentPanel";
import { resetJoinedHostsCache } from "../hooks/useJoinedHosts";

const office = (over: Partial<JoinedHost> = {}): JoinedHost => ({
  id: "h1",
  name: "Office-PC",
  hostName: "Office-PC",
  address: "192.168.1.20:8765",
  internet: false,
  connectedAt: "2026-01-01T00:00:00Z",
  connected: true,
  online: true,
  latencyMs: 38,
  checkedAt: null,
  agents: [{ id: "claude", name: "Claude Code", available: true }],
  usage: { input: 10_000, output: 2_000, cacheRead: 480, cacheWrite: 0, runs: 4, costUsd: 0.4 },
  safetyCode: "K7QF-2M9D-XR4T",
  ...over,
});
const laptop = office({
  id: "h2",
  name: "Amit-Laptop",
  address: "192.168.1.34",
  online: false,
  latencyMs: null,
  usage: emptyUsage(),
});

const shareStatus = (over: Partial<ShareStatus> = {}): ShareStatus => ({
  enabled: false,
  port: 8765,
  listening: null,
  publicUrl: null,
  agents: [
    {
      id: "claude",
      name: "Claude Code",
      available: true,
      version: "2.1.0",
      error: "",
      enabled: true,
    },
    {
      id: "opencode",
      name: "OpenCode",
      available: false,
      version: "",
      error: "not found",
      enabled: true,
    },
  ],
  invites: [],
  devices: [],
  runs: [],
  safetyCode: null,
  ...over,
});

let container: HTMLDivElement;
let root: Root;
let emit: (e: SharedAgentEvent) => void;

const flush = () => act(async () => {});
const text = () => container.textContent ?? "";
const buttonByText = (label: string | RegExp) =>
  [...container.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
    typeof label === "string" ? b.textContent?.trim() === label : label.test(b.textContent ?? "")
  );
const click = (el: Element | undefined) => {
  if (!el) throw new Error("element not found");
  return act(async () => (el as HTMLElement).click());
};
async function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(proto.prototype, "value")!.set!;
  await act(async () => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const sendEvent = (e: SharedAgentEvent) => act(async () => emit(e));
const chatEvent = (chatId: string, kind: string, extra: Record<string, unknown> = {}) =>
  ({ event: "chat", chatId, kind, ...extra }) as SharedAgentEvent;

async function mount() {
  await act(async () => {
    root.render(<SharedAgentPanel active />);
  });
  await flush();
}

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.values(svc).forEach((fn) => fn.mockReset());
  localStorage.clear();
  // Every subscriber hears every event, as with the real event bus.
  const handlers = new Set<(e: SharedAgentEvent) => void>();
  emit = (e) => handlers.forEach((h) => h(e));
  svc.onSharedAgentEvent.mockImplementation(async (h: (e: SharedAgentEvent) => void) => {
    handlers.add(h);
    return () => handlers.delete(h);
  });
  resetJoinedHostsCache();
  desktop.tauri = false;
  chatWindow.popOutChat.mockReset().mockResolvedValue(true);
  chatWindow.closeChatWindow.mockReset().mockResolvedValue(true);
  svc.listHosts.mockResolvedValue({ ok: true, value: [office(), laptop] });
  svc.getShareStatus.mockResolvedValue({ ok: true, value: shareStatus() });
  svc.sendChat.mockResolvedValue({ ok: true, value: "chat-1" });
  svc.stopChat.mockResolvedValue({ ok: true, value: true });
  svc.leaveHost.mockResolvedValue({ ok: true, value: true });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("Use a shared agent", () => {
  // "Share my agent" is the first tab; these tests start on the other one.
  async function openReceive() {
    await mount();
    await click(buttonByText("Use a shared agent"));
    await flush();
  }

  it("shows each joined PC with the tokens used through it, in Join a PC", async () => {
    await openReceive();
    const join = container.querySelector('[aria-labelledby="sa-join-title"]')!;
    expect(join.textContent).toContain("Office-PC");
    expect(join.textContent).toContain("12,480"); // 10,000 + 2,000 + 480
    expect(join.textContent).toContain("tokens used");
    expect(join.textContent).toContain("Amit-Laptop");
    const tokens = join.querySelector<HTMLElement>(".sa-tokens");
    expect(tokens?.title).toContain("Input 10,000");
    // The route card carries no token meters of its own.
    const route = container.querySelector(".sa-route")!;
    expect(route.textContent).not.toContain("tokens");
    expect(text()).not.toContain("host’s Claude");
  });

  it("shows the joined PC's state, and never this PC's own Claude", async () => {
    await openReceive();
    const route = container.querySelector(".sa-route")!;
    expect(route.textContent).toContain("Connected to Office-PC");
    expect(route.textContent).toContain("LIVE");
    expect(route.className).toContain("sa-tone-ok");
    await click(
      container.querySelector<HTMLButtonElement>('button[aria-label="Chat with Amit-Laptop"]')!
    );
    expect(container.querySelector(".sa-route")!.textContent).toContain("OFFLINE");
    expect(container.querySelector("#sa-chat-title")!.textContent).toBe("Chat with Amit-Laptop");
    expect(text()).not.toMatch(/own Claude/i);
  });

  it("offers only a way to join until a PC is joined: no chat before that", async () => {
    svc.listHosts.mockResolvedValue({ ok: true, value: [] });
    await openReceive();
    expect(text()).toContain("Join a shared agent");
    expect(container.querySelector('input[aria-label="Invite link"]')).toBeTruthy();
    expect(container.querySelector('textarea[aria-label="Message"]')).toBeNull();
    expect(container.querySelector(".sa-chat")).toBeNull();
    expect(text()).not.toMatch(/own Claude/i);

    const studio = office({ id: "h3", name: "Studio-PC", usage: emptyUsage() });
    svc.joinHost.mockResolvedValue({ ok: true, value: studio });
    await type(
      container.querySelector<HTMLInputElement>('input[aria-label="Invite link"]')!,
      `http://192.168.1.50:8765/join#${"a".repeat(43)}.${"f".repeat(43)}`
    );
    await click(buttonByText("Join"));
    expect(container.querySelector("#sa-chat-title")!.textContent).toBe("Chat with Studio-PC");
    expect(container.querySelector('textarea[aria-label="Message"]')).toBeTruthy();
  });

  it("shows joined PCs from the last visit at once, before the service answers", async () => {
    await openReceive();
    act(() => root.unmount());
    root = createRoot(container);
    svc.listHosts.mockReturnValue(new Promise(() => {})); // never answers
    await openReceive();
    const receive = container.querySelector(".sa-mode:not([hidden])")!;
    expect(receive.textContent).toContain("Office-PC");
    expect(receive.textContent).not.toContain("Loading…");
  });

  it("rejects a bad invite link without calling the service, and joins with a good one", async () => {
    await openReceive();
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Invite link"]')!;
    await type(input, "http://8.8.8.8:1/join#abcdefghij");
    await click(buttonByText("Join"));
    expect(svc.joinHost).not.toHaveBeenCalled();
    expect(text()).toContain("not a valid invite link");

    const good = `http://192.168.1.50:8765/join#${"a".repeat(43)}.${"f".repeat(43)}`;
    const studio = office({
      id: "h3",
      name: "Studio-PC",
      address: "192.168.1.50",
      usage: emptyUsage(),
    });
    svc.joinHost.mockResolvedValue({ ok: true, value: studio });
    // The service now lists the new PC too.
    svc.listHosts.mockResolvedValue({ ok: true, value: [office(), laptop, studio] });
    await type(input, good);
    await click(buttonByText("Join"));
    expect(svc.joinHost).toHaveBeenCalledWith(good);
    expect(text()).toContain("Joined Studio-PC.");
    expect(input.value).toBe("");
    expect(container.querySelector("#sa-chat-title")!.textContent).toBe("Chat with Studio-PC");
  });

  it("shows why a join failed", async () => {
    svc.joinHost.mockResolvedValue({
      ok: false,
      error: { code: "rejected", message: "This invite link is already used." },
    });
    await openReceive();
    await type(
      container.querySelector<HTMLInputElement>('input[aria-label="Invite link"]')!,
      `http://192.168.1.50:8765/join#${"a".repeat(43)}.${"f".repeat(43)}`
    );
    await click(buttonByText("Join"));
    expect(container.querySelector("[role=alert]")!.textContent).toContain("already used");
  });

  it("leaves a PC only after a second click", async () => {
    await openReceive();
    await click(container.querySelector('button[aria-label="Leave Amit-Laptop"]')!);
    expect(svc.leaveHost).not.toHaveBeenCalled();
    expect(text()).toContain("Confirm leave");
    await click(container.querySelector('button[aria-label="Confirm leaving Amit-Laptop"]')!);
    expect(svc.leaveHost).toHaveBeenCalledWith("h2");
  });

  it("explains an unavailable service instead of showing an empty panel", async () => {
    svc.listHosts.mockResolvedValue({
      ok: false,
      error: { code: "unavailable", message: "Shared Agent is part of the desktop app." },
    });
    await openReceive();
    expect(container.querySelector("[role=alert]")!.textContent).toContain("desktop app");
  });

  describe("chat", () => {
    async function send(message: string) {
      await type(
        container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')!,
        message
      );
      await click(buttonByText("Send"));
    }

    it("sends through the chosen PC and streams the answer", async () => {
      await openReceive();
      await send("hello");
      expect(svc.sendChat).toHaveBeenCalledWith(
        expect.objectContaining({
          hostId: "h1",
          agent: "claude",
          message: "hello",
          session: null,
        })
      );
      const chatId = svc.sendChat.mock.calls[0][0].chatId as string;
      expect(buttonByText("Stop")).toBeTruthy(); // busy until the answer ends

      await sendEvent(chatEvent(chatId, "route", { route: "shared", hostName: "Office-PC" }));
      await sendEvent(chatEvent(chatId, "session", { sessionId: "sess-1" }));
      await sendEvent(chatEvent(chatId, "tool", { name: "Read", detail: "a.ts" }));
      await sendEvent(chatEvent(chatId, "text", { text: "Hi there" }));
      await sendEvent(chatEvent(chatId, "text", { text: "More" }));
      await sendEvent(chatEvent(chatId, "end", { status: "completed", route: "shared" }));

      const log = container.querySelector(".sa-log")!;
      expect(log.textContent).toContain("hello");
      expect(log.textContent).toContain("Office-PC · Claude Code");
      expect(log.textContent).toContain("Hi there\n\nMore");
      expect(log.textContent).toContain("Read a.ts");
      expect(buttonByText("Send")).toBeTruthy();

      // The next message continues the same conversation on that host.
      await send("and then?");
      expect(svc.sendChat.mock.calls[1][0].session).toBe("sess-1");
    });

    it("shows the answer as it is written, then the whole block in its place", async () => {
      await openReceive();
      await send("hi");
      const chatId = svc.sendChat.mock.calls[0][0].chatId as string;
      // The answer bubble is there before the PC says anything.
      expect(container.querySelector(".sa-log .sa-typing")).toBeTruthy();
      await sendEvent(chatEvent(chatId, "delta", { text: "Hel" }));
      await sendEvent(chatEvent(chatId, "delta", { text: "lo wor" }));
      const log = container.querySelector(".sa-log")!;
      expect(log.textContent).toContain("Hello wor");
      expect(log.querySelector(".sa-caret")).toBeTruthy();
      await sendEvent(chatEvent(chatId, "text", { text: "Hello world" }));
      expect(log.textContent).toContain("Hello world");
      expect(log.textContent).not.toContain("Hello worHello");
      expect(log.querySelector(".sa-caret")).toBeNull();
    });

    it("shows a failure the PC reports", async () => {
      await openReceive();
      await send("hi");
      const chatId = svc.sendChat.mock.calls[0][0].chatId as string;
      await sendEvent(chatEvent(chatId, "end", { status: "failed", error: "It broke" }));
      const log = container.querySelector(".sa-log")!;
      expect(log.textContent).toContain("It broke");
      expect(log.querySelector(".sa-typing")).toBeNull(); // the empty answer bubble is gone
      expect(buttonByText("Send")).toBeTruthy();
    });

    it("ignores events for another chat", async () => {
      await openReceive();
      await send("hi");
      await sendEvent(chatEvent("someone-else", "text", { text: "LEAKED" }));
      expect(container.querySelector(".sa-log")!.textContent).not.toContain("LEAKED");
    });

    it("stops a running answer", async () => {
      await openReceive();
      await send("hi");
      const chatId = svc.sendChat.mock.calls[0][0].chatId as string;
      await click(buttonByText("Stop"));
      expect(svc.stopChat).toHaveBeenCalledWith(chatId);
      await sendEvent(chatEvent(chatId, "end", { status: "stopped", route: "shared" }));
      expect(container.querySelector(".sa-log")!.textContent).toContain("Stopped.");
    });

    it("reports a message the service refused, and frees the box", async () => {
      svc.sendChat.mockResolvedValue({
        ok: false,
        error: { code: "busy", message: "Already answering." },
      });
      await openReceive();
      await send("hi");
      expect(container.querySelector(".sa-log")!.textContent).toContain("Already answering.");
      expect(buttonByText("Send")).toBeTruthy();
    });

    it("is cleared by New chat, which also forgets the host session", async () => {
      await openReceive();
      await send("one");
      const chatId = svc.sendChat.mock.calls[0][0].chatId as string;
      await sendEvent(chatEvent(chatId, "session", { sessionId: "sess-1" }));
      await sendEvent(chatEvent(chatId, "end", { status: "completed" }));
      await click(buttonByText("New chat"));
      expect(container.querySelector(".sa-log")!.textContent).not.toContain("one");
      await send("fresh");
      expect(svc.sendChat.mock.calls[1][0].session).toBeNull();
    });

    it("does not send when the joined PC has no agent", async () => {
      svc.listHosts.mockResolvedValue({
        ok: true,
        value: [office({ agents: [{ id: "claude", name: "Claude Code", available: false }] })],
      });
      await openReceive();
      expect(
        container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')!.disabled
      ).toBe(true);
      expect(container.querySelector(".sa-log")!.textContent).toContain("no agent to answer");
    });

    it("pops out into its own window with the conversation, and takes it back", async () => {
      desktop.tauri = true;
      await openReceive();
      await send("first");
      const chatId = svc.sendChat.mock.calls[0][0].chatId as string;
      const popOut = () =>
        container.querySelector<HTMLButtonElement>('button[aria-label="Pop out chat"]')!;
      expect(popOut().disabled).toBe(true); // not while an answer is coming in
      await sendEvent(chatEvent(chatId, "session", { sessionId: "sess-1" }));
      await sendEvent(chatEvent(chatId, "text", { text: "answer" }));
      await sendEvent(chatEvent(chatId, "end", { status: "completed" }));

      await click(popOut());
      const handed = chatWindow.popOutChat.mock.calls[0][0];
      expect(handed.hostId).toBe("h1");
      expect(handed.sessions).toEqual({ "h1:claude": "sess-1" });
      expect(handed.messages.map((m: { text: string }) => m.text)).toEqual(["first", "answer"]);

      // The window opened: the panel says where the chat went.
      await act(async () => chatWindow.closed?.(true));
      expect(text()).toContain("open in its own window");
      expect(container.querySelector('textarea[aria-label="Message"]')).toBeNull();

      // The window hands back a longer conversation when it closes.
      localStorage.setItem(
        "kai_shared_chat_handoff",
        JSON.stringify({
          ...handed,
          messages: [...handed.messages, { id: 99, kind: "you", text: "from the window" }],
        })
      );
      await act(async () => chatWindow.closed?.(false));
      expect(container.querySelector(".sa-log")!.textContent).toContain("from the window");
      await send("again");
      expect(svc.sendChat.mock.calls[1][0].session).toBe("sess-1");
    });

    it("lets the service's exit end a chat in progress", async () => {
      await openReceive();
      await send("hi");
      await sendEvent({ event: "service_exit" });
      expect(container.querySelector(".sa-log")!.textContent).toContain("service stopped");
      expect(buttonByText("Send")).toBeTruthy();
    });
  });

  it("updates joined PCs when the service pushes new state", async () => {
    await openReceive();
    await sendEvent({
      event: "hosts",
      hosts: [office({ usage: { ...emptyUsage(), input: 99_999 } })],
    });
    expect(container.querySelector('[aria-labelledby="sa-join-title"]')!.textContent).toContain(
      "99,999"
    );
  });
});

describe("Share my agent", () => {
  async function openShare() {
    await mount();
    await click(buttonByText("Share my agent"));
    await flush();
  }

  it("is the first tab, and opens first", async () => {
    await mount();
    const tabs = [...container.querySelectorAll('[role="tab"]')].map((t) => t.textContent);
    expect(tabs).toEqual(["Share my agent", "Use a shared agent"]);
    expect(container.querySelector('[role="tab"][aria-selected="true"]')!.textContent).toBe(
      "Share my agent"
    );
  });

  it("starts off, checks the port, and starts sharing on it", async () => {
    svc.checkPort.mockResolvedValue({
      ok: true,
      value: { port: 8765, available: true, ours: false, message: "Port 8765 is free." },
    });
    svc.setSharing.mockResolvedValue({
      ok: true,
      value: shareStatus({
        enabled: true,
        listening: { port: 8765, urls: ["http://192.168.1.20:8765"] },
      }),
    });
    await openShare();
    expect(text()).toContain("Start sharing to let PCs on your network");
    expect(text()).not.toContain("Agents you share");
    expect(container.querySelector<HTMLInputElement>("#sa-port")!.value).toBe("8765");
    await click(buttonByText("Start sharing"));
    expect(svc.checkPort).toHaveBeenCalledWith(8765);
    expect(svc.setSharing).toHaveBeenCalledWith(true, 8765);
    expect(container.querySelector<HTMLInputElement>("#sa-port")!.disabled).toBe(true);
    expect(text()).toContain("Listening on http://192.168.1.20:8765");
    expect(text()).toContain("Agents you share");
    expect(text()).toContain("Found · 2.1.0");
    // Only installed agents are listed: OpenCode is missing here, so it has no row.
    expect(text()).not.toContain("Not found");
    expect(container.querySelector('input[aria-label="Share OpenCode"]')).toBeNull();
  });

  const on = shareStatus({
    enabled: true,
    listening: { port: 8765, urls: ["http://192.168.1.20:8765"] },
  });

  it("does not start on a port another program holds, and says why", async () => {
    svc.checkPort.mockResolvedValue({
      ok: true,
      value: {
        port: 9000,
        available: false,
        ours: false,
        message: "Port 9000 is already in use by another program. Choose another port.",
      },
    });
    await openShare();
    await type(container.querySelector<HTMLInputElement>("#sa-port")!, "9000");
    await click(buttonByText("Check port"));
    expect(svc.checkPort).toHaveBeenCalledWith(9000);
    expect(text()).toContain("Port 9000 is already in use by another program");
    await click(buttonByText("Start sharing"));
    expect(svc.setSharing).not.toHaveBeenCalled();
  });

  it("rejects a port outside 1024-65535 before asking the service", async () => {
    await openShare();
    await type(container.querySelector<HTMLInputElement>("#sa-port")!, "80");
    expect(text()).toContain("Use a number from 1024 to 65535.");
    expect(buttonByText("Start sharing")!.disabled).toBe(true);
  });

  it("stops sharing and confirms the port was released", async () => {
    svc.getShareStatus.mockResolvedValue({ ok: true, value: on });
    svc.setSharing.mockResolvedValue({ ok: true, value: shareStatus() });
    svc.checkPort.mockResolvedValue({
      ok: true,
      value: { port: 8765, available: true, ours: false, message: "Port 8765 is free." },
    });
    await openShare();
    await click(buttonByText("Stop sharing"));
    expect(svc.setSharing).toHaveBeenCalledWith(false);
    expect(svc.checkPort).toHaveBeenCalledWith(8765);
    expect(text()).toContain("Sharing stopped. Port 8765 was released.");
  });

  it("creates an invite that lasts until sharing is turned off", async () => {
    svc.getShareStatus.mockResolvedValue({ ok: true, value: on });
    const link = `http://192.168.1.20:8765/join#${"u".repeat(43)}`;
    svc.createInvite.mockResolvedValue({
      ok: true,
      value: {
        share: {
          ...on,
          invites: [{ id: "i9", createdAt: "2026-01-01T00:00:00Z", expiresInSeconds: null }],
        },
        invite: { id: "i9", link, expiresInSeconds: null },
      },
    });
    await openShare();
    const select = container.querySelector<HTMLSelectElement>("#sa-expiry")!;
    expect([...select.options].map((o) => o.textContent)).toContain("Until I turn it off");
    await act(async () => {
      select.value = "0";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await click(buttonByText("Generate invite link"));
    expect(svc.createInvite).toHaveBeenCalledWith(0);
    expect(text()).toContain("valid until you cancel it or stop sharing");
    expect(container.querySelector(".sa-countdown")).toBeNull();
  });

  it("explains that internet access off means same-network only", async () => {
    svc.getShareStatus.mockResolvedValue({ ok: true, value: on });
    await openShare();
    expect(container.querySelector(".sa-fold summary")!.textContent).toContain("LAN only");
    expect(text()).toContain("only PCs on your own network (same Wi-Fi or LAN) can join");
  });

  it("creates an invite, shows the link once with a countdown, and can cancel it", async () => {
    svc.getShareStatus.mockResolvedValue({ ok: true, value: on });
    const link = `http://192.168.1.20:8765/join#${"k".repeat(43)}`;
    svc.createInvite.mockResolvedValue({
      ok: true,
      value: {
        share: {
          ...on,
          invites: [{ id: "i1", createdAt: "2026-01-01T00:00:00Z", expiresInSeconds: 900 }],
        },
        invite: { id: "i1", link, expiresInSeconds: 900 },
      },
    });
    svc.cancelInvite.mockResolvedValue({ ok: true, value: on });
    await openShare();
    await click(buttonByText("Generate invite link"));
    expect(svc.createInvite).toHaveBeenCalledWith(15);
    expect(container.querySelector(".sa-invite-link")!.textContent).toBe(link);
    expect(text()).toMatch(/expires in 1[45]:\d\d/);
    await click(buttonByText("Cancel invite"));
    expect(svc.cancelInvite).toHaveBeenCalledWith("i1");
    expect(container.querySelector(".sa-invite-link")).toBeNull();
  });

  it("turns internet access on from a pasted tunnel address, and shows both links", async () => {
    svc.getShareStatus.mockResolvedValue({ ok: true, value: on });
    const net = { ...on, publicUrl: "https://share.example.com" };
    svc.setPublicUrl.mockResolvedValue({ ok: true, value: net });
    await openShare();
    expect(text()).toContain("any HTTPS tunnel or reverse proxy at port 8765");

    const input = container.querySelector<HTMLInputElement>('input[aria-label="Tunnel address"]')!;
    const type = (value: string) =>
      act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
        setter.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    await type("http://plain.example.com/path");
    expect(buttonByText("Use address")!.disabled).toBe(true);
    expect(text()).toContain("Use the tunnel's https address");
    await type("https://share.example.com");
    expect(text()).not.toContain("Use the tunnel's https address");
    await click(buttonByText("Use address"));
    expect(svc.setPublicUrl).toHaveBeenCalledWith("https://share.example.com");
    expect(container.querySelector(".sa-tunnel-url")!.textContent).toBe(
      "https://share.example.com"
    );
    expect(text()).toContain("same network + internet");

    const key = "k".repeat(43);
    svc.createInvite.mockResolvedValue({
      ok: true,
      value: {
        share: {
          ...net,
          invites: [{ id: "i2", createdAt: "2026-01-01T00:00:00Z", expiresInSeconds: 900 }],
        },
        invite: {
          id: "i2",
          link: `http://192.168.1.20:8765/join#${key}`,
          internetLink: `https://share.example.com/join#${key}`,
          expiresInSeconds: 900,
        },
      },
    });
    await click(buttonByText("Generate invite link"));
    const links = [...container.querySelectorAll(".sa-invite-link")].map((e) => e.textContent);
    expect(links).toEqual([
      `http://192.168.1.20:8765/join#${key}`,
      `https://share.example.com/join#${key}`,
    ]);

    svc.setPublicUrl.mockResolvedValue({
      ok: true,
      value: {
        ...on,
        invites: [{ id: "i2", createdAt: "2026-01-01T00:00:00Z", expiresInSeconds: 900 }],
      },
    });
    await click(buttonByText("Turn off"));
    expect(svc.setPublicUrl).toHaveBeenLastCalledWith(null);
    expect(container.querySelectorAll(".sa-invite-link")).toHaveLength(1);
  });

  it("lists joined PCs with their usage, and disconnects or removes them", async () => {
    const devices = [
      {
        id: "d1",
        name: "Amit-Laptop",
        address: "192.168.1.34",
        state: "connected" as const,
        lastSeen: new Date().toISOString(),
        activeRunId: null,
        usage: { input: 900, output: 100, cacheRead: 0, cacheWrite: 0, runs: 2, costUsd: 0 },
      },
      {
        id: "d2",
        name: "Sita-Desktop",
        address: "192.168.1.41",
        state: "disconnected" as const,
        lastSeen: new Date().toISOString(),
        activeRunId: null,
        usage: emptyUsage(),
      },
    ];
    svc.getShareStatus.mockResolvedValue({ ok: true, value: { ...on, devices } });
    svc.disconnectDevice.mockResolvedValue({ ok: true, value: { ...on, devices } });
    svc.removeDevice.mockResolvedValue({ ok: true, value: on });
    await openShare();
    const table = container.querySelector(".sa-devices")!;
    expect(table.textContent).toContain("Amit-Laptop");
    expect(table.textContent).toContain("1,000");
    expect(table.textContent).toContain("2 requests");
    await click(buttonByText("Disconnect"));
    expect(svc.disconnectDevice).toHaveBeenCalledWith("d1");
    await click(buttonByText("Remove"));
    expect(svc.removeDevice).not.toHaveBeenCalled(); // needs a second click
    await click(buttonByText("Confirm remove"));
    expect(svc.removeDevice).toHaveBeenCalledWith("d2");
  });

  const amit = (over: Partial<ShareDevice> = {}): ShareDevice => ({
    id: "d1",
    name: "Amit-Laptop",
    address: "192.168.1.34",
    state: "connected",
    lastSeen: new Date().toISOString(),
    activeRunId: null,
    usage: { input: 900, output: 100, cacheRead: 0, cacheWrite: 0, runs: 2, costUsd: 0.05 },
    grants: defaultGrants(),
    ...over,
  });

  it("edits one PC's permissions: agents, model and time limit", async () => {
    svc.getShareStatus.mockResolvedValue({ ok: true, value: { ...on, devices: [amit()] } });
    const saved = amit({
      grants: {
        agents: { claude: true, opencode: false },
        models: { claude: "haiku" },
        maxMinutes: 5,
      },
    });
    svc.setDeviceGrants.mockResolvedValue({ ok: true, value: { ...on, devices: [saved] } });
    await openShare();
    await click(buttonByText("Permissions"));
    const panel = container.querySelector('[aria-label="Permissions for Amit-Laptop"]')!;
    expect(panel).not.toBeNull();
    const minutes = panel.querySelector<HTMLInputElement>('input[type="number"]')!;
    expect(minutes.value).toBe("10");

    // A bad value is caught before anything is sent.
    await type(minutes, "0");
    await click(buttonByText("Save"));
    expect(svc.setDeviceGrants).not.toHaveBeenCalled();
    expect(panel.textContent).toContain("1 to 240 minutes");

    await type(minutes, "5");
    await click(panel.querySelector('input[aria-label="Allow OpenCode"]')!);
    // The model box of an agent the PC can't use is disabled.
    expect(
      panel.querySelector<HTMLInputElement>('input[aria-label="OpenCode model"]')!.disabled
    ).toBe(true);
    await type(
      panel.querySelector<HTMLInputElement>('input[aria-label="Claude Code model"]')!,
      "haiku"
    );
    await click(buttonByText("Save"));
    expect(svc.setDeviceGrants).toHaveBeenCalledWith("d1", {
      agents: { claude: true, opencode: false },
      models: { claude: "haiku" },
      maxMinutes: 5,
    });
    // Saved: the panel closes.
    expect(container.querySelector('[aria-label="Permissions for Amit-Laptop"]')).toBeNull();
  });

  it("shows a PC's usage per agent and its recent tasks", async () => {
    svc.getShareStatus.mockResolvedValue({ ok: true, value: { ...on, devices: [amit()] } });
    const history: DeviceHistory = {
      deviceId: "d1",
      usage: { input: 900, output: 100, cacheRead: 0, cacheWrite: 0, runs: 2, costUsd: 0.05 },
      byAgent: {
        claude: { input: 900, output: 100, cacheRead: 0, cacheWrite: 0, runs: 2, costUsd: 0.05 },
      },
      lastUsedAt: new Date().toISOString(),
      tasks: [
        {
          id: "t2",
          agent: "claude",
          model: "haiku",
          title: "why does this deadlock?",
          status: "failed",
          startedAt: new Date().toISOString(),
          endedAt: new Date().toISOString(),
          durationS: 125,
          tokens: { input: 400, output: 0, cacheRead: 0, cacheWrite: 0 },
          costUsd: 0,
          error: "boom",
        },
        {
          id: "t1",
          agent: "claude",
          model: "",
          title: "what is a mutex?",
          status: "completed",
          startedAt: new Date().toISOString(),
          endedAt: new Date().toISOString(),
          durationS: 4,
          tokens: { input: 500, output: 100, cacheRead: 0, cacheWrite: 0 },
          costUsd: 0.05,
          error: "",
        },
      ],
    };
    svc.getDeviceHistory.mockResolvedValue({ ok: true, value: history });
    await openShare();
    await click(buttonByText("Usage"));
    await flush();
    expect(svc.getDeviceHistory).toHaveBeenCalledWith("d1");
    const panel = container.querySelector('[aria-label="Usage of Amit-Laptop"]')!;
    expect(panel.textContent).toContain("2 requests · 1,000 tokens · $0.05");
    const rows = [...panel.querySelectorAll('[aria-label="Recent tasks"] tbody tr')].map(
      (r) => r.textContent
    );
    expect(rows[0]).toContain("why does this deadlock?");
    expect(rows[0]).toContain("Claude Code · haiku");
    expect(rows[0]).toContain("Failed");
    expect(rows[0]).toContain("2m 05s");
    expect(rows[1]).toContain("what is a mutex?");
    expect(rows[1]).toContain("Done");
    // Clicking again closes it.
    await click(buttonByText("Usage"));
    expect(container.querySelector('[aria-label="Usage of Amit-Laptop"]')).toBeNull();
  });

  it("shows live runs and can stop one", async () => {
    svc.getShareStatus.mockResolvedValue({
      ok: true,
      value: {
        ...on,
        runs: [
          {
            id: "r1",
            deviceName: "Amit-Laptop",
            agent: "claude",
            startedAt: "2026-01-01T00:00:00Z",
          },
        ],
      },
    });
    svc.stopHostRun.mockResolvedValue({ ok: true, value: on });
    await openShare();
    expect(text()).toContain("Amit-Laptop is running");
    await click(buttonByText("Stop"));
    expect(svc.stopHostRun).toHaveBeenCalledWith("r1");
  });

  it("warns when there is no network address for invite links", async () => {
    svc.getShareStatus.mockResolvedValue({
      ok: true,
      value: { ...on, listening: { port: 8765, urls: [] } },
    });
    await openShare();
    expect(container.querySelector("[role=alert]")!.textContent).toContain("Connect to a network");
  });

  it("refetches when the service reports a change", async () => {
    svc.getShareStatus.mockResolvedValue({ ok: true, value: on });
    await openShare();
    const before = svc.getShareStatus.mock.calls.length;
    vi.useFakeTimers();
    try {
      await sendEvent({ event: "share" });
      await act(async () => {
        vi.advanceTimersByTime(400);
      });
    } finally {
      vi.useRealTimers();
    }
    expect(svc.getShareStatus.mock.calls.length).toBeGreaterThan(before);
  });
});
