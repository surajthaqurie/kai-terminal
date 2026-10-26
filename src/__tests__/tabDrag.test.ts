// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { TerminalTab } from "../types/terminal";

function makeTabs(n = 3): TerminalTab[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `t${i + 1}`,
    title: `tab ${i + 1}`,
    status: "connected" as const,
    panes: [{ id: `p${i + 1}`, status: "connected" as const }],
    activePaneId: `p${i + 1}`,
    splitDirection: "none" as const,
  }));
}

describe("TabBar drag-to-reorder", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    document.body.classList.remove("tab-dragging");
    document.body.innerHTML = "";
  });

  async function renderBar(onMoveTabToIndex = vi.fn(), pointerType = "mouse") {
    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { TabBar } = await import("../components/TabBar");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let currentType = pointerType;
    const fire = (target: Element | Window, type: string, x = 100, y = 10, button = 0) => {
      const ev = new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: y,
        button,
      });
      Object.defineProperty(ev, "pointerType", { value: currentType });
      Object.defineProperty(ev, "pointerId", { value: 1 });
      (target as EventTarget).dispatchEvent(ev);
    };
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
    return {
      React,
      root,
      container,
      onMoveTabToIndex,
      setPointerType: (t: string) => (currentType = t),
      fire,
    };
  }

  it("arms immediately for a mouse press dragged past the slop", async () => {
    const { React, root, container, onMoveTabToIndex, fire } = await renderBar();
    const tabEl = container.querySelector('[data-tab-id="t2"]') as HTMLElement;
    expect(tabEl).not.toBeNull();

    await React.act(async () => {
      fire(tabEl, "pointerdown", 100, 10);
      // A clear drag-like move well past the slop: drag arms without any hold.
      fire(window, "pointermove", 160, 10);
    });
    expect(document.body.classList.contains("tab-dragging")).toBe(true);
    expect(tabEl.classList.contains("dragging")).toBe(true);

    await React.act(async () => {
      fire(window, "pointerup", 160, 10);
    });
    // Dropped past tab 1's midpoint — jsdom has no layout, so the exact
    // index differs from a live browser; assert a real reorder commit happened.
    expect(onMoveTabToIndex).toHaveBeenCalledTimes(1);
    expect(onMoveTabToIndex.mock.calls[0][0]).toBe("t2");
    expect(document.body.classList.contains("tab-dragging")).toBe(false);

    root.unmount();
    container.remove();
  });

  it("keeps a small mouse wiggle a plain click (no reorder, no drag)", async () => {
    const { React, root, container, onMoveTabToIndex, fire } = await renderBar();
    const tabEl = container.querySelector('[data-tab-id="t2"]') as HTMLElement;

    await React.act(async () => {
      fire(tabEl, "pointerdown", 100, 10);
      fire(window, "pointermove", 104, 12); // within MOUSE_DRAG_SLOP_PX
      expect(document.body.classList.contains("tab-dragging")).toBe(false);
      fire(window, "pointerup", 104, 12);
      vi.advanceTimersByTime(1000); // no late hold pickup either
    });
    expect(document.body.classList.contains("tab-dragging")).toBe(false);
    expect(onMoveTabToIndex).not.toHaveBeenCalled();

    root.unmount();
    container.remove();
  });

  it("touch still uses hold-to-pick-up: a swipe before the hold never arming", async () => {
    const { React, root, container, onMoveTabToIndex, fire } = await renderBar(vi.fn(), "touch");
    const tabEl = container.querySelector('[data-tab-id="t2"]') as HTMLElement;

    await React.act(async () => {
      fire(tabEl, "pointerdown", 100, 10);
      fire(window, "pointermove", 160, 10);
      expect(document.body.classList.contains("tab-dragging")).toBe(false);
      vi.advanceTimersByTime(1000);
    });
    expect(tabEl.classList.contains("dragging")).toBe(false);
    expect(onMoveTabToIndex).not.toHaveBeenCalled();

    await React.act(async () => {
      fire(window, "pointerup", 160, 10);
      vi.advanceTimersByTime(1000);
    });
    expect(onMoveTabToIndex).not.toHaveBeenCalled();

    root.unmount();
    container.remove();
  });

  it("touch hold arms the drag after LONG_PRESS_MS held still", async () => {
    const { React, root, container, fire } = await renderBar(vi.fn(), "touch");
    const tabEl = container.querySelector('[data-tab-id="t1"]') as HTMLElement;
    expect(tabEl).not.toBeNull();

    await React.act(async () => {
      fire(tabEl, "pointerdown", 100, 10);
      expect(document.body.classList.contains("tab-dragging")).toBe(false);
      vi.advanceTimersByTime(500);
    });
    expect(document.body.classList.contains("tab-dragging")).toBe(true);
    expect(tabEl.classList.contains("dragging")).toBe(true);

    await React.act(async () => {
      fire(window, "pointerup", 100, 10);
    });
    expect(document.body.classList.contains("tab-dragging")).toBe(false);

    root.unmount();
    container.remove();
  });

  it("reorders forward the same way: drag t1 right onto t3's half", async () => {
    const { React, root, container, onMoveTabToIndex, fire } = await renderBar();
    const tabEl = container.querySelector('[data-tab-id="t1"]') as HTMLElement;

    await React.act(async () => {
      fire(tabEl, "pointerdown", 100, 10);
      fire(window, "pointermove", 400, 10); // arms + computes a drop index
      fire(window, "pointerup", 400, 10);
    });
    expect(onMoveTabToIndex).toHaveBeenCalled();
    expect(document.body.classList.contains("tab-dragging")).toBe(false);

    root.unmount();
    container.remove();
  });

  it("release before any move is a plain selection, never a reorder", async () => {
    const { React, root, container, onMoveTabToIndex, fire } = await renderBar();
    const tabEl = container.querySelector('[data-tab-id="t2"]') as HTMLElement;

    await React.act(async () => {
      fire(tabEl, "pointerdown", 100, 10);
      vi.advanceTimersByTime(200);
      fire(window, "pointerup", 100, 10);
      // Let any pending timer fire after release: must not arm post-release.
      vi.advanceTimersByTime(1000);
    });
    expect(document.body.classList.contains("tab-dragging")).toBe(false);
    expect(onMoveTabToIndex).not.toHaveBeenCalled();

    root.unmount();
    container.remove();
  });
});
