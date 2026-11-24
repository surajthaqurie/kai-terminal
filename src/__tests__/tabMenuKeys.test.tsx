// @vitest-environment jsdom
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TabBar } from "../components/TabBar";
import type { TerminalTab } from "../types/terminal";

/** FUNC-13: the tab context menu could only be used with a mouse. */
let root: Root;
let host: HTMLElement;

const tab = (id: string): TerminalTab =>
  ({
    id,
    title: `Terminal ${id}`,
    status: "connected",
    activePaneId: `${id}-p`,
    splitDirection: "vertical",
    panes: [{ id: `${id}-p`, status: "connected" }],
  }) as unknown as TerminalTab;

beforeEach(async () => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () =>
    root.render(
      createElement(TabBar, {
        tabs: [tab("a"), tab("b"), tab("c")],
        activeTabId: "a",
        onSelectTab: () => {},
        onCloseTab: () => {},
        onNewTab: () => {},
        onMoveTab: () => {},
        onSetTabColor: () => {},
        onDetachTab: () => {},
      })
    )
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

const menu = () => host.querySelector<HTMLElement>('[role="menu"]');
const key = (name: string) =>
  act(async () => {
    (document.activeElement ?? document.body).dispatchEvent(
      new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true })
    );
  });
const focusedLabel = () =>
  document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.textContent;

async function openMenu(tabId: string) {
  await act(async () => {
    host
      .querySelector(`[data-tab-id="${tabId}"]`)!
      .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  });
}

describe("tab context menu keyboard use", () => {
  it("takes focus when it opens, so a keyboard user can drive it", async () => {
    await openMenu("a");
    expect(menu()).not.toBeNull();
    expect(document.activeElement).toBe(menu());
  });

  it("Down and Up move through the buttons, skipping disabled ones, and wrap", async () => {
    await openMenu("a"); // the first tab: "Move left" is disabled
    await key("ArrowDown");
    expect(focusedLabel()).toBe("Rename session");
    await key("ArrowDown");
    expect(focusedLabel()).toBe("Default tab color");

    // Go all the way round: from the last button Down returns to the first.
    const buttons = [...menu()!.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
    buttons[buttons.length - 1].focus();
    await key("ArrowDown");
    expect(focusedLabel()).toBe("Rename session");
    await key("ArrowUp");
    expect(document.activeElement).toBe(buttons[buttons.length - 1]);

    const labels = buttons.map((b) => b.textContent);
    expect(labels).not.toContain("Move left"); // disabled on the first tab
  });

  it("Left and Right move between the colour swatches; Home and End jump to the ends", async () => {
    await openMenu("b");
    await key("ArrowDown"); // Rename
    await key("ArrowDown"); // default colour swatch
    const first = document.activeElement as HTMLElement;
    await key("ArrowRight");
    expect(document.activeElement).not.toBe(first);
    expect(document.activeElement?.closest(".tab-color-swatches")).not.toBeNull();
    await key("ArrowLeft");
    expect(document.activeElement).toBe(first);

    await key("End");
    expect(focusedLabel()).toBe("Close tab");
    await key("Home");
    expect(focusedLabel()).toBe("Rename session");
  });

  it("Escape closes the menu and puts focus back on its tab", async () => {
    await openMenu("c");
    await key("ArrowDown");
    await key("Escape");
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(host.querySelector('[data-tab-id="c"]'));
  });
});
