// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { useTabs } from "../hooks/useTabs";
import { useSessionExit } from "../hooks/useSessionExit";
import { usePaneCwd } from "../hooks/usePaneCwd";
import {
  LAYOUT_KEY,
  createDefaultTab,
  deriveTabStatus,
  loadPersistedLayout,
  savePersistedLayout,
} from "../services/tabFactory";
import { closeAppWindow } from "../services/appWindow";
import type { ShellProfile, TerminalPane } from "../types/terminal";

vi.mock("../services/appWindow", () => ({ closeAppWindow: vi.fn(async () => false) }));
vi.mock("../services/projectService", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/projectService")>()),
  getGitInfoCached: vi.fn(async () => ({
    branch: null,
    dirty: false,
    ahead_behind: null,
    repo_root: null,
    error: null,
  })),
  recordRecentProject: vi.fn(),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Api {
  tabsState: ReturnType<typeof useTabs>;
  exit: ReturnType<typeof useSessionExit>;
  reportCwd: ReturnType<typeof usePaneCwd>;
}
let api: Api;
/** Detected shells and the default one, as the harness reports them to `useSessionExit`. */
const shells = { current: [] as ShellProfile[] };
const defaultShellId = { current: "" };

function Harness() {
  const tabsState = useTabs({ effectiveShellPath: undefined, setLastError: vi.fn() });
  const exit = useSessionExit({
    tabs: tabsState.tabs,
    setTabs: tabsState.setTabs,
    setActiveTabId: tabsState.setActiveTabId,
    tabsRef: tabsState.tabsRef,
    activeTabIdRef: tabsState.activeTabIdRef,
    shellsRef: shells,
    selectedShellIdRef: defaultShellId,
    setLastError: vi.fn(),
  });
  const reportCwd = usePaneCwd({
    tabsRef: tabsState.tabsRef,
    activeTabIdRef: tabsState.activeTabIdRef,
    setTabs: tabsState.setTabs,
    applyGitInfo: vi.fn(),
  });
  api = { tabsState, exit, reportCwd };
  return null;
}

let unmount: () => void;
beforeEach(async () => {
  shells.current = [];
  defaultShellId.current = "";
  vi.mocked(closeAppWindow).mockClear();
  localStorage.clear();
  const host = document.createElement("div");
  const root = createRoot(host);
  await act(async () => root.render(<Harness />));
  unmount = () => act(() => root.unmount());
});
afterEach(() => unmount());

const paneOf = (tabIndex: number, paneIndex = 0) => api.tabsState.tabs[tabIndex].panes[paneIndex];

describe("shells exiting together (tab and pane removal)", () => {
  it("removes BOTH tabs when two shells die before React re-renders", async () => {
    await act(async () => {
      api.tabsState.newTab();
      api.tabsState.newTab();
    });
    const [a, b, c] = api.tabsState.tabs;
    expect(api.tabsState.tabs).toHaveLength(3);

    // Both pty-exit events are handled in the same tick, as in `wsl --shutdown`.
    await act(async () => {
      api.exit.handleSessionExit(a.id, a.panes[0].id, 0);
      api.exit.handleSessionExit(b.id, b.panes[0].id, 0);
    });

    expect(api.tabsState.tabs.map((t) => t.id)).toEqual([c.id]);
  });

  it("removes both panes' exits from one split tab without leaving a dead pane", async () => {
    await act(async () => api.tabsState.newTab());
    await act(async () => api.tabsState.splitPane("vertical"));
    await act(async () => api.tabsState.splitPane("vertical"));
    const tab = api.tabsState.tabs[api.tabsState.tabs.length - 1];
    expect(tab.panes).toHaveLength(3);

    await act(async () => {
      api.exit.handleSessionExit(tab.id, tab.panes[0].id, 0);
      api.exit.handleSessionExit(tab.id, tab.panes[1].id, 0);
    });

    const after = api.tabsState.tabs.find((t) => t.id === tab.id)!;
    expect(after.panes.map((p) => p.id)).toEqual([tab.panes[2].id]);
  });

  it("closeTab twice in a row closes two tabs instead of resurrecting one", async () => {
    await act(async () => {
      api.tabsState.newTab();
      api.tabsState.newTab();
    });
    const [a, b, c] = api.tabsState.tabs;
    await act(async () => {
      api.tabsState.closeTab(a.id);
      api.tabsState.closeTab(b.id);
    });
    expect(api.tabsState.tabs.map((t) => t.id)).toEqual([c.id]);
  });
});

describe("tab status is derived from all panes", () => {
  const pane = (status: TerminalPane["status"], errorMessage?: string): TerminalPane => ({
    id: Math.random().toString(36),
    status,
    errorMessage,
  });

  it("ranks error > connecting > connected > disconnected", () => {
    expect(deriveTabStatus([pane("connected"), pane("error", "boom")])).toEqual({
      status: "error",
      errorMessage: "boom",
    });
    expect(deriveTabStatus([pane("connected"), pane("connecting")]).status).toBe("connecting");
    expect(deriveTabStatus([pane("disconnected"), pane("connected")]).status).toBe("connected");
    expect(deriveTabStatus([pane("disconnected")]).status).toBe("disconnected");
  });

  it("an errored split keeps the tab in error when its sibling reconnects", async () => {
    await act(async () => api.tabsState.splitPane("vertical"));
    const tab = api.tabsState.tabs[0];
    const [p1, p2] = tab.panes;
    await act(async () => api.tabsState.setPaneStatus(tab.id, p1.id, "error", "spawn failed"));
    await act(async () => api.tabsState.setPaneStatus(tab.id, p2.id, "connected"));
    expect(api.tabsState.tabs[0].status).toBe("error");
    expect(api.tabsState.tabs[0].errorMessage).toBe("spawn failed");
  });
});

describe("focus and open-by-folder", () => {
  it("focusPane ignores a pane that no longer exists", async () => {
    const tab = api.tabsState.tabs[0];
    const before = tab.activePaneId;
    await act(async () => api.tabsState.focusPane(tab.id, "ghost-pane"));
    expect(api.tabsState.tabs[0].activePaneId).toBe(before);
  });

  it("opens the tab that is in the folder, not the first tab", async () => {
    await act(async () => api.tabsState.newTab({ cwd: "C:\\work\\a" }));
    await act(async () => api.tabsState.newTab({ cwd: "C:\\work\\b" }));
    const [, a, b] = api.tabsState.tabs;
    expect(api.tabsState.activeTabId).toBe(b.id);

    await act(async () => api.tabsState.openOrFocusDir("C:\\work\\a"));
    expect(api.tabsState.activeTabId).toBe(a.id);
    await act(async () => api.tabsState.openOrFocusDir("C:\\work\\b"));
    expect(api.tabsState.activeTabId).toBe(b.id);
  });

  it("opens a new tab for a folder no tab is in", async () => {
    await act(async () => api.tabsState.openOrFocusDir("C:\\somewhere\\else"));
    expect(api.tabsState.tabs).toHaveLength(2);
    expect(paneOf(1).cwd).toBe("C:\\somewhere\\else");
  });
});

describe("a new tab starts at the default (home) folder", () => {
  it("never inherits the folder of the tab it was opened from", async () => {
    await act(async () => api.reportCwd(api.tabsState.tabs[0].id, paneOf(0).id, "C:\\work\\x"));
    await act(async () => api.tabsState.newTab());
    const fresh = api.tabsState.tabs[1];
    expect(fresh.cwd).toBeUndefined();
    expect(fresh.panes[0].cwd).toBeUndefined();
  });

  it("a split inherits the focused pane's folder", async () => {
    await act(async () => api.reportCwd(api.tabsState.tabs[0].id, paneOf(0).id, "C:\\work\\x"));
    await act(async () => api.tabsState.splitPane("vertical"));
    expect(api.tabsState.tabs[0].panes).toHaveLength(2);
    expect(api.tabsState.tabs[0].panes[1].cwd).toBe("C:\\work\\x");
  });
});

describe("a pane's own directory is recorded", () => {
  it("records a pane's first report", async () => {
    await act(async () => api.tabsState.newTab());
    const tab = api.tabsState.tabs[1];
    expect(tab.panes[0].cwd).toBeUndefined();

    await act(async () => api.reportCwd(tab.id, tab.panes[0].id, "C:\\Users\\me"));
    expect(api.tabsState.tabs[1].panes[0].cwd).toBe("C:\\Users\\me");
    expect(api.tabsState.tabs[1].cwd).toBe("C:\\Users\\me");
  });

  it("does not rewrite state when the same directory is reported again in another form", async () => {
    await act(async () => api.reportCwd(api.tabsState.tabs[0].id, paneOf(0).id, "C:\\work\\x"));
    const before = api.tabsState.tabs;
    await act(async () => api.reportCwd(before[0].id, before[0].panes[0].id, "C:/work/x"));
    expect(api.tabsState.tabs).toBe(before);
  });
});

describe("saved layout of a tab whose split collapsed", () => {
  it("persists the surviving pane's shell and folder, not the closed pane's", () => {
    const tab = createDefaultTab("Terminal 1", "C:\\bash.exe", "C:\\old");
    // The survivor switched shell and moved; the tab-level fields were never updated.
    tab.panes = [{ ...tab.panes[0], shellPath: "C:\\zsh.exe", cwd: "C:\\new" }];
    savePersistedLayout([tab]);
    const saved = loadPersistedLayout()!;
    expect(saved[0].shellPath).toBe("C:\\zsh.exe");
    expect(saved[0].cwd).toBe("C:\\new");
  });

  it("still saves multi-pane tabs with their per-pane values", () => {
    const tab = createDefaultTab("Terminal 1", undefined, undefined, {
      title: "Terminal 1",
      panes: [
        { shellPath: "a", cwd: "C:\\a" },
        { shellPath: "b", cwd: "C:\\b" },
      ],
    });
    savePersistedLayout([tab]);
    const raw = JSON.parse(localStorage.getItem(LAYOUT_KEY)!);
    expect(raw[0].panes).toEqual([
      { shellPath: "a", cwd: "C:\\a" },
      { shellPath: "b", cwd: "C:\\b" },
    ]);
  });
});

describe("last-tab exit handling", () => {
  it("treats an unknown exit status as a failure: the tab is parked, the app is not quit", async () => {
    const tab = api.tabsState.tabs[0];
    await act(async () => api.exit.handleSessionExit(tab.id, tab.panes[0].id, undefined));
    expect(api.exit.loopFault?.paneId).toBe(tab.panes[0].id);
    expect(closeAppWindow).not.toHaveBeenCalled();
  });

  it("still quits on a clean exit of the last tab", async () => {
    const tab = api.tabsState.tabs[0];
    await act(async () => api.exit.handleSessionExit(tab.id, tab.panes[0].id, 0));
    expect(closeAppWindow).toHaveBeenCalledTimes(1);
    expect(api.exit.loopFault).toBeNull();
  });
});

describe("crash-loop banner lifecycle", () => {
  const park = async () => {
    const tab = api.tabsState.tabs[0];
    await act(async () => api.exit.handleSessionExit(tab.id, tab.panes[0].id, 1));
    expect(api.exit.loopFault).not.toBeNull();
    return tab;
  };

  it("goes away when the faulted tab is replaced by a restore or workspace load", async () => {
    await park();
    await act(async () => api.tabsState.setTabs([createDefaultTab("Terminal 1")]));
    expect(api.exit.loopFault).toBeNull();
  });

  it("goes away when the shell is fixed from the footer and the pane reconnects", async () => {
    const tab = await park();
    await act(async () =>
      api.tabsState.setPaneShell(tab.id, tab.panes[0].id, "C:\\good\\pwsh.exe")
    );
    await act(async () => api.tabsState.setPaneStatus(tab.id, tab.panes[0].id, "connected"));
    expect(api.exit.loopFault).toBeNull();
  });

  it("stays while the pane is still failing", async () => {
    await park();
    await act(async () => {});
    expect(api.exit.loopFault).not.toBeNull();
  });

  it("Retry falls back to the default shell when the pane's own shell is no longer detected", async () => {
    shells.current = [{ id: "ps", name: "PowerShell", path: "C:\\ps\\pwsh.exe", is_default: true }];
    defaultShellId.current = "ps";
    const tab = api.tabsState.tabs[0];
    await act(async () => api.tabsState.setPaneShell(tab.id, tab.panes[0].id, "C:\\gone\\sh.exe"));
    await act(async () => api.exit.handleSessionExit(tab.id, tab.panes[0].id, 1));
    await act(async () => api.exit.retryFaultedPane());
    expect(api.tabsState.tabs[0].panes[0].shellPath).toBe("C:\\ps\\pwsh.exe");
    expect(api.tabsState.tabs[0].shellPath).toBe("C:\\ps\\pwsh.exe");
  });

  it("Retry keeps a pane's own shell while that shell is still detected", async () => {
    shells.current = [
      { id: "ps", name: "PowerShell", path: "C:\\ps\\pwsh.exe", is_default: true },
      { id: "zsh", name: "Zsh", path: "C:\\zsh\\zsh.exe", is_default: false },
    ];
    defaultShellId.current = "ps";
    const tab = api.tabsState.tabs[0];
    await act(async () => api.tabsState.setPaneShell(tab.id, tab.panes[0].id, "C:\\zsh\\zsh.exe"));
    await act(async () => api.exit.handleSessionExit(tab.id, tab.panes[0].id, 1));
    const before = api.tabsState.tabs[0].panes[0].resetKey ?? 0;
    await act(async () => api.exit.retryFaultedPane());
    expect(api.tabsState.tabs[0].panes[0].shellPath).toBe("C:\\zsh\\zsh.exe");
    expect(api.tabsState.tabs[0].panes[0].resetKey).toBe(before + 1);
  });
});
