// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSessionExit } from "../hooks/useSessionExit";
import { useTabs } from "../hooks/useTabs";
import { tabAfterClose } from "../services/tabSelection";

/** FUNC-03: closing the active tab jumped to the last tab, but a shell exiting went left. */
vi.mock("../services/appWindow", () => ({ closeAppWindow: vi.fn(async () => false) }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("tabAfterClose", () => {
  const ids = (...n: string[]) => n.map((id) => ({ id }));
  it("picks the tab that takes the closed tab's place", () => {
    expect(tabAfterClose(ids("a", "b", "c", "d"), "b")).toBe("c");
    expect(tabAfterClose(ids("a", "b", "c", "d"), "a")).toBe("b");
  });
  it("picks the new last tab when the last one is closed", () => {
    expect(tabAfterClose(ids("a", "b", "c"), "c")).toBe("b");
  });
  it("has nothing to pick when no other tab remains, and tolerates an unknown id", () => {
    expect(tabAfterClose(ids("a"), "a")).toBeUndefined();
    expect(tabAfterClose(ids("a", "b"), "zzz")).toBe("b");
  });
});

interface Api {
  tabsState: ReturnType<typeof useTabs>;
  exit: ReturnType<typeof useSessionExit>;
}
let api: Api;
function Harness() {
  const tabsState = useTabs({ effectiveShellPath: undefined, setLastError: vi.fn() });
  const exit = useSessionExit({
    tabs: tabsState.tabs,
    setTabs: tabsState.setTabs,
    setActiveTabId: tabsState.setActiveTabId,
    tabsRef: tabsState.tabsRef,
    activeTabIdRef: tabsState.activeTabIdRef,
    shellsRef: { current: [] },
    selectedShellIdRef: { current: "" },
    setLastError: vi.fn(),
  });
  api = { tabsState, exit };
  return null;
}

let unmount: () => void;
beforeEach(async () => {
  localStorage.clear();
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Harness />));
  await act(async () => {
    api.tabsState.newTab();
    api.tabsState.newTab();
    api.tabsState.newTab();
  });
  unmount = () => act(() => root.unmount());
});
afterEach(() => unmount());

describe("the active tab is closed in the middle of four", () => {
  const activate = async (index: number) =>
    act(async () => api.tabsState.setActiveTabId(api.tabsState.tabs[index].id));

  it("with the close button: the tab that took its place is shown", async () => {
    const [, b, c] = api.tabsState.tabs;
    await activate(1);
    await act(async () => api.tabsState.closeTab(b.id));
    expect(api.tabsState.activeTabId).toBe(c.id);
  });

  it("when its shell exits: the same tab is shown", async () => {
    const [, b, c] = api.tabsState.tabs;
    await activate(1);
    await act(async () => api.exit.handleSessionExit(b.id, b.panes[0].id, 0));
    expect(api.tabsState.activeTabId).toBe(c.id);
  });
});
