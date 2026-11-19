// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";

vi.mock("../services/ptyService", () => ({ isTauriAvailable: () => false }));

import { MusicPanel } from "../components/MusicPlayer/MusicPanel";

const SONG_A = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const SONG_B = "https://www.youtube.com/watch?v=9bZkp7q5F5I";
const LIST_LINK = "https://music.youtube.com/watch?v=dQw4w9WgXcQ&list=RDAMVMdQw4w9WgXcQ";
const LIST = [
  { videoId: "dQw4w9WgXcQ", title: "First song" },
  { videoId: "9bZkp7q5F5I", title: "Second song" },
  { videoId: "kJQP7kiw5Fk", title: "Third song" },
];

describe("Previous button", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => ({
        ok: true,
        json: async () => (String(url).startsWith("/api/youtube-playlist") ? LIST : []),
      }))
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
  const frame = () => $<HTMLIFrameElement>("iframe.music-video");
  const frameSrc = () => frame()?.src ?? "";
  const click = async (label: string) => {
    await act(async () => {
      $<HTMLButtonElement>(`button[aria-label='${label}']`).click();
    });
  };

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

  /** Telemetry from the embed, as YouTube posts it. */
  const telemetry = async (info: Record<string, unknown>) => {
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent("message", {
          origin: "https://www.youtube-nocookie.com",
          source: frame().contentWindow,
          data: JSON.stringify({ event: "infoDelivery", info }),
        })
      );
    });
  };

  /** Commands posted to the current embed from now on. */
  const spyCommands = () => {
    const spy = vi.spyOn(frame().contentWindow!, "postMessage");
    return () =>
      spy.mock.calls
        .map(([m]) => {
          try {
            return JSON.parse(String(m)).func as string;
          } catch {
            return "";
          }
        })
        .filter(Boolean);
  };

  it("goes back to the song played before, and Next returns to the one left", async () => {
    await render();
    await paste(SONG_A);
    await paste(SONG_B);
    expect(frameSrc()).toContain("/embed/9bZkp7q5F5I?");

    await click("Previous song");
    expect(frameSrc()).toContain("/embed/dQw4w9WgXcQ?");

    await click("Next song");
    expect(frameSrc()).toContain("/embed/9bZkp7q5F5I?");
  });

  it("restarts the song instead when it has played more than a few seconds", async () => {
    await render();
    await paste(SONG_A);
    await paste(SONG_B);
    await telemetry({ currentTime: 40, duration: 200, playerState: 1 });
    const commands = spyCommands();

    await click("Previous song");
    expect(frameSrc()).toContain("/embed/9bZkp7q5F5I?");
    expect(commands()).toContain("seekTo");
  });

  it("steps back inside a list YouTube has advanced", async () => {
    await render();
    await paste(LIST_LINK);
    await telemetry({
      currentTime: 1,
      playerState: 1,
      videoData: { video_id: "9bZkp7q5F5I", title: "Second song" },
    });
    const before = frameSrc();
    const commands = spyCommands();

    await click("Previous song");
    expect(commands()).toContain("previousVideo");
    expect(frameSrc()).toBe(before);
  });

  it("returns to a song from a list, at the song the list was on", async () => {
    await render();
    await paste(LIST_LINK);
    await telemetry({
      currentTime: 1,
      playerState: 1,
      videoData: { video_id: "9bZkp7q5F5I", title: "Second song" },
    });
    await paste(SONG_A.replace("dQw4w9WgXcQ", "kJQP7kiw5Fk"));

    await click("Previous song");
    expect(frameSrc()).toContain("/embed/9bZkp7q5F5I?");
    expect(frameSrc()).toContain("&list=RDAMVMdQw4w9WgXcQ");
  });

  it("with loop on, goes back to the list's earlier song and keeps looping", async () => {
    await render();
    await paste(LIST_LINK);
    await click("Enable loop");
    await click("Next song");
    expect(frameSrc()).toContain("/embed/9bZkp7q5F5I?");

    await click("Previous song");
    expect(frameSrc()).toContain("/embed/dQw4w9WgXcQ?");
    expect(frameSrc()).toContain("loop=1&playlist=dQw4w9WgXcQ");
  });

  it("with nothing earlier, restarts the current song", async () => {
    await render();
    await paste(SONG_A);
    const before = frameSrc();
    const commands = spyCommands();
    await click("Previous song");
    expect(frameSrc()).toBe(before);
    expect(commands()).toContain("seekTo");
  });
});

describe("Previous and Next around lists (review regressions)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => ({
        ok: true,
        json: async () => (String(url).startsWith("/api/youtube-playlist") ? LIST : []),
      }))
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
  const frame = () => $<HTMLIFrameElement>("iframe.music-video");
  const frameSrc = () => frame()?.src ?? "";
  const click = async (label: string) => {
    await act(async () => {
      $<HTMLButtonElement>(`button[aria-label='${label}']`).click();
    });
  };
  const start = async () => {
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
  const telemetry = async (info: Record<string, unknown>) => {
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent("message", {
          origin: "https://www.youtube-nocookie.com",
          source: frame().contentWindow,
          data: JSON.stringify({ event: "infoDelivery", info }),
        })
      );
    });
  };
  const SONG_X = "https://www.youtube.com/watch?v=kJQP7kiw5Fk";

  it("Next after going back to a list song returns to the song that was left", async () => {
    await start();
    await paste(LIST_LINK);
    await paste(SONG_X);
    await click("Previous song");
    expect(frameSrc()).toContain("&list=RDAMVMdQw4w9WgXcQ");
    await click("Next song");
    expect(frameSrc()).toContain("/embed/kJQP7kiw5Fk?");
    expect(frameSrc()).not.toContain("&list=");
  });

  it("on a bare playlist's first song, Previous goes back to the song before it", async () => {
    await start();
    await paste(SONG_X);
    await paste("https://www.youtube.com/playlist?list=PLabcdefghij123");
    expect(frameSrc()).toContain("listType=playlist&list=PLabcdefghij123");
    await telemetry({ currentTime: 1, playerState: 1, videoData: { video_id: "dQw4w9WgXcQ" } });
    await click("Previous song");
    expect(frameSrc()).toContain("/embed/kJQP7kiw5Fk?");
  });

  it("with loop on, Next on the list's last song carries on from its first", async () => {
    await start();
    await paste(LIST_LINK.replace("v=dQw4w9WgXcQ", "v=kJQP7kiw5Fk"));
    await click("Enable loop");
    await click("Next song");
    expect(frameSrc()).toContain("/embed/dQw4w9WgXcQ?");
    expect(frameSrc()).toContain("loop=1&playlist=dQw4w9WgXcQ");
  });

  it("with loop on, a song missing from the loaded list never jumps to its start", async () => {
    await start();
    await paste(LIST_LINK.replace("v=dQw4w9WgXcQ", "v=aaaaaaaaaaa"));
    await click("Enable loop");
    await click("Next song");
    expect(frameSrc()).not.toContain("/embed/dQw4w9WgXcQ?");
  });
});
