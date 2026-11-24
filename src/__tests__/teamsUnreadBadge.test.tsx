// @vitest-environment jsdom
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TabBar } from "../components/TabBar";
import { useTeamsUnread } from "../hooks/useTeamsUnread";
import type { TerminalTab } from "../types/terminal";

let root: Root;
let host: HTMLElement;

const tab = (id: string, panes = [`${id}-p`]): TerminalTab =>
  ({
    id,
    title: `Terminal ${id}`,
    status: "connected",
    activePaneId: panes[0],
    splitDirection: "vertical",
    panes: panes.map((p) => ({ id: p, status: "connected" })),
  }) as unknown as TerminalTab;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

const renderBar = (unreadByTab: Record<string, number>) =>
  act(async () =>
    root.render(
      createElement(TabBar, {
        tabs: [tab("a"), tab("b")],
        activeTabId: "a",
        unreadByTab,
        onSelectTab: () => {},
        onCloseTab: () => {},
        onNewTab: () => {},
      })
    )
  );

describe("Teams unread badge on a tab", () => {
  it("shows the count on the tab running kai teams, and says so to screen readers", async () => {
    await renderBar({ b: 4 });
    const b = host.querySelector<HTMLElement>('[data-tab-id="b"]')!;
    expect(b.querySelector(".tab-unread-badge")?.textContent).toBe("4");
    expect(b.className).toContain("has-unread");
    expect(b.getAttribute("aria-label")).toContain("4 unread Teams messages");
    expect(host.querySelector('[data-tab-id="a"] .tab-unread-badge')).toBeNull();
  });

  it("caps the number at 99+ and goes away at 0", async () => {
    await renderBar({ b: 250 });
    expect(host.querySelector(".tab-unread-badge")?.textContent).toBe("99+");
    await renderBar({});
    expect(host.querySelector(".tab-unread-badge")).toBeNull();
  });
});

describe("useTeamsUnread", () => {
  it("adds up a tab's panes and drops a pane that reports 0", async () => {
    let api: ReturnType<typeof useTeamsUnread> | null = null;
    const tabs = [tab("t1", ["p1", "p2"]), tab("t2", ["p3"])];
    function Probe() {
      api = useTeamsUnread(tabs);
      return null;
    }
    await act(async () => root.render(createElement(Probe)));
    const current = () => api!;
    expect(current().unreadByTab).toEqual({});
    await act(async () => current().setPaneUnread("p1", 3));
    await act(async () => current().setPaneUnread("p2", 2));
    expect(current().unreadByTab).toEqual({ t1: 5 });
    await act(async () => current().setPaneUnread("p1", 0));
    expect(current().unreadByTab).toEqual({ t1: 2 });
    await act(async () => current().setPaneUnread("p2", 0));
    expect(current().unreadByTab).toEqual({});
  });
});
