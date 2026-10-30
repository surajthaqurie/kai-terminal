// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PopupMenu, type MenuEntry } from "../components/PopupMenu";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function mount(entries: MenuEntry[], onOpen?: () => void) {
  await act(async () => {
    root.render(
      <>
        <button data-testid="outside">outside</button>
        <PopupMenu
          label="Test menu"
          entries={entries}
          onOpen={onOpen}
          trigger={({ toggle, props }) => (
            <button type="button" data-testid="trigger" onClick={toggle} {...props}>
              open
            </button>
          )}
        />
      </>
    );
  });
}

const trigger = () => container.querySelector<HTMLElement>('[data-testid="trigger"]')!;
const menu = () => container.querySelector<HTMLElement>('[role="menu"]');
const items = () => [...container.querySelectorAll<HTMLElement>('[role^="menuitem"]')];
const key = (el: Element, k: string) =>
  act(async () => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  });

describe("PopupMenu", () => {
  const entries = (onSelect = vi.fn()): MenuEntry[] => [
    { kind: "heading", id: "h", label: "Group" },
    { id: "a", label: "Alpha", onSelect },
    { kind: "separator", id: "s" },
    { id: "b", label: "Beta", hint: "Ctrl+B", onSelect },
    { id: "c", label: "Gamma", checked: true, onSelect },
  ];

  it("opens under its trigger, exposes ARIA state, and focuses the first item", async () => {
    await mount(entries());
    expect(menu()).toBeNull();
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    await act(async () => trigger().click());
    expect(menu()!.getAttribute("aria-label")).toBe("Test menu");
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(trigger().getAttribute("aria-controls")).toBe(menu()!.id);
    expect(document.activeElement).toBe(items()[0]);
  });

  it("uses radio semantics only for entries that carry a checked state", async () => {
    await mount(entries());
    await act(async () => trigger().click());
    expect(items().map((i) => i.getAttribute("role"))).toEqual([
      "menuitem",
      "menuitem",
      "menuitemradio",
    ]);
    expect(items()[2].getAttribute("aria-checked")).toBe("true");
  });

  it("moves with the arrow keys, wrapping, and Home / End", async () => {
    await mount(entries());
    await act(async () => trigger().click());
    await key(menu()!, "ArrowDown");
    expect(document.activeElement).toBe(items()[1]);
    await key(menu()!, "End");
    expect(document.activeElement).toBe(items()[2]);
    await key(menu()!, "ArrowDown");
    expect(document.activeElement).toBe(items()[0]);
    await key(menu()!, "ArrowUp");
    expect(document.activeElement).toBe(items()[2]);
    await key(menu()!, "Home");
    expect(document.activeElement).toBe(items()[0]);
  });

  it("Escape closes the menu and returns focus to the trigger", async () => {
    await mount(entries());
    await act(async () => trigger().click());
    await key(menu()!, "Escape");
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it("closes on an outside press, and on Tab, without stealing focus", async () => {
    await mount(entries());
    await act(async () => trigger().click());
    await act(async () => {
      container
        .querySelector('[data-testid="outside"]')!
        .dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(menu()).toBeNull();
    await act(async () => trigger().click());
    await key(menu()!, "Tab");
    expect(menu()).toBeNull();
  });

  it("runs the chosen entry once and closes", async () => {
    const onSelect = vi.fn();
    await mount(entries(onSelect));
    await act(async () => trigger().click());
    await act(async () => items()[1].click());
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(menu()).toBeNull();
  });

  it("ArrowDown on the closed trigger opens it, and onOpen fires on open", async () => {
    const onOpen = vi.fn();
    await mount(entries(), onOpen);
    await key(trigger(), "ArrowDown");
    expect(menu()).not.toBeNull();
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});
