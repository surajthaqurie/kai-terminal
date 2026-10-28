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
    expect(backdrop.classList.contains("pinned")).toBe(true);
    backdrop.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onClose).not.toHaveBeenCalled();

    // Global Escape key while pinned does NOT close the player (so users can close other modals)
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
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
    // Native loop=1 is baked into the URL when loop is on at load time (the
    // reliable repeat mechanism). Toggling loop mid-song does NOT rebuild the
    // iframe (that used to restart the song); only switching loop OFF on an
    // embed that was built with native loop rebuilds it, position-preserving.
    expect(iframe.src).toContain("loop=1");
  });

  it("renders the favorites heart (disabled without a track) and favorites tab in the drawer", async () => {
    await act(async () => {
      root.render(<MusicPanel startMuted={false} open={true} onClose={vi.fn()} />);
    });

    const heartBtn = container.querySelector(
      "button[aria-label='Add to favorites']"
    ) as HTMLButtonElement;
    expect(heartBtn).not.toBeNull();
    expect(heartBtn.disabled).toBe(true);

    // Open the Next-playing drawer: it now has Next Playing / Favorites tabs.
    const nextListBtn = container.querySelector(
      "button[aria-label='Next playing list']"
    ) as HTMLButtonElement;
    await act(async () => nextListBtn.click());
    expect(container.querySelector(".music-drawer-tab.active")?.textContent).toContain(
      "Next Playing"
    );

    const favTab = Array.from(
      container.querySelectorAll<HTMLButtonElement>(".music-drawer-tab")
    ).find((b) => b.textContent?.includes("Favorites")) as HTMLButtonElement;
    await act(async () => favTab.click());
    expect(favTab.classList.contains("active")).toBe(true);
    expect(container.querySelector(".music-drawer-empty")?.textContent).toContain(
      "No favorites yet"
    );
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

    // Search results are cleared after user plays a song, and screen returns to playing view (drawer closed)
    expect(container.querySelectorAll(".music-search-item").length).toBe(0);
    expect(container.querySelector(".music-queue-drawer.open")).toBeNull();

    // Clicking the Next Playing list button opens the upcoming songs in the right-side drawer
    const nextListBtn = container.querySelector(
      "button[aria-label='Next playing list']"
    ) as HTMLButtonElement;
    await act(async () => {
      nextListBtn.click();
    });

    // The other 2 items become queued in the Song List with thumbnail images
    expect(container.querySelector(".music-queue-drawer.open")).not.toBeNull();
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

  it("slides right-side drawer when next playing button is clicked, and selecting a track plays it and returns to playing screen", async () => {
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

    // Track 0 is played; drawer closes returning to the playing screen
    expect(container.querySelector(".music-queue-drawer.open")).toBeNull();

    // Clicking next playing button slides the right-side drawer open
    await act(async () => {
      nextListBtn.click();
    });
    expect(container.querySelector(".music-queue-drawer.open")).not.toBeNull();
    expect(container.querySelectorAll(".music-queue-item").length).toBe(1);

    // Clicking a song in the queue plays it and returns to the playing view (drawer closes)
    const queueItem = container.querySelector(".music-queue-item") as HTMLElement;
    await act(async () => {
      queueItem.click();
    });
    expect(container.querySelector(".music-queue-drawer.open")).toBeNull();

    // Re-opening the drawer shows empty state or new upcoming
    await act(async () => {
      nextListBtn.click();
    });
    expect(container.querySelector(".music-queue-drawer.open")).not.toBeNull();

    // Clicking back button in drawer returns to playing screen
    const backBtn = container.querySelector(".music-drawer-back") as HTMLButtonElement;
    expect(backBtn).not.toBeNull();
    await act(async () => {
      backBtn.click();
    });
    expect(container.querySelector(".music-queue-drawer.open")).toBeNull();

    // Re-opening drawer and clicking backdrop overlay closes it
    await act(async () => {
      nextListBtn.click();
    });
    expect(container.querySelector(".music-queue-drawer.open")).not.toBeNull();
    const backdrop = container.querySelector(".music-drawer-backdrop") as HTMLElement;
    expect(backdrop).not.toBeNull();
    await act(async () => {
      backdrop.click();
    });
    expect(container.querySelector(".music-queue-drawer.open")).toBeNull();

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

  it("includes CSS for inactive dimming, invisible resize handles, and glassy right-side slider", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const cssPath = path.resolve(__dirname, "../App.css");
    const cssContent = fs.readFileSync(cssPath, "utf-8");

    // Inactive dimming & active brightness
    expect(cssContent).toContain("opacity: 0.62;");
    expect(cssContent).toContain(".music-modal-dialog:hover");
    expect(cssContent).toContain("opacity: 1 !important;");

    // Resize grips are transparent with no border or box-shadow highlight
    expect(cssContent).toContain(".music-resize-left,");
    expect(cssContent).toContain("background-color: transparent !important;");
    expect(cssContent).toContain("box-shadow: none !important;");

    // Glassy bottom slider
    expect(cssContent).toContain(".music-queue-drawer");
    expect(cssContent).toContain("backdrop-filter: blur(");
    expect(cssContent).toContain("transform: translateY(100%);");
    expect(cssContent).toContain(".music-queue-drawer.open");
    expect(cssContent).toContain("transform: translateY(0);");

    // Pinned player elevation above Settings, Git modals, etc.
    expect(cssContent).toContain(".music-modal-backdrop.pinned");
    expect(cssContent).toContain("z-index: 2100 !important;");
    expect(cssContent).toContain(".music-modal-backdrop.pinned .music-modal-dialog");
    expect(cssContent).toContain("z-index: 2101 !important;");
  });

  it("renders professional Lucide music icon instead of raw text ♪ in panel and status bar", async () => {
    const { StatusBar } = await import("../components/StatusBar");

    await act(async () => {
      root.render(<MusicPanel startMuted={false} open={true} onClose={vi.fn()} />);
    });

    // Panel header badge contains an SVG music icon, not text "♪"
    const headBadge = container.querySelector(".music-head-badge");
    expect(headBadge).not.toBeNull();
    expect(headBadge?.querySelector("svg")).not.toBeNull();
    expect(headBadge?.textContent?.trim()).not.toBe("♪");

    // Empty state badge contains an SVG music icon, not text "♪"
    const emptyBadge = container.querySelector(".music-empty-badge");
    expect(emptyBadge).not.toBeNull();
    expect(emptyBadge?.querySelector("svg")).not.toBeNull();
    expect(emptyBadge?.textContent?.trim()).not.toBe("♪");

    // Status bar mini pill contains SVG music icon, not text "♪"
    await act(async () => {
      root.render(
        <StatusBar
          gitBranch="main"
          gitDirty={false}
          projectDir="/test"
          appVersion="1.0.0"
          updateAvailable={false}
          onViewUpdate={vi.fn()}
          music={{
            title: "Test Track",
            playing: true,
            muted: false,
            progress: 30,
          }}
        />
      );
    });

    const miniArt = container.querySelector(".music-mini-art");
    expect(miniArt).not.toBeNull();
    expect(miniArt?.querySelector("svg")).not.toBeNull();
    expect(miniArt?.textContent?.trim()).not.toBe("♪");

    // When thumbnail is provided, status bar renders the thumbnail image
    await act(async () => {
      root.render(
        <StatusBar
          gitBranch="main"
          gitDirty={false}
          projectDir="/test"
          appVersion="1.0.0"
          updateAvailable={false}
          onViewUpdate={vi.fn()}
          music={{
            title: "Long Title Song With Thumbnail",
            videoId: "jfKfPfyJRdk",
            thumbnail: "https://i.ytimg.com/vi/jfKfPfyJRdk/mqdefault.jpg",
            playing: true,
            muted: false,
            progress: 50,
          }}
        />
      );
    });

    const thumbImg = container.querySelector(".music-mini-thumb") as HTMLImageElement;
    expect(thumbImg).not.toBeNull();
    expect(thumbImg.src).toContain("jfKfPfyJRdk");

    const miniTitle = container.querySelector(".music-mini-title");
    expect(miniTitle?.textContent).toBe("Long Title Song With Thumbnail");

    // If thumbnail fails to load, falls back to the SVG music icon
    await act(async () => {
      thumbImg.dispatchEvent(new Event("error"));
    });
    const fallbackArt = container.querySelector(".music-mini-art");
    expect(fallbackArt?.querySelector("svg")).not.toBeNull();
  });

  it("supports dim opacity toggle and resetting to default player dimensions", async () => {
    localStorage.removeItem("kai_music_dimmed");
    localStorage.setItem("kai_music_panel_width", "600");
    localStorage.setItem("kai_music_panel_height", "700");

    await act(async () => {
      root.render(<MusicPanel startMuted={false} open={true} onClose={vi.fn()} />);
    });

    const dialog = container.querySelector(".music-modal-dialog") as HTMLElement;
    expect(dialog).not.toBeNull();
    expect(dialog.classList.contains("is-dimmed")).toBe(false);

    // Dim button opens popover slider without automatically forcing dim on
    const dimBtn = container.querySelector(
      "button[aria-label^='Dim player opacity']"
    ) as HTMLButtonElement;
    expect(dimBtn).not.toBeNull();

    await act(async () => {
      dimBtn.click();
    });
    // Popover is open while dim remains off until user explicitly selects preset or toggles on
    expect(dialog.classList.contains("is-dimmed")).toBe(false);
    expect(localStorage.getItem("kai_music_dimmed")).toBeNull();

    // Popover is visible and has percentage slider and presets
    const popover = container.querySelector(".music-dim-popover");
    expect(popover).not.toBeNull();
    const slider = container.querySelector(".music-dim-slider") as HTMLInputElement;
    expect(slider).not.toBeNull();

    // Changing percentage via preset enables dimming, updates dimPercent and storage
    const preset60 = Array.from(container.querySelectorAll(".music-dim-preset-chip")).find(
      (el) => el.textContent?.trim() === "60%"
    ) as HTMLButtonElement;
    expect(preset60).not.toBeNull();

    await act(async () => {
      preset60.click();
    });
    expect(dialog.classList.contains("is-dimmed")).toBe(true);
    expect(localStorage.getItem("kai_music_dimmed")).toBe("true");
    expect(localStorage.getItem("kai_music_dim_percent")).toBe("60");
    expect(container.querySelector(".music-dim-val")?.textContent).toBe("60%");

    // Disable dimming via the "Off" button in the header toggle switch
    const offBtn = Array.from(container.querySelectorAll(".music-dim-toggle-switch button")).find(
      (el) => el.textContent?.trim() === "Off"
    ) as HTMLButtonElement;
    expect(offBtn).not.toBeNull();

    await act(async () => {
      offBtn.click();
    });
    expect(dialog.classList.contains("is-dimmed")).toBe(false);
    expect(localStorage.getItem("kai_music_dimmed")).toBe("false");
    expect(offBtn.classList.contains("active")).toBe(true);

    // Clicking "On" enables dimming again
    const onBtn = Array.from(container.querySelectorAll(".music-dim-toggle-switch button")).find(
      (el) => el.textContent?.trim() === "On"
    ) as HTMLButtonElement;
    expect(onBtn).not.toBeNull();

    await act(async () => {
      onBtn.click();
    });
    expect(dialog.classList.contains("is-dimmed")).toBe(true);
    expect(localStorage.getItem("kai_music_dimmed")).toBe("true");
    expect(onBtn.classList.contains("active-on")).toBe(true);

    // Action buttons inside .music-controls are always present
    const controls = container.querySelector(".music-controls");
    expect(controls).not.toBeNull();
    expect(controls?.querySelector(".music-play")).not.toBeNull();

    // Screen resize button toggles between expanded and default 360x540 size
    const screenBtn = container.querySelector(
      "button[aria-label='Reset player to default size'], button[aria-label='Expand player screen']"
    ) as HTMLButtonElement;
    expect(screenBtn).not.toBeNull();

    await act(async () => {
      screenBtn.click();
    });
    expect(dialog.style.width).toBe("360px");
    expect(dialog.style.height).toBe("540px");
    expect(localStorage.getItem("kai_music_panel_width")).toBe("360");
    expect(localStorage.getItem("kai_music_panel_height")).toBe("540");
  });
});
