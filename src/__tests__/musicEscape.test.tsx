// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { MusicPanel } from "../components/MusicPlayer/MusicPanel";

/** One Escape press must undo exactly one layer: popover, then drawer, then the player. */
describe("MusicPanel Escape layering", () => {
  let container: HTMLDivElement;
  let root: Root;
  const onClose = vi.fn();

  const render = (props: { pinned?: boolean } = {}) => {
    if (props.pinned) localStorage.setItem("kai_music_pinned", "true");
    return act(async () => {
      root.render(<MusicPanel startMuted={false} open onClose={onClose} />);
    });
  };
  const pressEscape = () =>
    act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
      );
    });
  const click = (selector: string) =>
    act(async () => {
      (container.querySelector(selector) as HTMLElement).click();
    });

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    onClose.mockClear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("closes only the dim popover first, then the player on the next press", async () => {
    await render();
    await click("button[aria-label^='Dim player opacity']");
    expect(container.querySelector(".music-dim-popover")).not.toBeNull();

    await pressEscape();
    expect(container.querySelector(".music-dim-popover")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();

    await pressEscape();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes only the drawer first, then the player on the next press", async () => {
    await render();
    await click("button[aria-label='Next playing list']");
    expect(container.querySelector(".music-queue-drawer.open")).not.toBeNull();

    await pressEscape();
    expect(container.querySelector(".music-queue-drawer.open")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();

    await pressEscape();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("with the popover over the drawer, unwinds popover, drawer, player in that order", async () => {
    await render();
    await click("button[aria-label='Next playing list']");
    await click("button[aria-label^='Dim player opacity']");

    await pressEscape();
    expect(container.querySelector(".music-dim-popover")).toBeNull();
    expect(container.querySelector(".music-queue-drawer.open")).not.toBeNull();
    await pressEscape();
    expect(container.querySelector(".music-queue-drawer.open")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    await pressEscape();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("a pinned player ignores Escape when no inner layer is open, but still closes the drawer", async () => {
    await render({ pinned: true });
    await pressEscape();
    expect(onClose).not.toHaveBeenCalled();

    await click("button[aria-label='Next playing list']");
    await pressEscape();
    expect(container.querySelector(".music-queue-drawer.open")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("does not take Escape from a handler that already consumed it", async () => {
    // Registered BEFORE the panel mounts, so it runs first (listeners on one
    // target fire in registration order), like another dialog owning Escape.
    // Capture phase, as the panel's own listener is.
    const consume = (e: KeyboardEvent) => e.preventDefault();
    window.addEventListener("keydown", consume, true);
    try {
      await render();
      await pressEscape();
      expect(onClose).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", consume, true);
    }
  });
});
