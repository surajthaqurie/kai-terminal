// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SharedAgentEvent, ShareStatus } from "../core/sharedAgent/types";

const svc = vi.hoisted(() => ({
  getShareStatus: vi.fn(),
  setSharing: vi.fn(),
  onSharedAgentEvent: vi.fn(),
}));
vi.mock("../services/sharedAgentService", () => svc);

import { SharedAgentToggle } from "../components/SharedAgentToggle";

const status = (over: Partial<ShareStatus> = {}): ShareStatus => ({
  enabled: false,
  listening: null,
  publicUrl: null,
  agents: [],
  invites: [],
  devices: [],
  runs: [],
  ...over,
});
const on = status({
  enabled: true,
  listening: { port: 8765, urls: ["http://192.168.1.20:8765"] },
});

let container: HTMLDivElement;
let root: Root;
let push: (e: SharedAgentEvent) => void;
const onOpen = vi.fn();

const button = () =>
  container.querySelector<HTMLButtonElement>("button[aria-pressed]") as HTMLButtonElement;
const click = (el: Element) => act(async () => (el as HTMLElement).click());

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
  await act(async () => root.render(<SharedAgentToggle onOpenSharedAgent={onOpen} />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("title-bar Shared Agent switch", () => {
  it("starts off without waking the engine, and one click turns sharing on and off", async () => {
    expect(button().getAttribute("aria-pressed")).toBe("false");
    expect(button().getAttribute("aria-label")).toBe("Share my agents");
    expect(svc.getShareStatus).not.toHaveBeenCalled();
    expect(svc.setSharing).not.toHaveBeenCalled();

    svc.setSharing.mockResolvedValueOnce({ ok: true, value: on });
    await click(button());
    expect(svc.setSharing).toHaveBeenLastCalledWith(true);
    expect(button().getAttribute("aria-pressed")).toBe("true");
    expect(button().title).toContain("0 PCs connected");
    expect(container.querySelector(".header-share-dot")).not.toBeNull();

    svc.setSharing.mockResolvedValueOnce({ ok: true, value: status() });
    await click(button());
    expect(svc.setSharing).toHaveBeenLastCalledWith(false);
    expect(button().getAttribute("aria-pressed")).toBe("false");
    expect(container.querySelector(".header-share-dot")).toBeNull();
  });

  it("follows changes made in the Shared Agent panel", async () => {
    svc.getShareStatus.mockResolvedValue({
      ok: true,
      value: {
        ...on,
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
      },
    });
    await act(async () => push({ event: "share" }));
    expect(button().getAttribute("aria-pressed")).toBe("true");
    expect(button().title).toContain("1 PC connected · internet on");

    // The engine stopped (app closing, crash): sharing is off.
    await act(async () => push({ event: "service_exit" }));
    expect(button().getAttribute("aria-pressed")).toBe("false");
  });

  it("says why sharing could not start", async () => {
    svc.setSharing.mockResolvedValueOnce({
      ok: false,
      error: { code: "unavailable", message: "Could not start sharing: port in use" },
    });
    await click(button());
    expect(button().getAttribute("aria-pressed")).toBe("false");
    expect(button().className).toContain("is-error");
    expect(button().title).toContain("Could not start sharing: port in use");
  });

  it("opens the Shared Agent panel from its menu", async () => {
    await click(container.querySelector('button[aria-label="Shared Agent options"]')!);
    const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    expect(items.map((i) => i.textContent)).toEqual(
      expect.arrayContaining([expect.stringContaining("Share my agents")])
    );
    await click(items.find((i) => i.textContent?.includes("Invites & connected PCs"))!);
    expect(onOpen).toHaveBeenCalled();
  });
});
