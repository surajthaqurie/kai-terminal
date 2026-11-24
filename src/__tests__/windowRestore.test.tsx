// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { useTabs } from "../hooks/useTabs";
import { useSessionPersistence } from "../hooks/useSessionPersistence";
import { useExtraWindowLayout } from "../hooks/useExtraWindowLayout";
import { LAYOUT_KEY } from "../services/tabFactory";
import { EXTRA_WINDOWS_KEY, type WindowRestoreSeed } from "../services/windowLayouts";

/**
 * FUNC-07: the windows open when the app quit come back at the next launch; a window closed on
 * purpose while others stayed open does not.
 */
const closeHandlers = new Set<() => void>();
vi.mock("../services/appWindow", () => ({
  closeAppWindow: vi.fn(async () => false),
  onIndividualWindowClose: vi.fn((fn: () => void) => {
    closeHandlers.add(fn);
    return () => closeHandlers.delete(fn);
  }),
}));
const openTerminalWindow = vi.fn(async (_opts: { seed?: unknown }) => "term-9");
vi.mock("../services/terminalWindows", async (orig) => ({
  ...(await orig<typeof import("../services/terminalWindows")>()),
  openTerminalWindow: (opts: { seed?: unknown }) => openTerminalWindow(opts),
}));
let liveLabels: string[] | null = ["main"];
let thisLabel = "main";
vi.mock("../services/windowLayouts", async (orig) => ({
  ...(await orig<typeof import("../services/windowLayouts")>()),
  liveTerminalWindowLabels: async () => liveLabels,
  currentWindowLabel: async () => thisLabel,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Api {
  tabsState: ReturnType<typeof useTabs>;
  persistence: ReturnType<typeof useSessionPersistence>;
}
let api: Api;
let secondary = false;
let seed: WindowRestoreSeed | null = null;

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
    activeTabId: tabsState.activeTabId,
    autoRestoreSession: false,
    enabled: !secondary,
  });
  useExtraWindowLayout({
    tabs: tabsState.tabs,
    activeTabId: tabsState.activeTabId,
    enabled: secondary,
  });
  api = { tabsState, persistence };
  return null;
}

let root: ReturnType<typeof createRoot>;
const mount = async () => {
  await act(async () => root.render(<Harness />));
  await act(async () => void (await new Promise((r) => setTimeout(r, 0)))); // live labels resolve
};
const quiet = () => act(async () => void (await new Promise((r) => setTimeout(r, 650))));
const extras = () => JSON.parse(localStorage.getItem(EXTRA_WINDOWS_KEY) ?? "null");
const titles = () => api.tabsState.tabs.map((t) => t.title);

function saveExtras(entries: Record<string, { titles: string[]; savedAt: number }>) {
  const all: Record<string, unknown> = {};
  for (const [label, e] of Object.entries(entries))
    all[label] = { tabs: e.titles.map((title) => ({ title })), activeIndex: 0, savedAt: e.savedAt };
  localStorage.setItem(EXTRA_WINDOWS_KEY, JSON.stringify(all));
}

beforeEach(() => {
  localStorage.clear();
  closeHandlers.clear();
  openTerminalWindow.mockClear();
  liveLabels = ["main"];
  thisLabel = "main";
  secondary = false;
  seed = null;
  root = createRoot(document.createElement("div"));
});
afterEach(() => act(() => root.unmount()));

describe("the first window offers every window of the last session", () => {
  beforeEach(() => {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify([{ title: "main-a" }, { title: "main-b" }]));
    saveExtras({
      "term-2": { titles: ["w2"], savedAt: 100 },
      "term-3": { titles: ["w3-a", "w3-b"], savedAt: 200 },
    });
  });

  it("counts the tabs and windows in the offer", async () => {
    await mount();
    expect(api.persistence.offerTabCount).toBe(5);
    expect(api.persistence.offerWindowCount).toBe(3);
  });

  it("Load session restores this window's tabs and reopens the others with theirs", async () => {
    await mount();
    await act(async () => api.persistence.restoreSession());
    expect(titles()).toEqual(["main-a", "main-b"]);
    const seeds = openTerminalWindow.mock.calls.map(([o]) => o.seed as WindowRestoreSeed);
    expect(seeds.map((s) => s.restore.tabs.map((t) => t.title))).toEqual([
      ["w3-a", "w3-b"],
      ["w2"],
    ]);
    expect(extras()).toBeNull(); // offered once: not offered again next launch
    expect(api.persistence.offerTabCount).toBe(0);
  });

  it("Start fresh reopens nothing and forgets the previous windows", async () => {
    await mount();
    await act(async () => api.persistence.dismissRestore());
    expect(openTerminalWindow).not.toHaveBeenCalled();
    expect(extras()).toBeNull();
  });

  it("ignoring the offer and working keeps it loadable now, but stale windows are not kept for later", async () => {
    await mount();
    await act(async () => api.tabsState.newTab());
    await quiet();
    expect(extras()).toBeNull();
    expect(api.persistence.offerWindowCount).toBe(3); // still loadable from memory this session
  });

  it("a window that is open right now is not offered (the main page was only reloaded)", async () => {
    liveLabels = ["main", "term-3"];
    await mount();
    expect(api.persistence.offerWindowCount).toBe(2); // this window + term-2
    expect(Object.keys(extras())).toContain("term-3");
  });
});

it("without its own saved tabs, the first window takes the newest saved window and reopens the rest", async () => {
  saveExtras({
    "term-2": { titles: ["older"], savedAt: 100 },
    "term-5": { titles: ["newest"], savedAt: 500 },
  });
  await mount();
  expect(api.persistence.offerWindowCount).toBe(2);
  await act(async () => api.persistence.restoreSession());
  expect(titles()).toEqual(["newest"]);
  const seeds = openTerminalWindow.mock.calls.map(([o]) => o.seed as WindowRestoreSeed);
  expect(seeds.map((s) => s.restore.tabs[0].title)).toEqual(["older"]);
});

it("the main window closed while others stay open forgets its tabs and stops saving them", async () => {
  await mount();
  await act(async () => api.tabsState.newTab());
  await quiet();
  expect(localStorage.getItem(LAYOUT_KEY)).not.toBeNull();
  await act(async () => closeHandlers.forEach((fn) => fn()));
  expect(localStorage.getItem(LAYOUT_KEY)).toBeNull();
  await act(async () => api.tabsState.newTab());
  await quiet();
  expect(localStorage.getItem(LAYOUT_KEY)).toBeNull();
});

describe("another window", () => {
  beforeEach(() => {
    secondary = true;
    thisLabel = "term-4";
    liveLabels = ["main", "term-4"];
  });

  it("saves its tabs under its label", async () => {
    await mount();
    await act(async () => api.tabsState.newTab());
    await quiet();
    expect(extras()["term-4"].tabs).toHaveLength(2);
    expect(localStorage.getItem(LAYOUT_KEY)).toBeNull(); // never the main window's key
  });

  it("closed on purpose while others stay open, it forgets its entry and saves no more", async () => {
    await mount();
    await quiet();
    expect(extras()?.["term-4"]).toBeDefined();
    await act(async () => closeHandlers.forEach((fn) => fn()));
    expect(extras()).toBeNull();
    await act(async () => api.tabsState.newTab());
    await quiet();
    expect(extras()).toBeNull();
  });

  it("opened from a saved window, it starts with those tabs and that tab in front", async () => {
    seed = {
      restore: { tabs: [{ title: "x" }, { title: "y" }, { title: "z" }], activeIndex: 2 },
    };
    await mount();
    expect(titles()).toEqual(["x", "y", "z"]);
    expect(api.tabsState.activeTabId).toBe(api.tabsState.tabs[2].id);
  });
});
