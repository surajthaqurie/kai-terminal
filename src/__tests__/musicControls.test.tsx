// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { MusicPanel } from "../components/MusicPlayer/MusicPanel";
import { youtubeCommand } from "../services/musicService";

const LINK = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

describe("MusicPanel action buttons", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    // Related-song search is best-effort; keep it off the network.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => [] }))
    );
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  const $ = <T extends Element>(sel: string) => container.querySelector(sel) as T;
  const byLabel = (label: string) => $<HTMLButtonElement>(`[aria-label="${label}"]`);

  const render = async (props: Partial<Parameters<typeof MusicPanel>[0]> = {}) => {
    await act(async () => {
      root.render(<MusicPanel startMuted={false} open onClose={vi.fn()} {...props} />);
    });
  };

  const paste = async (value: string) => {
    const input = $<HTMLInputElement>(".music-search input");
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      $<HTMLFormElement>(".music-search").dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true })
      );
    });
  };

  const telemetry = async (data: unknown) => {
    const frame = $<HTMLIFrameElement>("iframe.music-video");
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent("message", {
          origin: "https://www.youtube-nocookie.com",
          source: frame.contentWindow,
          data: JSON.stringify(data),
        })
      );
    });
  };

  /** Commands posted to the player iframe from now on. */
  const spyOnPlayer = () => {
    const frame = $<HTMLIFrameElement>("iframe.music-video");
    const spy = vi.spyOn(frame.contentWindow!, "postMessage");
    return {
      spy,
      funcs: () =>
        spy.mock.calls
          .map((c) => String(c[0]))
          .filter((m) => m.includes('"command"'))
          .map((m) => (JSON.parse(m) as { func: string }).func),
    };
  };

  const click = async (el: HTMLElement) => {
    await act(async () => {
      el.click();
    });
  };

  it("play/pause, mute and loop reach the player as commands and update the UI", async () => {
    await render();
    await paste(LINK);
    const player = spyOnPlayer();

    expect(byLabel("Pause")).not.toBeNull(); // autoplay: playing
    await click(byLabel("Pause"));
    expect(player.funcs()).toContain("pauseVideo");
    expect(byLabel("Play")).not.toBeNull();

    await click(byLabel("Play"));
    expect(player.funcs()).toContain("playVideo");
    expect(byLabel("Pause")).not.toBeNull();

    await click(byLabel("Mute"));
    expect(player.funcs()).toContain("mute");
    await click(byLabel("Unmute"));
    expect(player.funcs()).toContain("unMute");

    expect(byLabel("Enable loop").getAttribute("aria-pressed")).toBe("false");
    await click(byLabel("Enable loop"));
    expect(byLabel("Disable loop").getAttribute("aria-pressed")).toBe("true");
  });

  it("the footer's window events drive the same commands", async () => {
    await render();
    await paste(LINK);
    const player = spyOnPlayer();

    await act(async () => {
      window.dispatchEvent(new CustomEvent("kai-music-toggle-play"));
    });
    expect(player.funcs()).toContain("pauseVideo");
    await act(async () => {
      window.dispatchEvent(new CustomEvent("kai-music-mute"));
    });
    expect(player.funcs()).toContain("mute");
  });

  it("volume and seek sliders post setVolume / seekTo", async () => {
    await render();
    await paste(LINK);
    await telemetry({ event: "infoDelivery", info: { playerState: 1, duration: 200 } });
    const player = spyOnPlayer();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    const slide = async (el: HTMLInputElement, v: string) => {
      await act(async () => {
        setter.call(el, v);
        el.dispatchEvent(new Event("input", { bubbles: true }));
      });
    };

    await slide($<HTMLInputElement>(".music-volume-slider"), "30");
    expect(player.funcs()).toContain("setVolume");
    await slide($<HTMLInputElement>(".music-progress-slider"), "50");
    expect(player.funcs()).toContain("seekTo");
    const seek = player.spy.mock.calls
      .map((c) => JSON.parse(String(c[0])) as { func: string; args: unknown })
      .find((m) => m.func === "seekTo");
    expect(seek?.args).toEqual([100, true]);
    expect(youtubeCommand("seekTo", [100, true])).toContain('"seekTo"');
  });

  it("button tooltips list the in-panel key and the current global shortcut", async () => {
    await render({
      shortcutHints: {
        toggle: "Ctrl+Shift+M",
        playPause: "Ctrl+Shift+Space",
        previous: "Ctrl+Shift+,",
        next: "Ctrl+Alt+N", // a remapped key shows up as remapped
        mute: "Ctrl+Shift+0",
      },
    });
    await paste(LINK);
    const title = (label: string) => byLabel(label).getAttribute("title");
    expect(title("Previous song")).toBe("Previous song (P or Ctrl+Shift+,)");
    expect(title("Pause")).toBe("Play / pause (Space or Ctrl+Shift+Space)");
    expect(title("Next song")).toContain("(N or Ctrl+Alt+N)");
    expect(title("Mute")).toBe("Mute (M or Ctrl+Shift+0)");
  });

  it("tooltips still work without any hints", async () => {
    await render();
    await paste(LINK);
    expect(byLabel("Previous song").getAttribute("title")).toBe("Previous song (P)");
    expect(byLabel("Mute").getAttribute("title")).toBe("Mute (M)");
  });

  describe("dim popover", () => {
    const press = async (el: HTMLElement) => {
      // A real click is mousedown then click; the outside-press handler listens to mousedown.
      await act(async () => {
        el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      });
      await act(async () => {
        el.click();
      });
    };

    it("the dim button opens the popover and a second press closes it", async () => {
      await render();
      const trigger = () => $<HTMLButtonElement>("[aria-label^='Dim player opacity']");
      expect($(".music-dim-popover")).toBeNull();
      await press(trigger());
      expect($(".music-dim-popover")).not.toBeNull();
      await press(trigger());
      expect($(".music-dim-popover")).toBeNull();
    });

    it("a press elsewhere still closes it, and a press inside it keeps it open", async () => {
      await render();
      await press($<HTMLButtonElement>("[aria-label^='Dim player opacity']"));
      await press($<HTMLButtonElement>(".music-dim-preset-chip"));
      expect($(".music-dim-popover")).not.toBeNull();
      await act(async () => {
        document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      });
      expect($(".music-dim-popover")).toBeNull();
    });
  });

  describe("when YouTube refuses the video", () => {
    it("Next never flips the button to Pause for a video that cannot play", async () => {
      await render();
      await paste(LINK);
      await telemetry({ event: "onError", info: 101 });
      expect($(".music-notice")?.textContent).toMatch(/doesn't allow/i);
      expect(byLabel("Play")).not.toBeNull();

      await click(byLabel("Next song"));
      await click(byLabel("Previous song"));
      expect(byLabel("Play")).not.toBeNull();
      expect(byLabel("Pause")).toBeNull();
      expect($(".music-notice")?.textContent).toMatch(/doesn't allow/i);
    });
  });

  describe("when the page origin cannot control the embed (tauri:// scheme)", () => {
    const originalLocation = window.location;
    afterEach(() => {
      Object.defineProperty(window, "location", {
        value: originalLocation,
        writable: true,
        configurable: true,
      });
    });

    it("tells the user instead of showing silently dead buttons", async () => {
      Object.defineProperty(window, "location", {
        value: new URL("tauri://localhost"),
        writable: true,
        configurable: true,
      });
      await render();
      await paste(LINK);
      expect($(".music-notice")?.textContent).toMatch(/can't remote-control/i);
      expect($<HTMLIFrameElement>("iframe.music-video").src).toContain("controls=1");
    });

    it("stays quiet on a normal web origin such as http://tauri.localhost", async () => {
      Object.defineProperty(window, "location", {
        value: new URL("http://tauri.localhost/"),
        writable: true,
        configurable: true,
      });
      await render();
      await paste(LINK);
      expect($(".music-notice")).toBeNull();
      expect($<HTMLIFrameElement>("iframe.music-video").src).toContain("controls=0");
    });
  });
});
