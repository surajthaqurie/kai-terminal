// @vitest-environment jsdom
/**
 * Terminal-shell feedback from the UI/UX audit (H4, H5, M9, M12): tab session
 * status, split-pane focus and labels, search result counts, and the
 * platform-aware launch failure tip.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { SessionStatus, TerminalTab, UserSettings } from "../types/terminal";

/** TerminalView stand-in that counts mounts: a remount would restart the shell. */
const mounts: Record<string, number> = {};
vi.mock("../components/TerminalView", () => ({
  TerminalView: (props: { sessionId: string }) => {
    useEffect(() => {
      mounts[props.sessionId] = (mounts[props.sessionId] ?? 0) + 1;
    }, [props.sessionId]);
    return createElement("div", { "data-terminal": props.sessionId });
  },
}));

import { TabBar } from "../components/TabBar";
import { TabPanes, folderName } from "../components/TabPanes";
import { SearchBar, searchResultLabel } from "../components/SearchBar";
import { launchFailureTip } from "../components/launchFailure";
import { DEFAULT_SETTINGS } from "../services/settingsService";

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function render(el: React.ReactElement) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(el));
  return host;
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  for (const k of Object.keys(mounts)) delete mounts[k];
});

function tab(id: string, status: SessionStatus, paneIds: string[] = [`${id}-p1`]): TerminalTab {
  return {
    id,
    title: `Terminal ${id}`,
    status,
    panes: paneIds.map((p, i) => ({ id: p, status, cwd: `/home/me/proj${i}` })),
    activePaneId: paneIds[0],
    splitDirection: paneIds.length > 1 ? "vertical" : "none",
    layout:
      paneIds.length > 1
        ? {
            kind: "split",
            id: "s1",
            direction: "vertical",
            ratio: 0.5,
            first: { kind: "pane", paneId: paneIds[0] },
            second: { kind: "pane", paneId: paneIds[1] },
          }
        : { kind: "pane", paneId: paneIds[0] },
  } as TerminalTab;
}

describe("tab session status", () => {
  it("gives every state its own icon shape and class, not only a colour", () => {
    const states: SessionStatus[] = ["connecting", "connected", "disconnected", "error"];
    const el = render(
      createElement(TabBar, {
        tabs: states.map((s) => tab(s, s)),
        activeTabId: "connected",
        onSelectTab: () => {},
        onCloseTab: () => {},
        onNewTab: () => {},
      })
    );
    const icons = states.map((s) => {
      const item = el.querySelector(`[data-tab-id="${s}"]`)!;
      expect(item.classList.contains(`status-${s}`)).toBe(true);
      expect(item.getAttribute("aria-label")).toBe(`Terminal ${s}, ${s}`);
      return item.querySelector("svg.tab-icon")!.getAttribute("class");
    });
    // Four different lucide glyphs (the class list names the icon).
    expect(new Set(icons).size).toBe(4);
    expect(el.querySelector('[data-tab-id="connecting"] .tab-icon-spin')).not.toBeNull();
  });

  it("names the tab colours instead of reading out a hex code", () => {
    const el = render(
      createElement(TabBar, {
        tabs: [tab("t1", "connected")],
        activeTabId: "t1",
        onSelectTab: () => {},
        onCloseTab: () => {},
        onNewTab: () => {},
        onSetTabColor: () => {},
      })
    );
    act(() => {
      el.querySelector('[data-tab-id="t1"]')!.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true })
      );
    });
    const labels = [...el.querySelectorAll(".tab-color-swatch")].map((s) =>
      s.getAttribute("aria-label")
    );
    expect(labels).toContain("Tab color Blue");
    expect(labels.some((l) => /#[0-9a-f]{6}/i.test(l ?? ""))).toBe(false);
  });
});

describe("split panes", () => {
  const props = (t: TerminalTab) => ({
    tab: t,
    isActive: true,
    selectedShell: undefined,
    shells: [],
    skipShellProfile: false,
    settings: DEFAULT_SETTINGS as UserSettings,
    terminalRefs: { current: {} },
    onFocusPane: () => {},
    onCodeModeChange: () => {},
    onCwdResolved: () => {},
    onExit: () => {},
    onStatusChange: () => {},
    onResizeSplit: () => {},
  });

  it("a single pane gets no split marker and no label", () => {
    const el = render(createElement(TabPanes, props(tab("t1", "connected"))));
    expect(el.querySelector(".pane-grid")!.getAttribute("data-split")).toBe("false");
    expect(el.querySelector(".pane-label")).toBeNull();
  });

  it("a split shows no folder heading, but names each pane for screen readers", () => {
    const el = render(createElement(TabPanes, props(tab("t1", "connected", ["a", "b"]))));
    expect(el.querySelector(".pane-grid")!.getAttribute("data-split")).toBe("true");
    expect(el.querySelector(".pane-label")).toBeNull();
    const names = [...el.querySelectorAll(".pane-grid-pane")].map((n) =>
      n.getAttribute("aria-label")
    );
    expect(names.length).toBe(2);
    expect(names.every((n) => n?.startsWith("proj"))).toBe(true);
    expect(el.querySelector(".active-pane")!.getAttribute("aria-label")).toContain("(active pane)");
  });

  it("splitting and unsplitting never remounts the existing terminal", () => {
    const one = tab("t1", "connected", ["a"]);
    const el = render(createElement(TabPanes, props(one)));
    act(() => root!.render(createElement(TabPanes, props(tab("t1", "connected", ["a", "b"])))));
    act(() => root!.render(createElement(TabPanes, props(one))));
    expect(el.querySelector('[data-terminal="a"]')).not.toBeNull();
    expect(mounts.a).toBe(1);
  });

  it("folderName handles both path separators", () => {
    expect(folderName("C:\\src\\kai")).toBe("kai");
    expect(folderName("/home/me/kai/")).toBe("kai");
    expect(folderName(undefined)).toBe("");
  });
});

describe("terminal search results", () => {
  it("formats counts from the search addon's result event", () => {
    expect(searchResultLabel(null)).toBe("");
    expect(searchResultLabel({ index: 0, count: 0 })).toBe("No results");
    expect(searchResultLabel({ index: 2, count: 17 })).toBe("3 of 17");
    expect(searchResultLabel({ index: -1, count: 1000 })).toBe("1000+ matches");
  });

  it("shows the count once a term is typed and disables stepping when nothing matched", () => {
    const onSearch = vi.fn();
    const el = render(
      createElement(SearchBar, {
        onSearch,
        onSearchNext: () => {},
        onSearchPrevious: () => {},
        onClose: () => {},
        results: { index: 0, count: 0 },
      })
    );
    const input = el.querySelector("input")!;
    // Before typing: no stale label.
    expect(el.querySelector(".search-count")!.textContent).toBe("");
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "zzz");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(onSearch).toHaveBeenCalledWith("zzz", expect.any(Object));
    const count = el.querySelector(".search-count")!;
    expect(count.textContent).toBe("No results");
    expect(count.getAttribute("role")).toBe("status");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    const next = el.querySelector('[aria-label="Find next match"]') as HTMLButtonElement;
    expect(next.disabled).toBe(true);
  });
});

describe("launch failure", () => {
  it("gives a tip that fits the operating system", () => {
    expect(launchFailureTip("windows")).toMatch(/PowerShell/);
    expect(launchFailureTip("mac")).toMatch(/zshrc/);
    expect(launchFailureTip("mac")).not.toMatch(/PowerShell/);
    expect(launchFailureTip("linux")).toMatch(/bashrc/);
    expect(launchFailureTip("linux")).not.toMatch(/PowerShell/);
  });
});
