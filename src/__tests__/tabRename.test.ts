// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import type { TerminalTab } from "../types/terminal";

function makeTab(id: string, title: string): TerminalTab {
  return {
    id,
    title,
    status: "connected",
    panes: [{ id: `${id}-p1`, status: "connected" }],
    activePaneId: `${id}-p1`,
    splitDirection: "none",
    layout: { kind: "pane", paneId: `${id}-p1` },
  };
}

describe("TabBar rename input", () => {
  it("lets Space through (no tab navigation) and saves a title containing spaces", async () => {
    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { TabBar } = await import("../components/TabBar");

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const selected: string[] = [];
    const renamed: Array<[string, string]> = [];

    await React.act(async () => {
      root.render(
        React.createElement(TabBar, {
          tabs: [makeTab("t1", "Terminal 1"), makeTab("t2", "Terminal 2")],
          activeTabId: "t1",
          onSelectTab: (id: string) => selected.push(id),
          onCloseTab: () => {},
          onNewTab: () => {},
          onRenameTab: (id: string, title: string) => renamed.push([id, title]),
        })
      );
    });

    const title = container.querySelector(".tab-title") as HTMLElement;
    await React.act(async () => {
      title.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    const input = container.querySelector("input[aria-label='Tab title']") as HTMLInputElement;
    expect(input).not.toBeNull();

    // The tab's own handler preventDefault()s Space; the input must not let
    // that happen or the browser never inserts the space.
    const space = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
    await React.act(async () => {
      input.dispatchEvent(space);
    });
    expect(space.defaultPrevented).toBe(false);
    expect(selected).toEqual([]);

    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await React.act(async () => {
      setValue.call(input, "My build tab");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await React.act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(renamed).toEqual([["t1", "My build tab"]]);

    root.unmount();
    container.remove();
  });
});
