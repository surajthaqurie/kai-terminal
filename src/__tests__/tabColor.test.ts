// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import type { TerminalTab } from "../types/terminal";
import { TAB_COLOR_PRESETS } from "../components/TabBar";

function makeTab(id: string, title: string, color?: string): TerminalTab {
  return {
    id,
    title,
    color,
    status: "connected",
    panes: [{ id: `${id}-p1`, status: "connected" }],
    activePaneId: `${id}-p1`,
    splitDirection: "none",
    layout: { kind: "pane", paneId: `${id}-p1` },
  };
}

describe("TabBar tab color", () => {
  it("marks colored tabs so the active pill uses the custom color", async () => {
    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { TabBar } = await import("../components/TabBar");

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const noop = () => {};

    await React.act(async () => {
      root.render(
        React.createElement(TabBar, {
          tabs: [makeTab("t1", "Terminal 1", "#f38ba8"), makeTab("t2", "Terminal 2")],
          activeTabId: "t1",
          onSelectTab: noop,
          onCloseTab: noop,
          onNewTab: noop,
        })
      );
    });

    const items = Array.from(container.querySelectorAll(".tab-item"));
    expect(items).toHaveLength(2);
    // Colored tab: has-color class + --tab-color var (drives the active pill).
    expect(items[0]?.classList.contains("has-color")).toBe(true);
    expect((items[0] as HTMLElement).style.getPropertyValue("--tab-color")).toBe("#f38ba8");
    expect(container.querySelector(".tab-color-dot")).not.toBeNull();
    // Plain tab: no marker, no dot.
    expect(items[1]?.classList.contains("has-color")).toBe(false);

    root.unmount();
    container.remove();
  });

  it("offers every preset plus a clear-to-default swatch in the context menu", async () => {
    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { TabBar } = await import("../components/TabBar");

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const calls: Array<{ id: string; color: string | undefined }> = [];

    await React.act(async () => {
      root.render(
        React.createElement(TabBar, {
          tabs: [makeTab("t1", "Terminal 1")],
          activeTabId: "t1",
          onSelectTab: () => {},
          onCloseTab: () => {},
          onNewTab: () => {},
          onSetTabColor: (id: string, color: string | undefined) => {
            calls.push({ id, color });
          },
        })
      );
    });

    const tabEl = container.querySelector('[data-tab-id="t1"]') as HTMLElement;
    expect(tabEl).not.toBeNull();
    await React.act(async () => {
      tabEl.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    });
    const swatches = Array.from(container.querySelectorAll(".tab-color-swatch"));
    // 1 default swatch + every preset.
    expect(swatches).toHaveLength(TAB_COLOR_PRESETS.length + 1);

    // Pick the first preset.
    await React.act(async () => {
      (swatches[1] as HTMLElement).click();
    });
    expect(calls).toEqual([{ id: "t1", color: TAB_COLOR_PRESETS[0] }]);

    root.unmount();
    container.remove();
  });

  it("clearing a color calls back with undefined", async () => {
    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { TabBar } = await import("../components/TabBar");

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const calls: Array<{ id: string; color: string | undefined }> = [];

    await React.act(async () => {
      root.render(
        React.createElement(TabBar, {
          tabs: [makeTab("t1", "Terminal 1", "#f38ba8")],
          activeTabId: "t1",
          onSelectTab: () => {},
          onCloseTab: () => {},
          onNewTab: () => {},
          onSetTabColor: (id: string, color: string | undefined) => {
            calls.push({ id, color });
          },
        })
      );
    });

    const tabEl = container.querySelector('[data-tab-id="t1"]') as HTMLElement;
    await React.act(async () => {
      tabEl.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    });
    const swatches = Array.from(container.querySelectorAll(".tab-color-swatch"));
    await React.act(async () => {
      (swatches[0] as HTMLElement).click();
    });
    expect(calls).toEqual([{ id: "t1", color: undefined }]);

    root.unmount();
    container.remove();
  });
});
