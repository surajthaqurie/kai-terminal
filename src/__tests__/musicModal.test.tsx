// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { MusicPanel } from "../components/MusicPlayer/MusicPanel";

describe("MusicPanel modal implementation", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
      true;
    localStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    document.body.innerHTML = "";
  });

  it("renders as modal backdrop and dialog with proper open state", async () => {
    const onClose = vi.fn();
    await act(async () => {
      root.render(<MusicPanel startMuted={false} open={true} onClose={onClose} />);
    });

    const backdrop = container.querySelector(".music-modal-backdrop");
    expect(backdrop).not.toBeNull();
    expect(backdrop?.classList.contains("open")).toBe(true);
    expect(backdrop?.getAttribute("role")).toBe("dialog");
    expect(backdrop?.getAttribute("aria-modal")).toBe("true");

    const dialog = container.querySelector(".music-modal-dialog");
    expect(dialog).not.toBeNull();
    expect(dialog?.getAttribute("role")).toBe("document");
    expect(container.querySelector(".modal-header.music-head")).not.toBeNull();
  });

  it("renders in closed state without unmounting the DOM structure", async () => {
    const onClose = vi.fn();
    await act(async () => {
      root.render(<MusicPanel startMuted={false} open={false} onClose={onClose} />);
    });

    const backdrop = container.querySelector(".music-modal-backdrop");
    expect(backdrop).not.toBeNull();
    expect(backdrop?.classList.contains("closed")).toBe(true);
    expect(backdrop?.getAttribute("aria-hidden")).toBe("true");
    expect(container.querySelector(".music-modal-dialog")).not.toBeNull();
  });

  it("calls onClose when clicking the modal backdrop", async () => {
    const onClose = vi.fn();
    await act(async () => {
      root.render(<MusicPanel startMuted={false} open={true} onClose={onClose} />);
    });

    const backdrop = container.querySelector(".music-modal-backdrop") as HTMLElement;
    expect(backdrop).not.toBeNull();
    backdrop.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not call onClose when clicking inside the dialog card", async () => {
    const onClose = vi.fn();
    await act(async () => {
      root.render(<MusicPanel startMuted={false} open={true} onClose={onClose} />);
    });

    const dialog = container.querySelector(".music-modal-dialog") as HTMLElement;
    expect(dialog).not.toBeNull();
    dialog.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("calls onClose when pressing Escape key while open", async () => {
    const onClose = vi.fn();
    await act(async () => {
      root.render(<MusicPanel startMuted={false} open={true} onClose={onClose} />);
    });

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not call onClose when pressing Escape key while closed", async () => {
    const onClose = vi.fn();
    await act(async () => {
      root.render(<MusicPanel startMuted={false} open={false} onClose={onClose} />);
    });

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("calls onClose and resets playback when clicking the close button", async () => {
    const onClose = vi.fn();
    const onTrackChange = vi.fn();
    await act(async () => {
      root.render(
        <MusicPanel
          startMuted={false}
          open={true}
          onClose={onClose}
          onTrackChange={onTrackChange}
        />
      );
    });

    const closeBtn = container.querySelector(".btn-close") as HTMLButtonElement;
    expect(closeBtn).not.toBeNull();
    await act(async () => {
      closeBtn.click();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onTrackChange).toHaveBeenCalledWith(null, false);
  });

  it("supports pinning and minimize unpins the player", async () => {
    const onClose = vi.fn();
    await act(async () => {
      root.render(<MusicPanel startMuted={false} open={true} onClose={onClose} />);
    });

    const pinBtn = container.querySelector("button[aria-label='Pin player']") as HTMLButtonElement;
    expect(pinBtn).not.toBeNull();

    // Clicking pin pins the player
    await act(async () => {
      pinBtn.click();
    });
    expect(localStorage.getItem("kai_music_pinned")).toBe("true");

    // Clicking backdrop while pinned does NOT close player
    const backdrop = container.querySelector(".music-modal-backdrop") as HTMLElement;
    backdrop.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onClose).not.toHaveBeenCalled();

    // Clicking minimize unpins and calls onClose
    const minimizeBtn = container.querySelector(
      "button[aria-label='Minimize player']"
    ) as HTMLButtonElement;
    expect(minimizeBtn).not.toBeNull();
    await act(async () => {
      minimizeBtn.click();
    });
    expect(localStorage.getItem("kai_music_pinned")).toBe("false");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not render preset chips or random button, and provides search input, progress scrubber, loop and next controls", async () => {
    const onTrackChange = vi.fn();
    await act(async () => {
      root.render(
        <MusicPanel
          startMuted={false}
          open={true}
          onClose={vi.fn()}
          onTrackChange={onTrackChange}
        />
      );
    });

    // Preset buttons and chips should be removed
    expect(container.querySelector(".music-preset-btn")).toBeNull();
    expect(container.querySelector(".music-chip")).toBeNull();

    // Progress slider, Volume slider, Next button, and Loop button should be rendered
    const slider = container.querySelector(".music-progress-slider") as HTMLInputElement;
    expect(slider).not.toBeNull();

    const volumeSlider = container.querySelector(".music-volume-slider") as HTMLInputElement;
    expect(volumeSlider).not.toBeNull();

    // Changing volume slider adjusts the volume
    await act(async () => {
      const nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value"
      )?.set;
      nativeSetter?.call(volumeSlider, "40");
      volumeSlider.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(localStorage.getItem("kai_music_volume")).toBe("40");

    const nextBtn = container.querySelector("button[aria-label='Next song']") as HTMLButtonElement;
    expect(nextBtn).not.toBeNull();

    const loopBtn = container.querySelector(
      "button[aria-label='Enable loop']"
    ) as HTMLButtonElement;
    expect(loopBtn).not.toBeNull();
    expect(loopBtn.getAttribute("aria-pressed")).toBe("false");

    // Clicking loop button should toggle loop
    await act(async () => {
      loopBtn.click();
    });
    expect(loopBtn.getAttribute("aria-pressed")).toBe("true");
    expect(loopBtn.getAttribute("aria-label")).toBe("Disable loop");
    expect(loopBtn.classList.contains("music-control-active")).toBe(true);

    // Submitting a YouTube link plays the track and mounts the iframe
    const searchInput = container.querySelector(".music-search input") as HTMLInputElement;
    const searchForm = container.querySelector(".music-search") as HTMLFormElement;
    expect(searchInput).not.toBeNull();

    await act(async () => {
      const nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value"
      )?.set;
      nativeSetter?.call(searchInput, "https://www.youtube.com/watch?v=0w80F8FffQ4");
      searchInput.dispatchEvent(new Event("input", { bubbles: true }));
      searchInput.dispatchEvent(new Event("change", { bubbles: true }));
    });

    await act(async () => {
      searchForm.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    expect(onTrackChange).toHaveBeenCalledWith(
      expect.objectContaining({ videoId: "0w80F8FffQ4" }),
      true
    );

    const iframe = container.querySelector("iframe.music-video") as HTMLIFrameElement;
    expect(iframe).not.toBeNull();
    expect(iframe.src).toContain("youtube-nocookie.com/embed/0w80F8FffQ4");
    expect(iframe.src).toContain("autoplay=1");
    expect(iframe.src).toContain("loop=1");
  });
});
