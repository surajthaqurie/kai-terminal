// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import fs from "fs";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalTab } from "../types/terminal";

/**
 * FUNC-02: the title-bar close button asked before ending running commands, but closing the
 * window any other way (Alt+F4, the taskbar) ended every shell at once. The backend now holds
 * that close back and the page asks, exactly as for the button.
 */
const calls: string[] = [];
const busy = { ids: [] as string[] };
let listener: ((e: unknown) => void) | undefined;

vi.mock("../services/ptyService", () => ({
  isTauriAvailable: () => true,
  PtyService: { busySessions: vi.fn(async () => busy.ids) },
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (_name: string, cb: (e: unknown) => void) => {
    listener = cb;
    return () => {
      listener = undefined;
    };
  }),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => {
    calls.push(`invoke:${cmd}`);
  }),
}));
vi.mock("../services/appWindow", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/appWindow")>()),
  closeAppWindow: vi.fn(async () => {
    calls.push("close-window");
    return true;
  }),
}));

import { watchWindowCloseRequests } from "../services/appWindow";
import { useCloseGuard } from "../hooks/useCloseGuard";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("watchWindowCloseRequests", () => {
  beforeEach(() => {
    calls.length = 0;
    listener = undefined;
  });

  it("acknowledges the question first, then hands it to the page", async () => {
    const onRequest = vi.fn(() => calls.push("asked"));
    const off = await watchWindowCloseRequests(onRequest);
    expect(listener).toBeDefined();

    listener!({});
    expect(calls).toEqual(["invoke:close_request_ack", "asked"]);
    expect(onRequest).toHaveBeenCalledTimes(1);

    off();
    expect(listener).toBeUndefined();
  });
});

describe("requestCloseWindow", () => {
  let api: ReturnType<typeof useCloseGuard>;
  let root: Root;
  const tab = {
    id: "t1",
    title: "T",
    status: "connected",
    activePaneId: "p1",
    panes: [{ id: "p1" }, { id: "p2" }],
  } as unknown as TerminalTab;

  function Harness() {
    api = useCloseGuard({
      tabsRef: { current: [tab] },
      activeTabIdRef: { current: "t1" },
      terminalRefs: {
        current: {
          p1: { handoffSessionId: () => "s1" } as never,
          p2: { handoffSessionId: () => "s2" } as never,
        },
      },
      closeTab: vi.fn(),
      closeActivePane: vi.fn(),
      restoreWorkspace: vi.fn(),
    });
    return null;
  }

  beforeEach(async () => {
    calls.length = 0;
    busy.ids = [];
    root = createRoot(document.createElement("div"));
    await act(async () => root.render(<Harness />));
  });
  afterEach(() => act(() => root.unmount()));

  it("closes at once when nothing is running", async () => {
    await act(async () => api.requestCloseWindow());
    expect(calls).toEqual(["close-window"]);
    expect(api.pending).toBeNull();
  });

  it("asks when a command is running, and closes only after the user confirms", async () => {
    busy.ids = ["s2"];
    await act(async () => api.requestCloseWindow());
    expect(calls).toEqual([]);
    expect(api.pending?.title).toMatch(/window/i);

    await act(async () => api.pending!.confirm());
    expect(calls).toEqual(["close-window"]);
  });

  it("leaves the window open when the user cancels", async () => {
    busy.ids = ["s1", "s2"];
    await act(async () => api.requestCloseWindow());
    await act(async () => api.pending!.cancel());
    expect(calls).toEqual([]);
    expect(api.pending).toBeNull();
  });
});

describe("wiring that a unit test of each piece would not notice", () => {
  const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, "../..", rel), "utf8");

  it("the app listens for the request and the close button uses the same guard", () => {
    const app = read("src/App.tsx");
    expect(app).toContain("watchWindowCloseRequests(");
    expect(app).toContain("onCloseWindow={closeGuard.requestCloseWindow}");
  });

  it("the page and the backend use the same event and acknowledgement command", () => {
    const lib = read("src-tauri/src/lib.rs");
    const page = read("src/services/appWindow.ts");
    expect(lib).toContain('"kai-close-requested"');
    expect(page).toContain('"kai-close-requested"');
    expect(page).toContain('"close_request_ack"');
    // Granted to the terminal windows only (the ACL test pins the other windows' lists).
    expect(read("src-tauri/capabilities/default.json")).toContain("allow-close-request-ack");
    expect(read("src-tauri/capabilities/music-pip.json")).not.toContain("close-request-ack");
    expect(read("src-tauri/capabilities/shared-chat.json")).not.toContain("close-request-ack");
  });
});
