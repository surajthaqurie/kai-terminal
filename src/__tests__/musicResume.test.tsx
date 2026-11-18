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

  it("a playing song still just seeks, with no mute", async () => {
    await render();
    await paste(LINK);
    await dockedTelemetry({ currentTime: 42.6, duration: 200, playerState: 1 });
    await popOut();
    await miniTelemetry({ currentTime: 42, playerState: 1 });
    expect(sentCommands()).toEqual([{ func: "seekTo", args: [42.6, true] }]);
  });

  it("a whole-second position needs no seek", async () => {
    await render();
    await paste(LINK);
    await dockedTelemetry({ currentTime: 42, duration: 200, playerState: 2 });
    await popOut();
    await miniTelemetry({ currentTime: 42, playerState: 5 });
    expect(sentCommands()).toEqual([]);
  });

  it("shows buffering during the reload gap of a playing song, and ends it at the first report", async () => {
    await render();
    await paste(LINK);
    await dockedTelemetry({ currentTime: 42.6, duration: 200, playerState: 1 });
    await popOut();
    expect(lastState().buffering).toBe(true);

    await miniTelemetry({ currentTime: 42, playerState: 1 });
    expect(lastState().buffering).toBe(false);
  });

  it("does not show buffering for a paused song, or when nothing was playing", async () => {
    await render();
    await paste(LINK);
    await dockedTelemetry({ currentTime: 42.6, duration: 200, playerState: 2 });
    await popOut();
    expect(lastState().buffering).toBe(false);
  });

  it("a video that never answers does not stay 'buffering' forever", async () => {
    await render();
    await paste(LINK);
    await dockedTelemetry({ currentTime: 42.6, duration: 200, playerState: 1 });
    await popOut();
    expect(lastState().buffering).toBe(true);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5200));
    });
    expect(lastState().buffering).toBe(false);
  }, 10000);
});
