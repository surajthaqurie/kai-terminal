// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { TerminalTab } from "../types/terminal";

function makeTabs(): TerminalTab[] {
  return [
    {
      id: "t1",
      title: "one",
      status: "connected",
      panes: [{ id: "p1", status: "connected" }],
      activePaneId: "p1",
      splitDirection: "none",
    },
  ];
}

describe("TabBar hold-to-pick-up drag", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    document.body.classList.remove("tab-dragging");
    document.body.innerHTML = "";
  });

  async function renderBar(onMoveTabToIndex = vi.fn()) {
    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { TabBar } = await import("../components/TabBar");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await React.act(async () => {
      root.render(
        React.createElement(TabBar, {
          tabs: makeTabs(),
          activeTabId: "t1",
          onSelectTab: () => {},
          onCloseTab: () => {},
          onNewTab: () => {},
          onMoveTabToIndex,
        })
      );
    });
    return { React, root, container, onMoveTabToIndex };
  }

  function pressDown(el: Element, x = 100, y = 10) {
    // jsdom has no PointerEvent constructor: a MouseEvent carrying the
    // "pointerdown" type still trips React's top-level pointer listener.
    el.dispatchEvent(
      new MouseEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: y,
        button: 0,
      })
    );
  }

  function release(el: Element, x = 100, y = 10) {
    // Window-level listener: dispatch on window so it fires regardless of target.
    window.dispatchEvent(
      new MouseEvent("pointerup", {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: y,
        button: 0,
      })
    );
    void el;
  }

  it("arms a drag (move cursor) after holding still, without moving", async () => {
    const { React, root, container, onMoveTabToIndex } = await renderBar();
    const tabEl = container.querySelector('[data-tab-id="t1"]') as HTMLElement;
    expect(tabEl).not.toBeNull();

    await React.act(async () => {
      pressDown(tabEl);
    });
    // Not yet: hold time hasn't elapsed.
    expect(document.body.classList.contains("tab-dragging")).toBe(false);

    await React.act(async () => {
      vi.advanceTimersByTime(500);
    });
    expect(document.body.classList.contains("tab-dragging")).toBe(true);
    expect(tabEl.classList.contains("dragging")).toBe(true);

    // Release without moving: single tab, no reorder, drag state cleared.
    await React.act(async () => {
      release(tabEl);
    });
    expect(document.body.classList.contains("tab-dragging")).toBe(false);
    expect(onMoveTabToIndex).not.toHaveBeenCalled();

    root.unmount();
    container.remove();
  });

  it("stays a plain press when released before the hold time", async () => {
    const { React, root, container } = await renderBar();
    const tabEl = container.querySelector('[data-tab-id="t1"]') as HTMLElement;

    await React.act(async () => {
      pressDown(tabEl);
      vi.advanceTimersByTime(200);
      release(tabEl);
      // Let any pending timer fire after release: must not arm post-release.
      vi.advanceTimersByTime(1000);
    });
    expect(document.body.classList.contains("tab-dragging")).toBe(false);

    root.unmount();
    container.remove();
  });

  it("never drags from movement alone: moving before the hold time cancels the pick-up", async () => {
    const { React, root, container, onMoveTabToIndex } = await renderBar();
    const tabEl = container.querySelector('[data-tab-id="t1"]') as HTMLElement;

    await React.act(async () => {
      pressDown(tabEl);
      // A clear drag-like move well past the press slop, before 500 ms.
      window.dispatchEvent(
        new MouseEvent("pointermove", { bubbles: true, clientX: 160, clientY: 10 })
      );
      expect(document.body.classList.contains("tab-dragging")).toBe(false);
      // The hold timer must not lift the tab afterwards either.
      vi.advanceTimersByTime(1000);
    });
    expect(document.body.classList.contains("tab-dragging")).toBe(false);
    expect(tabEl.classList.contains("dragging")).toBe(false);

    await React.act(async () => {
      release(tabEl, 160);
    });
    expect(onMoveTabToIndex).not.toHaveBeenCalled();

    root.unmount();
    container.remove();
  });
});
