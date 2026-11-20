// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SharedAgentEvent, ShareStatus } from "../core/sharedAgent/types";

const svc = vi.hoisted(() => ({
  getShareStatus: vi.fn(),
  onSharedAgentEvent: vi.fn(),
}));
vi.mock("../services/sharedAgentService", () => svc);

import { HeaderActions } from "../components/HeaderActions";

const status = (over: Partial<ShareStatus> = {}): ShareStatus => ({
  enabled: false,
  port: 8765,
  listening: null,
  publicUrl: null,
  agents: [],
  invites: [],
  devices: [],
  runs: [],
  safetyCode: null,
  ...over,
});

let container: HTMLDivElement;
let root: Root;
let push: (e: SharedAgentEvent) => void;

const aiCli = () =>
  container.querySelector<HTMLButtonElement>('button[aria-label="Open AI CLI providers"]')!;
const dot = () => aiCli().querySelector(".header-status-dot");

beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  svc.onSharedAgentEvent.mockImplementation(async (cb: (e: SharedAgentEvent) => void) => {
    push = cb;
    return () => {};
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      <HeaderActions
        actions={[]}
        paletteShortcut="Ctrl+Shift+P"
        onOpenCommandPalette={() => {}}
        onOpenAiCli={() => {}}
        onOpenSettings={() => {}}
      />
    )
  );
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("sharing status on the AI CLI providers icon", () => {
  it("has no separate share button, and asks nothing of the engine at start", () => {
    expect(container.querySelector('[aria-label="Share my agents"]')).toBeNull();
    expect(dot()).toBeNull();
    expect(svc.getShareStatus).not.toHaveBeenCalled();
  });

  it("shows a green dot while sharing is on, and drops it when sharing stops", async () => {
    svc.getShareStatus.mockResolvedValue({
      ok: true,
      value: status({
        enabled: true,
        listening: { port: 8765, urls: ["http://192.168.1.20:8765"] },
        publicUrl: "https://my-pc.example.com",
        devices: [
          {
            id: "d1",
            name: "Laptop",
            address: "192.168.1.34",
            state: "connected",
            lastSeen: "",
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, runs: 0, costUsd: 0 },
            activeRunId: null,
            grants: { agents: { claude: true, opencode: true }, models: {}, maxMinutes: 10 },
          },
        ],
      }),
    });
    await act(async () => push({ event: "share" }));
    expect(dot()).not.toBeNull();
    expect(aiCli().title).toContain("Sharing your agents · 1 PC connected · internet on");
    // A status, not a toggle: the button itself is not pressed or highlighted.
    expect(aiCli().getAttribute("aria-pressed")).toBeNull();
    expect(aiCli().className).toBe("header-icon-btn");

    svc.getShareStatus.mockResolvedValue({ ok: true, value: status() });
    await act(async () => push({ event: "share" }));
    expect(dot()).toBeNull();
    expect(aiCli().title).toBe("AI CLI providers");
  });

  it("clears when the engine stops", async () => {
    svc.getShareStatus.mockResolvedValue({ ok: true, value: status({ enabled: true }) });
    await act(async () => push({ event: "share" }));
    expect(dot()).not.toBeNull();
    await act(async () => push({ event: "service_exit" }));
    expect(dot()).toBeNull();
  });
});
