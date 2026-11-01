// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { useTabs } from "../hooks/useTabs";
import { useSessionPersistence } from "../hooks/useSessionPersistence";
import { LAYOUT_KEY } from "../services/tabFactory";
import type { Workspace } from "../services/workspaces";

vi.mock("../services/appWindow", () => ({ closeAppWindow: vi.fn(async () => false) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PREVIOUS = [
  { title: "api", cwd: "C:\\work\\api" },
  { title: "web", cwd: "C:\\work\\web" },
];

interface Api {
  tabsState: ReturnType<typeof useTabs>;
  persistence: ReturnType<typeof useSessionPersistence>;
}
let api: Api;
let autoRestore: boolean | undefined;

function Harness() {
  const tabsState = useTabs({ cwd: "", effectiveShellPath: undefined, setLastError: vi.fn() });
  const persistence = useSessionPersistence({
    tabs: tabsState.tabs,
    setTabs: tabsState.setTabs,
    setActiveTabId: tabsState.setActiveTabId,
    autoRestoreSession: autoRestore,
    onWorkspaceCwd: vi.fn(),
  });
  api = { tabsState, persistence };
  return null;
}

let root: ReturnType<typeof createRoot>;
const mount = () => act(async () => root.render(<Harness />));
const saved = () =>
  JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? "null") as Array<{
    title: string;
  }> | null;
const titles = () => api.tabsState.tabs.map((t) => t.title);

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(LAYOUT_KEY, JSON.stringify(PREVIOUS));
  autoRestore = undefined;
  root = createRoot(document.createElement("div"));
});
afterEach(() => act(() => root.unmount()));

describe("previous-session offer", () => {
  it("offers the saved tabs and leaves the saved layout untouched while only the starter exists", async () => {
    await mount();
    expect(api.persistence.pendingRestore).toHaveLength(2);
    expect(saved()?.map((t) => t.title)).toEqual(["api", "web"]);
  });

  it("replaces the lone starter tab when the session is loaded", async () => {
    await mount();
    await act(async () => api.persistence.restoreSession());
    expect(titles()).toEqual(["api", "web"]);
    expect(api.persistence.pendingRestore).toBeNull();
  });

  it("never kills live tabs: loading later ADDS the previous tabs next to them", async () => {
    await mount();
    await act(async () => api.tabsState.newTab());
    const liveIds = api.tabsState.tabs.map((t) => t.id);
    expect(liveIds).toHaveLength(2);

    await act(async () => api.persistence.restoreSession());

    expect(api.tabsState.tabs.map((t) => t.id).slice(0, 2)).toEqual(liveIds);
    expect(titles().slice(2)).toEqual(["api", "web"]);
    // The first restored tab becomes active.
    expect(api.tabsState.activeTabId).toBe(api.tabsState.tabs[2].id);
  });

  it("saves the user's tabs again as soon as they open one, even if the offer is ignored", async () => {
    await mount();
    await act(async () => api.tabsState.newTab());
    expect(saved()).toHaveLength(2);
    expect(saved()?.map((t) => t.title)).toEqual(["Terminal 1", "Terminal 2"]);
    // ...and the offer is still loadable this launch.
    expect(api.persistence.pendingRestore).toHaveLength(2);
  });

  it("dismissing keeps the starter and lets saving resume", async () => {
    await mount();
    await act(async () => api.persistence.dismissRestore());
    expect(api.persistence.pendingRestore).toBeNull();
    expect(titles()).toEqual(["Terminal 1"]);
    expect(saved()?.map((t) => t.title)).toEqual(["Terminal 1"]);
  });

  it("loading a workspace clears the offer instead of leaving it pending", async () => {
    await mount();
    const ws: Workspace = {
      id: "w1",
      name: "Work",
      createdAt: 0,
      tabs: [{ title: "from-workspace" }],
    } as Workspace;
    await act(async () => api.persistence.restoreWorkspace(ws));
    expect(titles()).toEqual(["from-workspace"]);
    expect(api.persistence.pendingRestore).toBeNull();
    expect(saved()?.map((t) => t.title)).toEqual(["from-workspace"]);
  });
});

describe("auto-restore setting", () => {
  it("restores at launch when enabled", async () => {
    autoRestore = true;
    await mount();
    expect(titles()).toEqual(["api", "web"]);
    expect(api.persistence.pendingRestore).toBeNull();
  });

  it("turning it on later does not wipe tabs the user already has open", async () => {
    await mount();
    await act(async () => api.tabsState.newTab());
    const liveIds = api.tabsState.tabs.map((t) => t.id);

    autoRestore = true;
    await mount();

    expect(api.tabsState.tabs.map((t) => t.id).slice(0, 2)).toEqual(liveIds);
    expect(titles().slice(2)).toEqual(["api", "web"]);
  });
});
