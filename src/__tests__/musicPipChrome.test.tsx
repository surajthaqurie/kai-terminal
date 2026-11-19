// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";

let pipListeners: Record<string, (data: unknown) => void> = {};

vi.mock("../services/musicPip", async (importActual) => ({
  ...(await importActual<typeof import("../services/musicPip")>()),
  emitPip: async () => {},
  closeMusicPip: async () => {},
  listenPip: async (event: string, cb: (data: unknown) => void) => {
    pipListeners[event] = cb;
    return () => {};
  },
}));

import { MusicPipWindow } from "../components/MusicPlayer/MusicPipWindow";
import { EMPTY_PIP_STATE, PIP_EVENTS } from "../services/musicPip";

describe("mini player controls", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    pipListeners = {};
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  const pip = () => container.querySelector(".music-pip") as HTMLDivElement;
  const shown = () => pip().classList.contains("music-pip-chrome");
  const pointer = (type: string, target: Element = pip()) =>
    act(async () => {
      target.dispatchEvent(new PointerEvent(type, { bubbles: true }));
    });

  const renderPlaying = async () => {
    await act(async () => {
      root.render(<MusicPipWindow />);
    });
    await act(async () => {
      pipListeners[PIP_EVENTS.state]?.({
        ...EMPTY_PIP_STATE,
        src: "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1",
        title: "Song",
        playing: true,
      });
    });
  };

  it("shows just the video until the pointer moves, and hides again after a rest", async () => {
    await renderPlaying();
    expect(shown()).toBe(false);
    await pointer("pointermove");
    expect(shown()).toBe(true);
    await act(async () => {
      vi.advanceTimersByTime(2600);
    });
    expect(shown()).toBe(false);
  });

  it("hides as soon as the pointer leaves the window", async () => {
    await renderPlaying();
    await pointer("pointermove");
    // React's onPointerLeave listens to pointerout/pointerover pairs.
    await act(async () => {
      pip().dispatchEvent(
        new PointerEvent("pointerout", { bubbles: true, relatedTarget: document.body })
      );
    });
    expect(shown()).toBe(false);
  });

  it("a clicked button does not keep the controls on screen", async () => {
    await renderPlaying();
    const play = container.querySelector("button[aria-label='Pause']") as HTMLButtonElement;
    await pointer("pointermove", pip());
    play.focus();
    await act(async () => {
      vi.advanceTimersByTime(2600);
    });
    expect(shown()).toBe(false);
  });

  it("stays while the pointer rests on the controls", async () => {
    await renderPlaying();
    const bar = container.querySelector(".music-pip-bar") as HTMLDivElement;
    await pointer("pointermove", bar);
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    expect(shown()).toBe(true);
  });
});
