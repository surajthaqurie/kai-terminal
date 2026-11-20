// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agentChoices,
  describeRoute,
  formatAgo,
  formatCountdown,
  formatTokens,
  hostStatusPill,
  tokenBreakdown,
  tokensUsed,
} from "../components/sharedAgentViewModel";
import { emptyUsage, type AgentView, type JoinedHost } from "../core/sharedAgent/types";

const host = (over: Partial<JoinedHost> = {}): JoinedHost => ({
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
  agents: [
    { id: "claude", name: "Claude Code", available: true },
    { id: "opencode", name: "OpenCode", available: false },
  ],
  usage: emptyUsage(),
  ...over,
});

describe("token wording", () => {
  it("groups digits and sums every kind of token", () => {
    expect(formatTokens(13072)).toBe("13,072");
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(-4)).toBe("0");
    const usage = {
      input: 10_000,
      output: 2_000,
      cacheRead: 1_000,
      cacheWrite: 72,
      runs: 3,
      costUsd: 0,
    };
    expect(tokensUsed(usage)).toBe("13,072");
    expect(tokenBreakdown(usage)).toBe(
      "Input 10,000 · output 2,000 · cache read 1,000 · cache write 72"
    );
  });

  it("formats countdowns and ages", () => {
    expect(formatCountdown(905)).toBe("15:05");
    expect(formatCountdown(-3)).toBe("0:00");
    const now = Date.parse("2026-05-01T12:00:00Z");
    expect(formatAgo(null, now)).toBe("never");
    expect(formatAgo("2026-05-01T11:59:50Z", now)).toBe("just now");
    expect(formatAgo("2026-05-01T11:55:00Z", now)).toBe("5 min ago");
    expect(formatAgo("2026-05-01T09:00:00Z", now)).toBe("3 h ago");
  });
});

describe("the joined PC's state", () => {
  it("is live on a reachable host, with latency", () => {
    expect(describeRoute(host())).toMatchObject({
      tone: "ok",
      badge: "LIVE",
      title: "Connected to Office-PC",
      detail: "latency 38 ms",
    });
  });

  it("says the host is offline and never mentions this PC's own agent", () => {
    const view = describeRoute(host({ online: false, latencyMs: null }));
    expect(view).toMatchObject({ tone: "bad", badge: "OFFLINE" });
    expect(JSON.stringify(view)).not.toMatch(/own/i);
  });

  it("asks to join when no PC is joined", () => {
    const view = describeRoute(null);
    expect(view).toMatchObject({ badge: "NOT JOINED" });
    expect(JSON.stringify(view)).not.toMatch(/own Claude/i);
  });

  it("says so when it is still checking, or the host removed this PC", () => {
    expect(describeRoute(host({ online: null }))).toMatchObject({ badge: "CHECKING" });
    const removed = describeRoute(host({ connected: false, online: null }));
    expect(removed).toMatchObject({ tone: "bad", badge: "REMOVED" });
    expect(removed.detail).toContain("new invite link");
  });
});

describe("agent choices and status pills", () => {
  it("offers only the joined PC's agents", () => {
    const ids = (a: AgentView[]) => a.map((x) => x.id);
    expect(ids(agentChoices(host()))).toEqual(["claude"]);
    expect(agentChoices(null)).toEqual([]);
    expect(agentChoices(host({ connected: false }))).toEqual([]);
    expect(agentChoices(host({ agents: [], online: false }))).toEqual([]);
    // Still being checked: Claude is assumed so the first message need not wait.
    expect(ids(agentChoices(host({ agents: [], online: null })))).toEqual(["claude"]);
  });

  it("labels each state", () => {
    expect(hostStatusPill(host())).toEqual({ label: "Connected", tone: "ok" });
    expect(hostStatusPill(host({ online: false }))).toEqual({ label: "Offline", tone: "bad" });
    expect(hostStatusPill(host({ online: null }))).toEqual({ label: "Checking", tone: "idle" });
    expect(hostStatusPill(host({ connected: false }))).toEqual({ label: "Removed", tone: "bad" });
  });
});

describe("desktop IPC wrapper", () => {
  const invoke = vi.fn();
  let tauri = true;

  beforeEach(() => {
    vi.resetModules();
    invoke.mockReset();
    tauri = true;
    vi.doMock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
    vi.doMock("../services/ptyService", () => ({ isTauriAvailable: () => tauri }));
  });

  afterEach(() => {
    vi.doUnmock("@tauri-apps/api/core");
    vi.doUnmock("../services/ptyService");
  });

  it("sends one JSON request through the shell and returns the parsed answer", async () => {
    const svc = await import("../services/sharedAgentService");
    invoke.mockResolvedValue(JSON.stringify({ ok: true, hosts: [] }));
    const res = await svc.listHosts(true);
    expect(res).toEqual({ ok: true, value: [] });
    expect(invoke.mock.calls[0][0]).toBe("shared_agent_request_cmd");
    expect(JSON.parse(invoke.mock.calls[0][1].requestJson)).toEqual({
      op: "hosts_list",
      refresh: true,
    });
  });

  it("never throws: outside the app, on IPC failure, and on bad replies", async () => {
    const svc = await import("../services/sharedAgentService");
    tauri = false;
    expect(await svc.getShareStatus()).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(invoke).not.toHaveBeenCalled();

    tauri = true;
    invoke.mockRejectedValue("Could not start the Shared Agent service.");
    expect(await svc.getShareStatus()).toMatchObject({
      ok: false,
      error: { message: "Could not start the Shared Agent service." },
    });
    invoke.mockResolvedValue("not json");
    expect(await svc.getShareStatus()).toMatchObject({ ok: false });
    invoke.mockResolvedValue(JSON.stringify({ nope: true }));
    expect(await svc.getShareStatus()).toMatchObject({ ok: false });
    invoke.mockResolvedValue(JSON.stringify({ ok: true }));
    expect(await svc.getShareStatus()).toMatchObject({ ok: false }); // missing `share`
    invoke.mockResolvedValue(
      JSON.stringify({ ok: false, error: { code: "busy", message: "Busy." } })
    );
    expect(await svc.joinHost("http://192.168.1.2:1/join#abcdefgh")).toEqual({
      ok: false,
      error: { code: "busy", message: "Busy." },
    });
  });

  it("passes chat requests through unchanged", async () => {
    const svc = await import("../services/sharedAgentService");
    invoke.mockResolvedValue(JSON.stringify({ ok: true, chatId: "c1" }));
    const input = {
      chatId: "c1",
      hostId: "h1",
      agent: "claude" as const,
      message: "hi",
      session: null,
      route: "shared_first" as const,
      fallback: "ask" as const,
    };
    expect(await svc.sendChat(input)).toEqual({ ok: true, value: "c1" });
    expect(JSON.parse(invoke.mock.calls[0][1].requestJson)).toEqual({ op: "chat_send", ...input });
  });
});
