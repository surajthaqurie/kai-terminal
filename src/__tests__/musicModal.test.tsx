// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { MusicPanel } from "../components/MusicPlayer/MusicPanel";
import { SettingsModal } from "../components/SettingsModal";
import { DEFAULT_SETTINGS } from "../services/settingsService";

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

  it("does not render open in browser button in player controls", async () => {
    await act(async () => {
      root.render(<MusicPanel startMuted={false} open={true} onClose={vi.fn()} />);
    });

    const openInBrowserBtn = container.querySelector("button[aria-label='Open in browser']");
    expect(openInBrowserBtn).toBeNull();
  });

  it("provides top, left, and corner resize handles with persisted panel dimensions", async () => {
    await act(async () => {
      root.render(<MusicPanel startMuted={false} open={true} onClose={vi.fn()} />);
    });

    const topHandle = container.querySelector(".music-resize-top") as HTMLElement;
    const leftHandle = container.querySelector(".music-resize-left") as HTMLElement;
    const cornerHandle = container.querySelector(".music-resize-corner") as HTMLElement;

    expect(topHandle).not.toBeNull();
    expect(leftHandle).not.toBeNull();
    expect(cornerHandle).not.toBeNull();

    // Drag top handle upward to expand panel height
    await act(async () => {
      topHandle.dispatchEvent(
        new PointerEvent("pointerdown", {
          clientX: 500,
          clientY: 400,
          bubbles: true,
          pointerId: 1,
        })
      );
      window.dispatchEvent(
        new PointerEvent("pointermove", {
          clientX: 500,
          clientY: 300, // dragged up by 100px
          bubbles: true,
          pointerId: 1,
        })
      );
      window.dispatchEvent(
        new PointerEvent("pointerup", {
          clientX: 500,
          clientY: 300,
          bubbles: true,
          pointerId: 1,
        })
      );
    });

    const savedHeight = localStorage.getItem("kai_music_panel_height");
    expect(savedHeight).not.toBeNull();
    expect(Number(savedHeight)).toBeGreaterThan(540);
  });

  it("lists search results for plain queries without auto-playing, and plays selected track manually", async () => {
    const onTrackChange = vi.fn();
    const mockResults = [
      { videoId: "track111111", title: "Lofi Study Beats" },
      { videoId: "track222222", title: "Midnight Chill Session" },
      { videoId: "track333333", title: "Rainy Cafe Piano" },
    ];

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => mockResults,
      })
    );

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

    const searchInput = container.querySelector(".music-search input") as HTMLInputElement;
    const searchForm = container.querySelector(".music-search") as HTMLFormElement;

    // Search plain song name
    await act(async () => {
      const nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value"
      )?.set;
      nativeSetter?.call(searchInput, "lofi study");
      searchInput.dispatchEvent(new Event("input", { bubbles: true }));
      searchInput.dispatchEvent(new Event("change", { bubbles: true }));
    });

    await act(async () => {
      searchForm.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    // Should NOT have auto-played any track yet
    expect(onTrackChange).not.toHaveBeenCalledWith(
      expect.objectContaining({ videoId: "track111111" }),
      true
    );

    // Search results list should be rendered with all 3 items
    const resultItems = container.querySelectorAll(".music-search-item");
    expect(resultItems.length).toBe(3);
    expect(resultItems[0].textContent).toContain("Lofi Study Beats");
    expect(resultItems[1].textContent).toContain("Midnight Chill Session");
    expect(resultItems[2].textContent).toContain("Rainy Cafe Piano");

    // Click the 2nd item to play it
    await act(async () => {
      (resultItems[1] as HTMLElement).click();
    });

    // Now playback starts for Midnight Chill Session
    expect(onTrackChange).toHaveBeenCalledWith(
      expect.objectContaining({ videoId: "track222222", title: "Midnight Chill Session" }),
      true
    );

    // Search results are cleared after user plays a song
    expect(container.querySelectorAll(".music-search-item").length).toBe(0);

    // The other 2 items become queued in the Song List with thumbnail images
    const queueItems = container.querySelectorAll(".music-queue-item");
    expect(queueItems.length).toBe(2);
    expect(queueItems[0].textContent).toContain("Lofi Study Beats");
    expect(queueItems[1].textContent).toContain("Rainy Cafe Piano");
    const queueThumbs = container.querySelectorAll(".music-queue-item .music-item-thumb");
    expect(queueThumbs.length).toBe(2);

    // Clicking Next manually plays the next song from the queue
    const nextBtn = container.querySelector("button[aria-label='Next song']") as HTMLButtonElement;
    await act(async () => {
      nextBtn.click();
    });

    expect(onTrackChange).toHaveBeenCalledWith(
      expect.objectContaining({ videoId: "track111111", title: "Lofi Study Beats" }),
      true
    );

    vi.unstubAllGlobals();
  });

  it("provides next playing button to toggle upcoming items list right inside the player card", async () => {
    const mockResults = [
      { videoId: "trackAAAAAA", title: "Alpha Song" },
      { videoId: "trackBBBBBB", title: "Beta Song" },
    ];

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => mockResults,
      })
    );

    await act(async () => {
      root.render(<MusicPanel startMuted={false} open={true} onClose={vi.fn()} />);
    });

    const nextListBtn = container.querySelector(
      "button[aria-label='Next playing list']"
    ) as HTMLButtonElement;
    expect(nextListBtn).not.toBeNull();

    // Search and select a track
    const searchInput = container.querySelector(".music-search input") as HTMLInputElement;
    const searchForm = container.querySelector(".music-search") as HTMLFormElement;

    await act(async () => {
      const nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value"
      )?.set;
      nativeSetter?.call(searchInput, "alpha");
      searchInput.dispatchEvent(new Event("input", { bubbles: true }));
      searchInput.dispatchEvent(new Event("change", { bubbles: true }));
    });

    await act(async () => {
      searchForm.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    const resultItems = container.querySelectorAll(".music-search-item");
    await act(async () => {
      (resultItems[0] as HTMLElement).click();
    });

    // Upcoming queue is displayed inside .music-now
    expect(container.querySelector(".music-next-section")).not.toBeNull();
    expect(container.querySelectorAll(".music-queue-item").length).toBe(1);

    // Clicking next playing button toggles the list visibility
    await act(async () => {
      nextListBtn.click();
    });
    expect(container.querySelector(".music-next-section")).toBeNull();

    // Clicking it again re-opens the upcoming list
    await act(async () => {
      nextListBtn.click();
    });
    expect(container.querySelector(".music-next-section")).not.toBeNull();

    vi.unstubAllGlobals();
  });

  it("renders YouTube music player option in SettingsModal on one line only", async () => {
    await act(async () => {
      root.render(
        <SettingsModal
          isOpen={true}
          onClose={vi.fn()}
          settings={DEFAULT_SETTINGS}
          onSaveSettings={vi.fn()}
          shells={[]}
        />
      );
    });

    // Find the music player label
    const labels = Array.from(container.querySelectorAll(".checkbox-label"));
    const musicLabel = labels.find((l) => l.textContent?.includes("YouTube music player"));
    expect(musicLabel).toBeDefined();

    // Verify "Show music player" text is removed
    const allText = container.textContent || "";
    expect(allText).not.toContain("Show music player");

    // Verify no separate muted paragraph underneath
    const parentField = musicLabel?.closest(".setting-field");
    expect(parentField?.querySelector("p")).toBeNull();
  });
});
