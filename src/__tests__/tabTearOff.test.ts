// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalTab } from "../types/terminal";

function makeTabs(n: number): TerminalTab[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `t${i + 1}`,
    title: `tab ${i + 1}`,
    status: "connected" as const,
    panes: [{ id: `p${i + 1}`, status: "connected" as const }],
    activePaneId: `p${i + 1}`,
    splitDirection: "none" as const,
  }));
}

describe("tear-off zone", () => {
  it("is clearly above or below the strip, or outside the window's sides", async () => {
    const { isTearOffZone } = await import("../components/TabBar");
    const strip = { top: 4, bottom: 38 };
    const at = (clientX: number, clientY: number) =>
      isTearOffZone({ clientX, clientY }, strip, 1000);
    expect(at(300, 20)).toBe(false); // on the strip: an ordinary reorder
    expect(at(300, 80)).toBe(false); // just below: still a reorder
    expect(at(300, 200)).toBe(true); // well below
    expect(at(300, -60)).toBe(true); // above the window
    expect(at(-5, 20)).toBe(true); // left of the window
    expect(at(1200, 20)).toBe(true); // right of the window
    expect(at(900, 20)).toBe(false); // along the header toward the buttons
  });
});

describe("TabBar tab tear-off", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    document.body.classList.remove("tab-dragging");
    document.body.innerHTML = "";
  });

  async function renderBar(tabCount = 3, withHandler = true, extra: Record<string, unknown> = {}) {
    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { TabBar } = await import("../components/TabBar");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const onDetachTab = vi.fn();
    const onMoveTabToIndex = vi.fn();
    const fire = (target: Element | Window, type: string, x: number, y: number) => {
      const ev = new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: y,
        screenX: x + 500,
        screenY: y + 300,
        button: 0,
      });
      Object.defineProperty(ev, "pointerType", { value: "mouse" });
      Object.defineProperty(ev, "pointerId", { value: 1 });
      (target as EventTarget).dispatchEvent(ev);
    };
    await React.act(async () => {
      root.render(
        React.createElement(TabBar, {
          tabs: makeTabs(tabCount),
          activeTabId: "t1",
          onSelectTab: () => {},
          onCloseTab: () => {},
          onNewTab: () => {},
          onMoveTabToIndex,
          onDetachTab: withHandler ? onDetachTab : undefined,
          ...extra,
        })
      );
    });
    return { React, root, container, onDetachTab, onMoveTabToIndex, fire };
  }

  it("opens the tab in a new window when it is released far below the strip", async () => {
    const { React, container, onDetachTab, onMoveTabToIndex, fire } = await renderBar();
    const tabEl = container.querySelector('[data-tab-id="t2"]') as HTMLElement;

    await React.act(async () => {
      fire(tabEl, "pointerdown", 100, 10);
      fire(window, "pointermove", 110, 200);
    });
    // Armed: the tab and a hint say what releasing will do.
    expect(tabEl.classList.contains("detach-armed")).toBe(true);
    expect(container.querySelector(".tab-detach-hint")?.textContent).toMatch(/new window/i);
    expect(container.querySelector(".tab-drop-indicator")).toBeNull();

    await React.act(async () => {
      fire(window, "pointerup", 110, 200);
    });
    expect(onDetachTab).toHaveBeenCalledTimes(1);
    expect(onDetachTab).toHaveBeenCalledWith("t2", 610, 500); // screen coordinates, for placing the window
    // FUNC-13 (decided): releasing in the zone opens the window at once, with no confirmation.
    expect(document.querySelector('[role="dialog"], [role="alertdialog"]')).toBeNull();
    expect(onMoveTabToIndex).not.toHaveBeenCalled();
    expect(document.body.classList.contains("tab-dragging")).toBe(false);
    expect(container.querySelector(".tab-detach-hint")).toBeNull();
  });

  it("dragging back onto the strip before releasing disarms it and reorders as usual", async () => {
    const { React, container, onDetachTab, onMoveTabToIndex, fire } = await renderBar();
    const tabEl = container.querySelector('[data-tab-id="t2"]') as HTMLElement;

    await React.act(async () => {
      fire(tabEl, "pointerdown", 100, 10);
      fire(window, "pointermove", 110, 200);
      fire(window, "pointermove", 160, 12);
    });
    expect(tabEl.classList.contains("detach-armed")).toBe(false);

    await React.act(async () => {
      fire(window, "pointerup", 160, 12);
    });
    expect(onDetachTab).not.toHaveBeenCalled();
    expect(onMoveTabToIndex).toHaveBeenCalledTimes(1);
  });

  it("Escape cancels an armed drag", async () => {
    const { React, container, onDetachTab, fire } = await renderBar();
    const tabEl = container.querySelector('[data-tab-id="t2"]') as HTMLElement;

    await React.act(async () => {
      fire(tabEl, "pointerdown", 100, 10);
      fire(window, "pointermove", 110, 200);
    });
    expect(tabEl.classList.contains("detach-armed")).toBe(true);
    await React.act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      fire(window, "pointerup", 110, 200);
    });
    expect(onDetachTab).not.toHaveBeenCalled();
    expect(container.querySelector(".tab-detach-hint")).toBeNull();
  });

  it("never offers to tear off the only tab (a window cannot be left empty)", async () => {
    const { React, container, onDetachTab, fire } = await renderBar(1);
    const tabEl = container.querySelector('[data-tab-id="t1"]') as HTMLElement;
    await React.act(async () => {
      fire(tabEl, "pointerdown", 100, 10);
      fire(window, "pointermove", 110, 200);
    });
    expect(tabEl.classList.contains("detach-armed")).toBe(false);
    await React.act(async () => {
      fire(window, "pointerup", 110, 200);
    });
    expect(onDetachTab).not.toHaveBeenCalled();
  });

  it("does nothing special without a handler", async () => {
    const { React, container, fire } = await renderBar(3, false);
    const tabEl = container.querySelector('[data-tab-id="t2"]') as HTMLElement;
    await React.act(async () => {
      fire(tabEl, "pointerdown", 100, 10);
      fire(window, "pointermove", 110, 200);
    });
    expect(tabEl.classList.contains("detach-armed")).toBe(false);
    expect(container.querySelector(".tab-detach-hint")).toBeNull();
  });

  it("the tab's context menu has Move to new window, which needs a second tab", async () => {
    const { React, container, onDetachTab } = await renderBar();
    const tabEl = container.querySelector('[data-tab-id="t2"]') as HTMLElement;
    await React.act(async () => {
      tabEl.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    });
    const item = [...container.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (el) => el.textContent === "Move to new window"
    );
    expect(item).toBeDefined();
    await React.act(async () => item!.click());
    expect(onDetachTab).toHaveBeenCalledWith("t2");
  });

  it("hides that menu item when there is only one tab", async () => {
    const { React, container } = await renderBar(1);
    const tabEl = container.querySelector('[data-tab-id="t1"]') as HTMLElement;
    await React.act(async () => {
      tabEl.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    });
    const labels = [...container.querySelectorAll('[role="menuitem"]')].map((e) => e.textContent);
    expect(labels).not.toContain("Move to new window");
  });

  it("with another window open, even the only tab can be dragged out (to merge it back)", async () => {
    const { React, container, onDetachTab, fire } = await renderBar(1, true, {
      otherWindows: ["main"],
    });
    const tabEl = container.querySelector('[data-tab-id="t1"]') as HTMLElement;
    await React.act(async () => {
      fire(tabEl, "pointerdown", 100, 10);
      fire(window, "pointermove", 110, 200);
    });
    expect(tabEl.classList.contains("detach-armed")).toBe(true);
    expect(container.querySelector(".tab-detach-hint")?.textContent).toMatch(/another Kai window/i);
    await React.act(async () => {
      fire(window, "pointerup", 110, 200);
    });
    expect(onDetachTab).toHaveBeenCalledWith("t1", 610, 500);
  });

  it("the tab's menu offers each other window and merging them all here", async () => {
    const onMoveTabToWindow = vi.fn();
    const onMergeAllWindows = vi.fn();
    const { React, container } = await renderBar(1, true, {
      otherWindows: ["main", "term-3"],
      onMoveTabToWindow,
      onMergeAllWindows,
    });
    const tabEl = container.querySelector('[data-tab-id="t1"]') as HTMLElement;
    const openMenu = () =>
      React.act(async () => {
        tabEl.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
      });
    const item = (label: string) =>
      [...container.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
        (el) => el.textContent === label
      );
    await openMenu();
    expect(item("Move to Window 3")).toBeDefined();
    await React.act(async () => item("Move to Main window")!.click());
    expect(onMoveTabToWindow).toHaveBeenCalledWith("t1", "main");
    await openMenu();
    await React.act(async () => item("Merge all windows here")!.click());
    expect(onMergeAllWindows).toHaveBeenCalledTimes(1);
  });
});
