// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { useTabs } from "../hooks/useTabs";
import { useSessionPersistence } from "../hooks/useSessionPersistence";
import { LAYOUT_KEY } from "../services/tabFactory";
import type { TabSeed } from "../services/terminalWindows";

vi.mock("../services/appWindow", () => ({ closeAppWindow: vi.fn(async () => false) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SEED: TabSeed = {
  title: "api",
  color: "#ef4444",
  cwd: "C:\\work\\api",
  splitDirection: "vertical",
  activePaneId: "b",
  layout: {
    kind: "split",
    id: "s1",
    direction: "vertical",
    ratio: 0.4,
    first: { kind: "pane", paneId: "a" },
    second: { kind: "pane", paneId: "b" },
  },
  panes: [
    {
      id: "a",
      cwd: "C:\\work\\api",
      adopt: { ptyId: "pty-a", snapshot: "SCREEN", cols: 100, rows: 30 },
    },
    { id: "b", cwd: "C:\\work\\api\\web" },
  ],
};

interface Api {
  tabsState: ReturnType<typeof useTabs>;
  persistence: ReturnType<typeof useSessionPersistence>;
}
let api: Api;
let seed: TabSeed | null;
let persistenceEnabled: boolean;

function Harness() {
  const tabsState = useTabs({
    effectiveShellPath: undefined,
    setLastError: vi.fn(),
    initialSeed: seed,
  });
  const persistence = useSessionPersistence({
    tabs: tabsState.tabs,
    setTabs: tabsState.setTabs,
    setActiveTabId: tabsState.setActiveTabId,
    autoRestoreSession: false,
    enabled: persistenceEnabled,
  });
  api = { tabsState, persistence };
  return null;
}

let root: ReturnType<typeof createRoot>;
const mount = () => act(async () => root.render(<Harness />));

beforeEach(() => {
  localStorage.clear();
  seed = null;
  persistenceEnabled = true;
  root = createRoot(document.createElement("div"));
});
afterEach(() => act(() => root.unmount()));

describe("a window opened with a tab dragged out of another", () => {
  beforeEach(() => {
    seed = SEED;
  });

  it("starts with that tab and no starter tab (no shell nobody asked for)", async () => {
    await mount();
    const { tabs, activeTabId } = api.tabsState;
    expect(tabs).toHaveLength(1);
    expect(tabs[0]).toMatchObject({ title: "api", color: "#ef4444", splitDirection: "vertical" });
    expect(tabs[0].panes.map((p) => p.id)).toEqual(["a", "b"]);
    expect(tabs[0].activePaneId).toBe("b");
    expect(tabs[0].layout).toEqual(SEED.layout);
    expect(activeTabId).toBe(tabs[0].id);
  });

  it("marks the moved pane to attach to its running shell, and the other to start fresh", async () => {
    await mount();
    const [a, b] = api.tabsState.tabs[0].panes;
    expect(a.adopt).toMatchObject({ ptyId: "pty-a", snapshot: "SCREEN" });
    expect(b.adopt).toBeUndefined();
    expect(a.status).toBe("connecting");
  });

  it("drops the screen snapshot once the pane has attached, so it is not kept in state", async () => {
    await mount();
    const tab = api.tabsState.tabs[0];
    await act(async () => api.tabsState.setPaneStatus(tab.id, "a", "connected"));
    expect(api.tabsState.tabs[0].panes[0].adopt).toBeUndefined();
    expect(api.tabsState.tabs[0].panes[0].status).toBe("connected");
  });

  it("keeps the snapshot while the pane is still connecting", async () => {
    await mount();
    const tab = api.tabsState.tabs[0];
    await act(async () => api.tabsState.setPaneStatus(tab.id, "a", "connecting"));
    expect(api.tabsState.tabs[0].panes[0].adopt).toBeDefined();
  });

  it("falls back to a normal starter tab when the seed has no panes", async () => {
    seed = { ...SEED, panes: [] };
    await mount();
    expect(api.tabsState.tabs).toHaveLength(1);
    expect(api.tabsState.tabs[0].title).toBe("Terminal 1");
  });
});

describe("saved layout belongs to the first window only", () => {
  const PREVIOUS = [{ title: "api", cwd: "C:\\work\\api" }];

  it("an extra window neither offers the previous session nor overwrites its layout", async () => {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(PREVIOUS));
    persistenceEnabled = false;
    await mount();
    expect(api.persistence.pendingRestore).toBeNull();

    await act(async () => api.tabsState.newTab());
    await act(async () => api.tabsState.newTab());
    // The first window's saved layout is exactly as it was.
    expect(JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? "null")).toEqual(PREVIOUS);
  });

  it("the first window still saves as before", async () => {
    await mount();
    await act(async () => api.tabsState.newTab());
    // Written after a short quiet period (and when the window hides).
    await act(async () => void (await new Promise((r) => setTimeout(r, 650))));
    const saved = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? "null");
    expect(saved).toHaveLength(2);
  });
});
