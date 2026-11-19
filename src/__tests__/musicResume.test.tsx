// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";

const emitPip = vi.fn(async (_event: string, _payload?: unknown) => {});
let pipListeners: Record<string, (data: unknown) => void> = {};

vi.mock("../services/ptyService", () => ({ isTauriAvailable: () => true }));
vi.mock("../services/musicPip", async (importActual) => ({
  ...(await importActual<typeof import("../services/musicPip")>()),
  emitPip: (event: string, payload?: unknown) => emitPip(event, payload),
  openMusicPip: async () => true,
  closeMusicPip: async () => {},
  listenPip: async (event: string, cb: (data: unknown) => void) => {
    pipListeners[event] = cb;
    return () => {};
  },
}));

import { MusicPanel } from "../components/MusicPlayer/MusicPanel";
import { PIP_EVENTS, type PipState } from "../services/musicPip";

const LINK = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

describe("resuming the video after it moves to the mini window", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    emitPip.mockClear();
    pipListeners = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => [] }))
    );
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    vi.useRealTimers();
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  const $ = <T extends Element>(sel: string) => container.querySelector(sel) as T;

  const render = async () => {
    await act(async () => {
      root.render(<MusicPanel startMuted={false} open onClose={vi.fn()} />);
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

  /** Telemetry from the docked embed (a window message from YouTube). */
  const dockedTelemetry = async (info: Record<string, unknown>) => {
    const frame = $<HTMLIFrameElement>("iframe.music-video");
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent("message", {
          origin: "https://www.youtube-nocookie.com",
          source: frame.contentWindow,
          data: JSON.stringify({ event: "infoDelivery", info }),
        })
      );
    });
  };

  /** Telemetry relayed from the mini window's embed. */
  const miniTelemetry = async (info: Record<string, unknown>) => {
    await act(async () => {
      pipListeners[PIP_EVENTS.message]?.(JSON.stringify({ event: "infoDelivery", info }));
    });
  };

  const popOut = async () => {
    await act(async () => {
      $<HTMLButtonElement>("button[aria-label='Pop out mini player']").click();
    });
  };

  /** Player commands sent to the mini window so far, in order. */
  const sentCommands = () =>
    emitPip.mock.calls
      .filter(([event]) => event === PIP_EVENTS.command)
      .map(([, payload]) => {
        const { func, args } = JSON.parse(String(payload)) as { func: string; args: unknown };
        return { func, args };
      });

  const lastState = () => {
    const states = emitPip.mock.calls.filter(([event]) => event === PIP_EVENTS.state);
    return states[states.length - 1][1] as PipState;
  };

  it("a paused song resumes at its exact fraction, silently, and stays paused", async () => {
    await render();
    await paste(LINK);
    await dockedTelemetry({ currentTime: 42.6, duration: 200, playerState: 2 });
    await popOut();
    expect(sentCommands()).toEqual([]);

    // The reloaded embed answers with the whole second it was told to start at.
    await miniTelemetry({ currentTime: 42, playerState: 5 });
    expect(sentCommands()).toEqual([
      { func: "mute", args: "" },
      { func: "seekTo", args: [42.6, true] },
      { func: "pauseVideo", args: "" },
    ]);

    // The pause landed: the sound comes back.
    await miniTelemetry({ playerState: 2 });
    expect(sentCommands().map((c) => c.func)).toEqual(["mute", "seekTo", "pauseVideo", "unMute"]);
    // Done once: a later report does not seek again.
    await miniTelemetry({ currentTime: 42.6, playerState: 2 });
    expect(sentCommands()).toHaveLength(4);
  });

  it("a paused song the user had muted stays muted", async () => {
    await render();
    await paste(LINK);
    await dockedTelemetry({ currentTime: 10.5, duration: 200, playerState: 2 });
    await act(async () => {
      $<HTMLButtonElement>("button[aria-label='Mute']").click();
    });
    await popOut();
    emitPip.mockClear();
    await miniTelemetry({ currentTime: 10, playerState: 5 });
    await miniTelemetry({ playerState: 2 });
    expect(sentCommands().map((c) => c.func)).not.toContain("unMute");
  });

  it("restores the sound after a moment even if the pause is never reported", async () => {
    await render();
    await paste(LINK);
    await dockedTelemetry({ currentTime: 42.6, duration: 200, playerState: 2 });
    await popOut();
    await miniTelemetry({ currentTime: 42, playerState: 5 });
    expect(sentCommands().map((c) => c.func)).not.toContain("unMute");
    await act(async () => {
      await new Promise((r) => setTimeout(r, 1700));
    });
    expect(sentCommands().map((c) => c.func)).toContain("unMute");
  });

  /** Commands posted straight to the docked (possibly parked) embed. */
  const spyDocked = () => {
    const frame = $<HTMLIFrameElement>("iframe.music-video");
    const spy = vi.spyOn(frame.contentWindow as Window, "postMessage");
    return {
      frame,
      funcs: () =>
        spy.mock.calls
          .map(([msg]) => {
            try {
              return (JSON.parse(String(msg)) as { func?: string }).func;
            } catch {
              return undefined;
            }
          })
          .filter(Boolean),
    };
  };

  it("a playing song keeps playing in the player until the mini window's video plays", async () => {
    await render();
    await paste(LINK);
    await dockedTelemetry({ currentTime: 42.6, duration: 200, playerState: 1 });
    const docked = spyDocked();
    await popOut();

    // The mini window loads muted at the spot; the docked embed is not paused.
    const state = lastState();
    expect(state.src).toContain("start=42");
    expect(state.src).toContain("mute=1");
    expect(state.muted).toBe(true);
    expect(state.buffering).toBe(false);
    expect(docked.funcs()).not.toContain("pauseVideo");
    // ...and stays loaded (parked), not destroyed.
    expect($("iframe.music-video.music-video-parked")).toBe(docked.frame);

    // Its time keeps coming from the docked embed meanwhile.
    await dockedTelemetry({ currentTime: 44 });
    expect(lastState().currentTime).toBe(44);
    // A warm-up report from the mini window changes nothing yet.
    await miniTelemetry({ currentTime: 42, playerState: 3 });
    expect(sentCommands()).toEqual([]);

    // It plays: it takes over at the docked position, with sound.
    await miniTelemetry({ currentTime: 42.1, playerState: 1 });
    expect(docked.funcs()).toContain("pauseVideo");
    const cmds = sentCommands();
    expect(cmds.map((c) => c.func)).toEqual(["seekTo", "setVolume", "unMute", "playVideo"]);
    expect((cmds[0].args as number[])[0]).toBeGreaterThanOrEqual(44);
    expect(lastState().muted).toBe(false);

    // From now on the parked docked embed is ignored.
    await dockedTelemetry({ playerState: 2 });
    expect(lastState().playing).toBe(true);
  });

  it("the mini window takes over after a while even if its video never reports", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    await render();
    await paste(LINK);
    await dockedTelemetry({ currentTime: 10, duration: 200, playerState: 1 });
    const docked = spyDocked();
    await popOut();
    await act(async () => {
      vi.advanceTimersByTime(8100);
    });
    expect(docked.funcs()).toContain("pauseVideo");
    expect(sentCommands().map((c) => c.func)).toContain("unMute");
  });

  it("pops out the song a YouTube Music list is on now, not the list's first song", async () => {
    await render();
    await paste("https://music.youtube.com/watch?v=dQw4w9WgXcQ&list=RDAMVMdQw4w9WgXcQ");
    // YouTube advanced inside the list to another song.
    await dockedTelemetry({
      currentTime: 30,
      duration: 200,
      playerState: 1,
      videoData: { video_id: "9bZkp7q5F5I", title: "Next song" },
    });
    await popOut();
    const src = lastState().src ?? "";
    expect(src).toContain("/embed/9bZkp7q5F5I?");
    expect(src).toContain("list=RDAMVMdQw4w9WgXcQ");
    expect(src).toContain("start=30");
  });

  it("bringing the video back reuses the parked embed: no reload, just seek and play", async () => {
    await render();
    await paste(LINK);
    await dockedTelemetry({ currentTime: 42.6, duration: 200, playerState: 1 });
    const docked = spyDocked();
    await popOut();
    await miniTelemetry({ currentTime: 42.6, playerState: 1 });
    await miniTelemetry({ currentTime: 80 });

    await act(async () => {
      $<HTMLButtonElement>("button[aria-label='Close mini player window']").click();
    });
    const frame = $<HTMLIFrameElement>("iframe.music-video");
    expect(frame).toBe(docked.frame);
    expect(frame.classList.contains("music-video-parked")).toBe(false);
    expect(frame.src).not.toContain("start=");
    expect(docked.funcs().slice(-4)).toEqual(["seekTo", "setVolume", "unMute", "playVideo"]);
  });

  it("a song that changed while popped out is rebuilt in the player at its spot", async () => {
    await render();
    await paste(LINK);
    await dockedTelemetry({ currentTime: 5, duration: 200, playerState: 2 });
    await popOut();
    await paste("https://www.youtube.com/watch?v=9bZkp7q5F5I");
    // The new song plays in the mini window; the parked embed is dropped.
    expect(lastState().src).toContain("/embed/9bZkp7q5F5I?");
    expect($("iframe.music-video")).toBeNull();
    await miniTelemetry({ currentTime: 12.4, duration: 100, playerState: 1 });

    await act(async () => {
      $<HTMLButtonElement>("button[aria-label='Close mini player window']").click();
    });
    const frame = $<HTMLIFrameElement>("iframe.music-video");
    expect(frame.src).toContain("/embed/9bZkp7q5F5I?");
    expect(frame.src).toContain("start=12");
  });

  it("does not show buffering for a paused song, or when nothing was playing", async () => {
    await render();
    await paste(LINK);
    await dockedTelemetry({ currentTime: 42.6, duration: 200, playerState: 2 });
    await popOut();
    expect(lastState().buffering).toBe(false);
  });
});
