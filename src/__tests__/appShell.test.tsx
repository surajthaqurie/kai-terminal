// @vitest-environment jsdom
/**
 * Characterization tests for the <App /> shell: tabs, panes, shortcuts,
 * crash-loop guards, session restore, Code Mode / git footer, music and
 * update wiring. They pin the user-visible behaviour so the component can be
 * decomposed into hooks/components without changing what the app does.
 *
 * Real: App, TabBar, Toolbar, StatusBar, UpdateBanner and all state logic.
 * Stubbed: TerminalView (xterm cannot run in jsdom) and the lazy modals.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { registry } from "./helpers/appStubs";

vi.mock("../components/TerminalView", async () => {
  const s = await import("./helpers/appStubs");
  return { TerminalView: s.TerminalViewStub };
});
vi.mock("../components/CommandPalette", async () => {
  const s = await import("./helpers/appStubs");
  return { CommandPalette: s.makeModalStub("palette", "isOpen") };
});
vi.mock("../components/SettingsModal", async () => {
  const s = await import("./helpers/appStubs");
  return { SettingsModal: s.makeModalStub("settings", "isOpen") };
});
vi.mock("../components/AiCliPanel", async () => {
  const s = await import("./helpers/appStubs");
  return { AiCliPanel: s.makeModalStub("aiCli", "isOpen") };
});
vi.mock("../components/DiagnosticsModal", async () => {
  const s = await import("./helpers/appStubs");
  return { DiagnosticsModal: s.makeModalStub("diagnostics", "isOpen") };
});
vi.mock("../components/WorkspaceModal", async () => {
  const s = await import("./helpers/appStubs");
  return { WorkspaceModal: s.makeModalStub("workspace", "isOpen") };
});
vi.mock("../components/GitStatusModal", async () => {
  const s = await import("./helpers/appStubs");
  return { GitStatusModal: s.makeModalStub("gitStatus", null) };
});
vi.mock("../components/GitChangesModal", async () => {
  const s = await import("./helpers/appStubs");
  return { GitChangesModal: s.makeModalStub("gitChanges", null) };
});
vi.mock("../components/MusicPlayer/MusicPanel", async () => {
  const s = await import("./helpers/appStubs");
  return { MusicPanel: s.makeModalStub("music", "open") };
});

vi.mock("../services/projectService", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/projectService")>();
  const s = await import("./helpers/appStubs");
  return {
    ...actual,
    getActiveProjectState: vi.fn(async () => ({ ...s.registry.activeProject })),
    getGitInfoCached: vi.fn(async () => ({
      branch: "main",
      dirty: true,
      ahead_behind: null,
      repo_root: "/work/proj",
      error: null,
    })),
    runGitAction: vi.fn(async () => "## main"),
  };
});
vi.mock("../services/updateService", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/updateService")>();
  return {
    ...actual,
    getAppVersion: vi.fn(async () => "1.0.0"),
    shouldAutoCheck: () => false,
    checkForUpdates: vi.fn(async () => ({
      updateAvailable: true,
      currentVersion: "1.0.0",
      latestVersion: "2.0.0",
      releaseUrl: "https://example.test/release",
      releaseName: "v2",
      releaseAuthor: null,
      selectedAsset: null,
      selectedAssetLabel: null,
      error: null,
    })),
  };
});
vi.mock("../services/cacheJanitor", () => ({ runCacheJanitor: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, cb: (event: unknown) => void) => {
    const s = await import("./helpers/appStubs");
    s.registry.listeners[name] = cb;
    return () => {
      delete s.registry.listeners[name];
    };
  }),
}));

import App from "../App";
import { MAX_PANES_PER_TAB } from "../services/paneLayout";
import { SettingsService } from "../services/settingsService";
import { runCacheJanitor } from "../services/cacheJanitor";
import { checkForUpdates } from "../services/updateService";
import { runGitAction } from "../services/projectService";

const LAYOUT_KEY = "terminal_tab_layout_v1";

let container: HTMLDivElement;
let root: Root;

/** Let lazy chunks, promise chains and zero-delay timers settle. */
async function flush() {
  await act(async () => {
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0);
    else await new Promise((r) => setTimeout(r, 0));
    await Promise.resolve();
  });
}

async function mount() {
  await act(async () => {
    root.render(<App />);
  });
  await flush();
}

interface Mods {
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
}

async function press(code: string, key: string, mods: Mods = { ctrl: true }) {
  await act(async () => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        code,
        key,
        ctrlKey: !!mods.ctrl,
        altKey: !!mods.alt,
        shiftKey: !!mods.shift,
        bubbles: true,
        cancelable: true,
      })
    );
  });
}

const newTabKey = () => press("KeyT", "t", { ctrl: true });
const splitVerticalKey = () => press("KeyV", "v", { ctrl: true, alt: true });
const splitHorizontalKey = () => press("KeyS", "s", { ctrl: true, alt: true });

const tabEls = () => [...container.querySelectorAll<HTMLElement>('[role="tab"]')];
const tabTitles = () => tabEls().map((el) => el.getAttribute("aria-label")!.split(", ")[0]);
const activeTitle = () =>
  container.querySelector(".tab-item.active")?.getAttribute("aria-label")?.split(", ")[0];
const terminalsIn = (tabIndex: number) =>
  [
    ...container
      .querySelectorAll(".tab-content")
      [tabIndex].querySelectorAll<HTMLElement>('[data-testid="terminal"]'),
  ].map((el) => el.dataset.session!);
const paneId = (tabIndex: number, paneIndex = 0) => terminalsIn(tabIndex)[paneIndex];
const activeTabContent = () =>
  [...container.querySelectorAll<HTMLElement>(".tab-content")].find(
    (el) => el.style.display === "block"
  )!;
const banner = (label: string) => container.querySelector(`[aria-label="${label}"]`);
const modal = (name: string) => registry.modals[name]!;
const statusDirLabel = () =>
  container.querySelector('[aria-label^="Current directory:"]')?.getAttribute("aria-label");
const persistedTitles = () =>
  (JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? "[]") as Array<{ title: string }>).map(
    (t) => t.title
  );

async function resolveCwd(id: string, cwd: string) {
  await act(async () => {
    registry.panes.get(id)!.onCwdResolved(cwd);
  });
  await flush();
}

async function exitPane(id: string, code = 0) {
  await act(async () => {
    registry.panes.get(id)!.onExit(code);
  });
  await flush();
}

async function runAction(id: string) {
  const action = (modal("palette").actions as Array<{ id: string; perform: () => unknown }>).find(
    (a) => a.id === id
  )!;
  await act(async () => {
    await action.perform();
  });
  await flush();
}

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  registry.reset();
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  vi.useRealTimers();
  act(() => {
    root.unmount();
  });
  container.remove();
  document.body.innerHTML = "";
  document.head.innerHTML = "";
  document.documentElement.removeAttribute("data-theme");
});

describe("App shell: tabs", () => {
  it("starts with one connecting tab, one visible pane", async () => {
    await mount();
    expect(tabTitles()).toEqual(["Terminal 1"]);
    expect(activeTitle()).toBe("Terminal 1");
    expect(terminalsIn(0)).toHaveLength(1);
    expect(registry.panes.get(paneId(0))!.visible).toBe(true);
    expect(tabEls()[0].getAttribute("aria-label")).toBe("Terminal 1, connecting");
  });

  it("Ctrl+T opens a new tab, activates it, and hides the previous tab's content", async () => {
    await mount();
    await newTabKey();
    expect(tabTitles()).toEqual(["Terminal 1", "Terminal 2"]);
    expect(activeTitle()).toBe("Terminal 2");
    expect(registry.panes.get(paneId(0))!.visible).toBe(false);
    expect(registry.panes.get(paneId(1))!.visible).toBe(true);
  });

  it("numbers new tabs without reusing a live title", async () => {
    await mount();
    await newTabKey();
    await newTabKey();
    expect(tabTitles()).toEqual(["Terminal 1", "Terminal 2", "Terminal 3"]);
    // Close the middle one, then open another: "Terminal 3" is taken.
    await act(async () => {
      container.querySelector<HTMLElement>('[aria-label="Close Terminal 2"]')!.click();
    });
    expect(tabTitles()).toEqual(["Terminal 1", "Terminal 3"]);
    await newTabKey();
    expect(tabTitles()).toEqual(["Terminal 1", "Terminal 3", "Terminal 4"]);
  });

  it("the toolbar's + button opens a tab too", async () => {
    await mount();
    await act(async () => {
      container.querySelector<HTMLElement>('[aria-label="New terminal tab"]')!.click();
    });
    expect(tabTitles()).toHaveLength(2);
  });

  it("closing the active tab activates the last remaining one; the last tab never closes in browser mode", async () => {
    await mount();
    await newTabKey();
    await press("KeyW", "w", { ctrl: true, shift: true });
    expect(tabTitles()).toEqual(["Terminal 1"]);
    expect(activeTitle()).toBe("Terminal 1");
    await press("KeyW", "w", { ctrl: true, shift: true });
    await flush();
    expect(tabTitles()).toEqual(["Terminal 1"]);
  });

  it("next/prev tab shortcuts wrap around", async () => {
    await mount();
    await newTabKey();
    await newTabKey();
    expect(activeTitle()).toBe("Terminal 3");
    await press("BracketRight", "]", { ctrl: true, shift: true });
    expect(activeTitle()).toBe("Terminal 1");
    await press("BracketLeft", "[", { ctrl: true, shift: true });
    expect(activeTitle()).toBe("Terminal 3");
  });

  it("Ctrl+1..9 jump to a tab; Ctrl+9 jumps to the last", async () => {
    await mount();
    await newTabKey();
    await newTabKey();
    await press("Digit1", "1");
    expect(activeTitle()).toBe("Terminal 1");
    await press("Digit2", "2");
    expect(activeTitle()).toBe("Terminal 2");
    await press("Digit9", "9");
    expect(activeTitle()).toBe("Terminal 3");
    // Out of range index is ignored.
    await press("Digit7", "7");
    expect(activeTitle()).toBe("Terminal 3");
  });

  it("renames a tab through the palette action and the rename dialog", async () => {
    await mount();
    await runAction("rename-session");
    const input = container.querySelector<HTMLInputElement>("#rename-session-input")!;
    expect(input.value).toBe("Terminal 1");
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "  Build  ");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      container
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(tabTitles()).toEqual(["Build"]);
    expect(container.querySelector("#rename-session-input")).toBeNull();
  });

  it("reorders a tab from its context menu and persists the order", async () => {
    await mount();
    await newTabKey();
    await act(async () => {
      tabEls()[0].dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 })
      );
    });
    const moveRight = [...container.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (b) => b.textContent === "Move right"
    )!;
    await act(async () => moveRight.click());
    expect(tabTitles()).toEqual(["Terminal 2", "Terminal 1"]);
    expect(persistedTitles()).toEqual(["Terminal 2", "Terminal 1"]);
  });

  it("sets a tab color from its context menu", async () => {
    await mount();
    await act(async () => {
      tabEls()[0].dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 })
      );
    });
    await act(async () => {
      container.querySelector<HTMLElement>('[aria-label^="Tab color "]')!.click();
    });
    expect(tabEls()[0].classList.contains("has-color")).toBe(true);
  });
});

describe("App shell: panes", () => {
  it("Ctrl+Alt+V splits side by side with a draggable divider; Ctrl+Alt+W closes the pane", async () => {
    await mount();
    await splitVerticalKey();
    expect(terminalsIn(0)).toHaveLength(2);
    const dividers = container.querySelectorAll(".pane-divider");
    expect(dividers).toHaveLength(1);
    expect(dividers[0].classList.contains("pane-divider-vertical")).toBe(true);
    await press("KeyW", "w", { ctrl: true, alt: true });
    expect(terminalsIn(0)).toHaveLength(1);
    expect(container.querySelectorAll(".pane-divider")).toHaveLength(0);
  });

  it("Ctrl+Alt+S splits stacked; the new pane inherits the active pane's cwd", async () => {
    await mount();
    await resolveCwd(paneId(0), "/work/proj");
    await splitHorizontalKey();
    const [first, second] = terminalsIn(0);
    expect(container.querySelector(".pane-divider-horizontal")).not.toBeNull();
    expect(registry.panes.get(first)!.cwd).toBe("/work/proj");
    expect(registry.panes.get(second)!.cwd).toBe("/work/proj");
  });

  it("existing panes keep their ids (no remount) when a split is added", async () => {
    await mount();
    const original = paneId(0);
    await splitVerticalKey();
    expect(terminalsIn(0)).toContain(original);
  });

  it("clicking a pane makes it active", async () => {
    await mount();
    await splitVerticalKey();
    const panes = [...activeTabContent().querySelectorAll<HTMLElement>(".pane-grid-pane")];
    expect(panes.filter((p) => p.classList.contains("active-pane"))).toHaveLength(1);
    const inactive = panes.find((p) => !p.classList.contains("active-pane"))!;
    await act(async () => {
      inactive.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    });
    expect(inactive.classList.contains("active-pane")).toBe(true);
  });

  it("Ctrl+Alt+] cycles the active pane", async () => {
    await mount();
    await splitVerticalKey();
    const panes = () => [...activeTabContent().querySelectorAll<HTMLElement>(".pane-grid-pane")];
    const before = panes().findIndex((p) => p.classList.contains("active-pane"));
    await press("BracketRight", "]", { ctrl: true, alt: true });
    const after = panes().findIndex((p) => p.classList.contains("active-pane"));
    expect(after).not.toBe(before);
  });

  it("refuses splits past the pane limit and explains why, then auto-dismisses the notice", async () => {
    vi.useFakeTimers();
    await mount();
    for (let i = 0; i < MAX_PANES_PER_TAB + 2; i++) {
      await (i % 2 ? splitHorizontalKey() : splitVerticalKey());
    }
    expect(terminalsIn(0).length).toBeLessThanOrEqual(MAX_PANES_PER_TAB);
    expect(banner("Pane split unavailable")).not.toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(banner("Pane split unavailable")).toBeNull();
  });

  it("a divider drag resizes the split ratio", async () => {
    await mount();
    await splitVerticalKey();
    const container0 = activeTabContent().querySelector<HTMLElement>(".pane-grid")!;
    container0.getBoundingClientRect = () =>
      ({
        width: 1000,
        height: 500,
        left: 0,
        top: 0,
        right: 1000,
        bottom: 500,
        x: 0,
        y: 0,
      }) as DOMRect;
    const divider = container.querySelector<HTMLElement>(".pane-divider")!;
    const leftBefore = divider.style.left;
    await act(async () => {
      divider.dispatchEvent(
        new MouseEvent("pointerdown", { bubbles: true, cancelable: true, clientX: 500 })
      );
    });
    await act(async () => {
      window.dispatchEvent(new MouseEvent("pointermove", { clientX: 600 }));
    });
    await act(async () => {
      window.dispatchEvent(new MouseEvent("pointerup"));
    });
    expect(container.querySelector<HTMLElement>(".pane-divider")!.style.left).not.toBe(leftBefore);
    expect(
      parseFloat(container.querySelector<HTMLElement>(".pane-divider")!.style.left)
    ).toBeCloseTo(60, 0);
  });
});

describe("App shell: shell exit and crash-loop guards", () => {
  it("exiting one pane of a split closes only that pane", async () => {
    await mount();
    await splitVerticalKey();
    const [first, second] = terminalsIn(0);
    await exitPane(second, 0);
    expect(terminalsIn(0)).toEqual([first]);
  });

  it("exiting a tab's only pane closes the tab and activates its left neighbour", async () => {
    await mount();
    await newTabKey();
    await newTabKey();
    await exitPane(paneId(2), 0);
    expect(tabTitles()).toEqual(["Terminal 1", "Terminal 2"]);
    expect(activeTitle()).toBe("Terminal 2");
  });

  it("a stale repeat exit for an already-removed pane is ignored", async () => {
    await mount();
    await newTabKey();
    const gone = paneId(1);
    const handler = registry.panes.get(gone)!.onExit;
    await exitPane(gone, 0);
    await act(async () => handler(0));
    expect(tabTitles()).toEqual(["Terminal 1"]);
  });

  it("a clean exit of the last pane recycles a fresh tab in browser mode", async () => {
    await mount();
    const old = paneId(0);
    await exitPane(old, 0);
    expect(tabTitles()).toEqual(["Terminal 1"]);
    expect(paneId(0)).not.toBe(old);
    expect(banner("Shell keeps exiting")).toBeNull();
  });

  it("an instant failure of the only shell parks the tab with an actionable banner", async () => {
    await mount();
    await exitPane(paneId(0), 1);
    const alert = banner("Shell keeps exiting");
    expect(alert).not.toBeNull();
    expect(alert!.textContent).toContain("Shell exited right after opening");
    expect(tabEls()[0].getAttribute("aria-label")).toBe("Terminal 1, error");
    expect(modal("diagnostics").lastError).toContain("Shell exited right after opening");
  });

  it("three failed exits within 10 s park the third tab; Retry respawns that pane in place", async () => {
    await mount();
    await newTabKey();
    await newTabKey();
    await newTabKey();
    const ids = [paneId(3), paneId(2), paneId(1)];
    const parked = ids[2];
    for (const id of ids) await exitPane(id, 1);
    const alert = banner("Shell keeps exiting");
    expect(alert).not.toBeNull();
    expect(alert!.textContent).toContain("3 times in 10 s");
    expect(tabTitles()).toEqual(["Terminal 1", "Terminal 2"]);
    expect(tabEls()[1].getAttribute("aria-label")).toBe("Terminal 2, error");
    expect(registry.panes.get(parked)!.resetKey).toBe(0);

    const retry = [...alert!.querySelectorAll("button")].find((b) => b.textContent === "Retry")!;
    await act(async () => retry.click());
    expect(banner("Shell keeps exiting")).toBeNull();
    expect(registry.panes.get(parked)!.resetKey).toBe(1);
    expect(tabEls()[1].getAttribute("aria-label")).toBe("Terminal 2, connecting");
    expect(modal("diagnostics").lastError).toBeNull();
  });

  it("the fault banner's Open Settings button opens preferences and Dismiss hides it", async () => {
    await mount();
    await exitPane(paneId(0), 1);
    const buttons = [...banner("Shell keeps exiting")!.querySelectorAll("button")];
    await act(async () => buttons.find((b) => b.textContent === "Open Settings")!.click());
    expect(modal("settings").isOpen).toBe(true);
    await act(async () => buttons.find((b) => b.textContent === "Dismiss")!.click());
    expect(banner("Shell keeps exiting")).toBeNull();
  });

  it("pane status reports from the terminal flow into the tab strip and diagnostics", async () => {
    await mount();
    const id = paneId(0);
    await act(async () => registry.panes.get(id)!.onSessionStatusChange("connected"));
    expect(tabEls()[0].getAttribute("aria-label")).toBe("Terminal 1, connected");
    await act(async () => registry.panes.get(id)!.onSessionStatusChange("error", "spawn failed"));
    expect(tabEls()[0].getAttribute("aria-label")).toBe("Terminal 1, error");
    expect(modal("diagnostics").lastError).toBe("spawn failed");
  });
});

describe("App shell: session persistence", () => {
  const previous = [
    { title: "Alpha", cwd: "/a" },
    { title: "Beta", cwd: "/b" },
  ];

  it("persists tab titles on change", async () => {
    await mount();
    await newTabKey();
    expect(persistedTitles()).toEqual(["Terminal 1", "Terminal 2"]);
  });

  it("offers a previous session via a banner without overwriting it", async () => {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(previous));
    await mount();
    const bar = banner("Restore previous session")!;
    expect(bar.textContent).toContain("Previous session found (2 tabs)");
    expect(tabTitles()).toEqual(["Terminal 1"]);
    expect(persistedTitles()).toEqual(["Alpha", "Beta"]);
  });

  it("Load session replaces the starter tab with the saved tabs", async () => {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(previous));
    await mount();
    const load = [...banner("Restore previous session")!.querySelectorAll("button")].find(
      (b) => b.textContent === "Load session"
    )!;
    await act(async () => load.click());
    expect(tabTitles()).toEqual(["Alpha", "Beta"]);
    expect(activeTitle()).toBe("Alpha");
    expect(banner("Restore previous session")).toBeNull();
    expect(registry.panes.get(paneId(0))!.cwd).toBe("/a");
  });

  it("Start fresh dismisses the offer and resumes persisting the live tabs", async () => {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(previous));
    await mount();
    const fresh = [...banner("Restore previous session")!.querySelectorAll("button")].find(
      (b) => b.textContent === "Start fresh"
    )!;
    await act(async () => fresh.click());
    expect(banner("Restore previous session")).toBeNull();
    expect(tabTitles()).toEqual(["Terminal 1"]);
    expect(persistedTitles()).toEqual(["Terminal 1"]);
  });

  it("persists split structure (pane cwd + nested layout) for multi-pane tabs", async () => {
    await mount();
    await resolveCwd(paneId(0), "/work/proj");
    await splitVerticalKey();
    const saved = JSON.parse(localStorage.getItem(LAYOUT_KEY)!);
    expect(saved[0].panes).toHaveLength(2);
    expect(saved[0].layout).toBeTruthy();
  });

  it("loads a named workspace: tabs replaced, first cwd adopted", async () => {
    await mount();
    await act(async () => {
      modal("workspace").onLoadWorkspace({
        id: "w1",
        name: "W",
        createdAt: 1,
        updatedAt: 1,
        tabs: [
          { title: "One", cwd: "/w/one" },
          { title: "Two", cwd: "/w/two" },
        ],
      });
    });
    expect(tabTitles()).toEqual(["One", "Two"]);
    expect(statusDirLabel()).toContain("/w/one");
    expect(modal("workspace").currentTabs).toHaveLength(2);
  });

  it("ignores an empty workspace", async () => {
    await mount();
    await act(async () => {
      modal("workspace").onLoadWorkspace({
        id: "w",
        name: "W",
        createdAt: 1,
        updatedAt: 1,
        tabs: [],
      });
    });
    expect(tabTitles()).toEqual(["Terminal 1"]);
  });
});

describe("App shell: working directory, git and Code Mode footer", () => {
  it("shows the resolved cwd and its git branch in the footer", async () => {
    await mount();
    expect(statusDirLabel()).toBeUndefined();
    await resolveCwd(paneId(0), "/work/proj");
    expect(statusDirLabel()).toContain("/work/proj");
    expect(
      container.querySelector('[aria-label^="Git branch main"]')!.getAttribute("aria-label")
    ).toContain("Git branch main, uncommitted changes");
  });

  it("is a no-op when the same directory is reported in another textual form", async () => {
    await mount();
    await resolveCwd(paneId(0), "C:\\work\\proj");
    const before = localStorage.getItem(LAYOUT_KEY);
    await resolveCwd(paneId(0), "C:/work/proj");
    expect(localStorage.getItem(LAYOUT_KEY)).toBe(before);
  });

  it("each tab tracks its own directory", async () => {
    await mount();
    await resolveCwd(paneId(0), "/work/one");
    await newTabKey();
    await resolveCwd(paneId(1), "/work/two");
    expect(statusDirLabel()).toContain("/work/two");
    await press("Digit1", "1");
    await flush();
    expect(statusDirLabel()).toContain("/work/one");
  });

  it("opens git status and the changes review for the active directory", async () => {
    await mount();
    await resolveCwd(paneId(0), "/work/proj");
    await runAction("git-status");
    expect(runGitAction).toHaveBeenCalledWith("/work/proj", "status");
    expect(modal("gitStatus").dir).toBe("/work/proj");
    expect(modal("gitStatus").output).toBe("## main");
    await act(async () => modal("gitStatus").onClose());
    expect(container.querySelector('[data-testid="gitStatus"]')).toBeNull();

    await runAction("review-changes");
    expect(modal("gitChanges").dir).toBe("/work/proj");
    await act(async () => modal("gitChanges").onClose());
    expect(container.querySelector('[data-testid="gitChanges"]')).toBeNull();
  });

  it("Ctrl+Shift+G opens the changes review", async () => {
    await mount();
    await resolveCwd(paneId(0), "/work/proj");
    await press("KeyG", "g", { ctrl: true, shift: true });
    expect(modal("gitChanges").dir).toBe("/work/proj");
  });

  it("reports a missing directory instead of opening the review", async () => {
    await mount();
    await runAction("review-changes");
    expect(container.querySelector('[data-testid="gitChanges"]')).toBeNull();
    expect(modal("diagnostics").lastError).toBe(
      "No project directory set. Enter or open a directory first."
    );
  });

  it("Code Mode footer is sticky: pane directory reports never flip the pill", async () => {
    registry.activeProject = { mode: "code", path: "/work/proj" };
    await mount();
    await resolveCwd(paneId(0), "/work/proj/src");
    expect(container.querySelector('[aria-label="Code Mode active"]')).not.toBeNull();
    // The pane moving outside the project (or reporting a transient dir)
    // must NOT auto-flip the pill — only clearing the project does that.
    await resolveCwd(paneId(0), "/elsewhere");
    expect(container.querySelector('[aria-label="Code Mode active"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Terminal mode"]')).toBeNull();
  });

  it("clearing the active project drops to Terminal mode on the next focus sync", async () => {
    registry.activeProject = { mode: "code", path: "/work/proj" };
    await mount();
    await resolveCwd(paneId(0), "/work/proj");
    expect(container.querySelector('[aria-label="Code Mode active"]')).not.toBeNull();
    registry.activeProject = { mode: "terminal", path: null };
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await flush();
    expect(container.querySelector('[aria-label="Terminal mode"]')).not.toBeNull();
  });

  it("a second launch (`kai-open-project`) opens a tab for a new path and focuses an existing one", async () => {
    await mount();
    expect(registry.listeners["kai-open-project"]).toBeTypeOf("function");
    const open = (path: string) =>
      act(async () => {
        registry.listeners["kai-open-project"]({ payload: { path } });
      });
    await open("/proj/x");
    expect(tabTitles()).toEqual(["Terminal 1", "Terminal 2"]);
    expect(registry.panes.get(paneId(1))!.cwd).toBe("/proj/x");
    await press("Digit1", "1");
    expect(activeTitle()).toBe("Terminal 1");
    await open("/proj/x");
    expect(tabTitles()).toEqual(["Terminal 1", "Terminal 2"]);
    expect(activeTitle()).toBe("Terminal 2");
    await open("   ");
    expect(tabTitles()).toHaveLength(2);
  });

  it("the footer refresh button re-probes git for the active pane", async () => {
    const { getGitInfoCached } = await import("../services/projectService");
    await mount();
    await resolveCwd(paneId(0), "/work/proj");
    vi.mocked(getGitInfoCached).mockClear();
    await act(async () => {
      container.querySelector<HTMLElement>('[aria-label="Refresh git status"]')!.click();
    });
    await flush();
    expect(getGitInfoCached).toHaveBeenCalledWith("/work/proj");
  });
});

describe("App shell: new-tab focus handoff and auto-repeat guard", () => {
  /** Let the focus helper's rAF (+ bounded retry) run. */
  async function settleFocus() {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });
    await flush();
  }

  it("a repeated (held) new-tab keydown never opens extra tabs", async () => {
    await mount();
    await press("KeyT", "t", { ctrl: true, shift: true });
    expect(tabTitles()).toHaveLength(2);
    // OS auto-repeat re-fires the same keydown while the combo is held.
    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          code: "KeyT",
          key: "t",
          ctrlKey: true,
          shiftKey: true,
          repeat: true,
          bubbles: true,
          cancelable: true,
        })
      );
    });
    await flush();
    expect(tabTitles()).toHaveLength(2);
  });

  it("a held tab-cycle shortcut keeps cycling while one-shot actions do not repeat", async () => {
    await mount();
    await newTabKey();
    await newTabKey();
    expect(activeTitle()).toBe("Terminal 3");
    const prevTab = (repeat: boolean) =>
      act(async () => {
        window.dispatchEvent(
          new KeyboardEvent("keydown", {
            code: "BracketLeft",
            key: "{",
            ctrlKey: true,
            shiftKey: true,
            repeat,
            bubbles: true,
            cancelable: true,
          })
        );
      });
    await prevTab(false);
    expect(activeTitle()).toBe("Terminal 2");
    await prevTab(true);
    expect(activeTitle()).toBe("Terminal 1");
  });

  it("opening a tab via the + button focuses the new terminal", async () => {
    await mount();
    registry.refCalls.length = 0;
    await act(async () => {
      (container.querySelector(".tab-add-btn") as HTMLButtonElement).click();
    });
    await settleFocus();
    expect(tabTitles()).toHaveLength(2);
    // The NEW pane's terminal took focus, so Space/Enter the user types next
    // reach the shell instead of re-activating the focused + button (which
    // used to open yet another tab).
    expect(registry.refCalls).toContain(`${paneId(1)}:focus`);
  });

  it("a session exit hands keyboard focus to the now-active terminal", async () => {
    await mount();
    await press("KeyT", "t", { ctrl: true, shift: true });
    await flush();
    registry.refCalls.length = 0;
    await exitPane(paneId(1), 0);
    await settleFocus();
    expect(tabTitles()).toHaveLength(1);
    expect(registry.refCalls).toContain(`${paneId(0)}:focus`);
  });
});

describe("App shell: settings, themes and terminal actions", () => {
  it("Ctrl+Shift+, toggles preferences", async () => {
    await mount();
    expect(modal("settings").isOpen).toBe(false);
    await press("Comma", ",", { ctrl: true, shift: true });
    expect(modal("settings").isOpen).toBe(true);
    await press("Comma", ",", { ctrl: true, shift: true });
    expect(modal("settings").isOpen).toBe(false);
  });

  it("Ctrl+Shift+P toggles the command palette and exposes every action", async () => {
    await mount();
    await press("KeyP", "p", { ctrl: true, shift: true });
    expect(modal("palette").isOpen).toBe(true);
    const actions = modal("palette").actions as Array<{ id: string; shortcut?: string }>;
    expect(actions.map((a) => a.id)).toEqual([
      "new-tab",
      "next-tab",
      "prev-tab",
      "next-pane",
      "manage-workspaces",
      "split-horizontal",
      "split-vertical",
      "close-pane",
      "toggle-music",
      "rename-session",
      "open-editor",
      "git-status",
      "review-changes",
      "check-updates",
      "close-tab",
      "search-terminal",
      "clear-terminal",
      "reset-terminal-modes",
      "ai-cli",
      "diagnostics",
      "open-settings",
    ]);
    expect(actions.find((a) => a.id === "new-tab")!.shortcut).toBe("Ctrl+Shift+T");
    expect(actions.find((a) => a.id === "review-changes")!.shortcut).toBe("Ctrl+Shift+G");
  });

  it("palette actions drive tabs, panes and modals", async () => {
    await mount();
    await runAction("new-tab");
    expect(tabTitles()).toHaveLength(2);
    await runAction("prev-tab");
    expect(activeTitle()).toBe("Terminal 1");
    await runAction("next-tab");
    expect(activeTitle()).toBe("Terminal 2");
    await runAction("split-vertical");
    expect(terminalsIn(1)).toHaveLength(2);
    await runAction("close-pane");
    expect(terminalsIn(1)).toHaveLength(1);
    await runAction("manage-workspaces");
    expect(modal("workspace").isOpen).toBe(true);
    await runAction("diagnostics");
    expect(modal("diagnostics").isOpen).toBe(true);
    await runAction("open-settings");
    expect(modal("settings").isOpen).toBe(true);
    await runAction("close-tab");
    expect(tabTitles()).toEqual(["Terminal 1"]);
  });

  it("search / clear / reset-modes target the active pane's terminal", async () => {
    await mount();
    await newTabKey();
    const active = paneId(1);
    registry.refCalls.length = 0;
    await press("KeyF", "f", { ctrl: true, shift: true });
    await runAction("clear-terminal");
    await runAction("reset-terminal-modes");
    // New-tab now also focuses the new terminal (rAF-scheduled), so focus
    // entries are expected noise around the asserted imperative calls.
    expect(registry.refCalls.filter((c) => !c.endsWith(":focus"))).toEqual([
      `${active}:toggleSearch`,
      `${active}:clear`,
      `${active}:resetModes`,
    ]);
  });

  it("toolbar paste writes the clipboard into the active terminal", async () => {
    Object.defineProperty(navigator, "clipboard", {
      value: { readText: vi.fn(async () => "echo hi") },
      configurable: true,
    });
    await mount();
    const paste = container.querySelector<HTMLElement>('[aria-label="Paste"], [title^="Paste"]');
    expect(paste).not.toBeNull();
    registry.refCalls.length = 0;
    await act(async () => paste!.click());
    await flush();
    expect(registry.refCalls).toContain(`${paneId(0)}:paste:echo hi`);
  });

  it("Ctrl+= / Ctrl+- / Ctrl+0 zoom the terminal font for the session", async () => {
    await mount();
    const size = () => registry.panes.get(paneId(0))!.settings.fontSize as number;
    const base = size();
    await press("Equal", "=", { ctrl: true });
    expect(size()).toBe(base + 1);
    await press("Minus", "-", { ctrl: true });
    await press("Minus", "-", { ctrl: true });
    expect(size()).toBe(base - 1);
    await press("Digit0", "0", { ctrl: true });
    expect(size()).toBe(base);
  });

  it("applies the theme to the document, body, color-scheme and theme-color meta", async () => {
    const meta = document.createElement("meta");
    meta.setAttribute("name", "theme-color");
    meta.setAttribute("content", "#000000");
    document.head.appendChild(meta);
    await mount();
    expect(document.documentElement.getAttribute("data-theme")).toBe("kali");
    await act(async () => {
      modal("settings").onSaveSettings({ ...modal("settings").settings, theme: "solarized-light" });
    });
    expect(document.documentElement.getAttribute("data-theme")).toBe("solarized-light");
    expect(document.body.getAttribute("data-theme")).toBe("solarized-light");
    expect(document.documentElement.style.colorScheme).toBe("light");
    expect(meta.getAttribute("content")).toBe(
      SettingsService.getThemeCanvasColor("solarized-light")
    );
    expect(container.querySelector(".app-layout")!.getAttribute("data-theme")).toBe(
      "solarized-light"
    );
  });

  it("switching the default shell in settings selects it for new sessions", async () => {
    await mount();
    expect(modal("settings").shells.map((s: { id: string }) => s.id)).toEqual(["bash", "zsh"]);
    await act(async () => {
      modal("settings").onSaveSettings({ ...modal("settings").settings, defaultShellId: "zsh" });
    });
    await newTabKey();
    expect(registry.panes.get(paneId(1))!.selectedShell.id).toBe("zsh");
  });

  it("a custom shell path overrides the profile for all panes", async () => {
    await mount();
    await act(async () => {
      modal("settings").onSaveSettings({
        ...modal("settings").settings,
        customShellPath: "/opt/fish",
      });
    });
    const shell = registry.panes.get(paneId(0))!.selectedShell;
    expect(shell.path).toBe("/opt/fish");
    expect(shell.name).toContain("(custom)");
  });
});

describe("App shell: AI CLI, music and updates", () => {
  it("opens the AI providers panel for the active pane's directory and launches a tab from it", async () => {
    await mount();
    await resolveCwd(paneId(0), "/work/proj");
    await runAction("ai-cli");
    expect(modal("aiCli").isOpen).toBe(true);
    expect(modal("aiCli").projectDir).toBe("/work/proj");
    await act(async () => modal("aiCli").onLaunchInTerminal("/x/y"));
    expect(tabTitles()).toHaveLength(2);
    expect(registry.panes.get(paneId(1))!.cwd).toBe("/x/y");
    expect(modal("aiCli").isOpen).toBe(false);
  });

  it("the music toggle mounts the player, enables it in settings and relays playback state to the footer", async () => {
    await mount();
    expect(registry.modals.music).toBeUndefined();
    await press("KeyM", "m", { ctrl: true, alt: true });
    expect(modal("music").open).toBe(true);
    expect(modal("settings").settings.showMusicPlayer).toBe(true);

    await act(async () => {
      modal("music").onTrackChange({ title: "Lo-fi", videoId: "abc123" }, true);
    });
    expect(container.querySelector(".music-mini-title")!.textContent).toBe("Lo-fi");
    expect(container.querySelector('[aria-label="Pause music"]')).not.toBeNull();
    await act(async () => modal("music").onProgressChange(42));
    expect(container.querySelector<HTMLElement>(".music-mini-progress i")!.style.width).toBe("42%");
    await act(async () => modal("music").onMutedChange(true));
    expect(container.querySelector('[aria-label="Unmute music"]')).not.toBeNull();

    await press("KeyM", "m", { ctrl: true, alt: true });
    expect(modal("music").open).toBe(false);
  });

  it("music transport shortcuts and footer buttons dispatch window events", async () => {
    await mount();
    const seen: string[] = [];
    for (const name of ["kai-music-toggle-play", "kai-music-next", "kai-music-mute"]) {
      window.addEventListener(name, () => seen.push(name));
    }
    await press("Space", " ", { ctrl: true, alt: true });
    await press("KeyN", "n", { ctrl: true, alt: true });
    await press("KeyU", "u", { ctrl: true, alt: true });
    expect(seen).toEqual(["kai-music-toggle-play", "kai-music-next", "kai-music-mute"]);
  });

  it("reports the app version and runs the version-gated cache sweep on startup", async () => {
    await mount();
    expect(runCacheJanitor).toHaveBeenCalledWith("1.0.0");
    expect(modal("settings").appVersion).toBe("1.0.0");
  });

  it("a manual update check shows the banner; Later hides it for now, Dismiss remembers the version", async () => {
    await mount();
    await runAction("check-updates");
    expect(checkForUpdates).toHaveBeenCalledWith("1.0.0");
    const bannerEl = container.querySelector(".update-banner")!;
    expect(bannerEl.textContent).toContain("2.0.0");
    expect(modal("settings").updateInfo.latestVersion).toBe("2.0.0");

    const later = [...bannerEl.querySelectorAll("button")].find((b) => b.textContent === "Later")!;
    await act(async () => later.click());
    expect(container.querySelector(".update-banner")).toBeNull();

    await runAction("check-updates");
    expect(container.querySelector(".update-banner")).not.toBeNull();
    const dismiss = [...container.querySelectorAll(".update-banner button")].find(
      (b) => b.textContent === "Dismiss" || b.getAttribute("aria-label")?.startsWith("Dismiss")
    ) as HTMLElement | undefined;
    expect(dismiss).toBeDefined();
    await act(async () => dismiss!.click());
    expect(container.querySelector(".update-banner")).toBeNull();
  });

  it("opening the editor outside the desktop app surfaces the error in diagnostics", async () => {
    await mount();
    await runAction("open-editor");
    expect(modal("diagnostics").lastError).toBe(
      "Editor launch is only available inside the desktop app."
    );
  });
});

describe("App shell: render isolation", () => {
  const totalRenders = () => [...registry.renders.values()].reduce((a, b) => a + b, 0);

  it("footer-only updates (music progress, playback state) never re-render terminals", async () => {
    await mount();
    await newTabKey();
    await press("KeyM", "m", { ctrl: true, alt: true });
    await flush();
    const before = totalRenders();
    for (let progress = 1; progress <= 20; progress++) {
      await act(async () => modal("music").onProgressChange(progress));
    }
    await act(async () => modal("music").onTrackChange({ title: "Song", videoId: "abc" }, true));
    await act(async () => modal("music").onMutedChange(true));
    expect(totalRenders()).toBe(before);
  });

  it("switching tabs re-renders only the two tabs whose visibility changed", async () => {
    await mount();
    await newTabKey();
    await newTabKey();
    const [a, b, c] = [paneId(0), paneId(1), paneId(2)];
    const before = new Map(registry.renders);
    await press("Digit1", "1");
    const rendered = (id: string) => registry.renders.get(id)! - before.get(id)!;
    expect(rendered(a)).toBeGreaterThan(0);
    expect(rendered(c)).toBeGreaterThan(0);
    expect(rendered(b)).toBe(0);
  });

  it("clicking an already-active pane does not re-render anything", async () => {
    await mount();
    await splitVerticalKey();
    const active = activeTabContent().querySelector<HTMLElement>(".active-pane")!;
    const before = totalRenders();
    for (let i = 0; i < 3; i++) {
      await act(async () => {
        active.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
        active.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
    }
    expect(totalRenders()).toBe(before);
  });
});

describe("App shell: window refit", () => {
  it("refits every pane of the active tab on focus, again after 150 ms and 500 ms", async () => {
    vi.useFakeTimers();
    await mount();
    await splitVerticalKey();
    const ids = terminalsIn(0);
    registry.refCalls.length = 0;
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    const count = () => registry.refCalls.filter((c) => c.endsWith(":refit")).length;
    expect(count()).toBe(ids.length);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });
    expect(count()).toBe(ids.length * 2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(350);
    });
    expect(count()).toBe(ids.length * 3);
  });
});
