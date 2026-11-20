// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";

vi.mock("../services/ptyService", () => ({ isTauriAvailable: () => false }));

import { MusicPanel } from "../components/MusicPlayer/MusicPanel";

/**
 * Regression: with loop on, a song from a YouTube Music list plays in a
 * one-song loop embed (`loop=1&playlist=<id>`, no `list=`). Next used to send
 * YouTube `nextVideo`, which in that embed restarts the same song.
 */
const LIST_LINK = "https://music.youtube.com/watch?v=dQw4w9WgXcQ&list=RDAMVMdQw4w9WgXcQ";
const LIST = [
  { videoId: "dQw4w9WgXcQ", title: "First song" },
  { videoId: "9bZkp7q5F5I", title: "Second song" },
  { videoId: "kJQP7kiw5Fk", title: "Third song" },
];

describe("Next with loop on", () => {
  let container: HTMLDivElement;
  let root: Root;
  let playlistFetches = 0;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    playlistFetches = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).startsWith("/api/youtube-playlist")) {
          playlistFetches += 1;
          return { ok: true, json: async () => LIST };
        }
        return { ok: true, json: async () => [] };
      })
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
  const frameSrc = () => $<HTMLIFrameElement>("iframe.music-video")?.src ?? "";
  const click = async (label: string) => {
    await act(async () => {
      $<HTMLButtonElement>(`button[aria-label='${label}']`).click();
    });
  };

  const playListLink = async () => {
    await act(async () => {
      root.render(<MusicPanel startMuted={false} open onClose={vi.fn()} />);
    });
    const input = $<HTMLInputElement>(".music-search input");
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(input, LIST_LINK);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      $<HTMLFormElement>(".music-search").dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true })
      );
    });
  };

  it("moves to the list's next song and keeps looping it", async () => {
    await playListLink();
    await click("Enable loop");
    expect(frameSrc()).toContain("/embed/dQw4w9WgXcQ?");
    expect(frameSrc()).toContain("loop=1&playlist=dQw4w9WgXcQ");

    await click("Next song");
    expect(frameSrc()).toContain("/embed/9bZkp7q5F5I?");
    expect(frameSrc()).toContain("loop=1&playlist=9bZkp7q5F5I");
    expect(frameSrc()).not.toContain("&list=");

    await click("Next song");
    expect(frameSrc()).toContain("/embed/kJQP7kiw5Fk?");
    // The list is loaded once, not on every Next.
    expect(playlistFetches).toBe(1);
  });

  it("keeps going past the songs a mix was first loaded with", async () => {
    // A mix (`list=RD…`) only lists the songs around the one it is asked about.
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const u = String(url);
        if (!u.startsWith("/api/youtube-playlist")) return { ok: true, json: async () => [] };
        urls.push(u);
        const seed = new URL(u, "http://x").searchParams.get("v");
        return {
          ok: true,
          json: async () =>
            seed === "kJQP7kiw5Fk"
              ? [LIST[2], { videoId: "OPf0YbXqDm0", title: "Fourth song" }]
              : LIST,
        };
      })
    );
    await playListLink();
    await click("Enable loop");
    await click("Next song");
    await click("Next song");
    expect(frameSrc()).toContain("/embed/kJQP7kiw5Fk?");

    await click("Next song");
    expect(frameSrc()).toContain("/embed/OPf0YbXqDm0?");
    expect(frameSrc()).toContain("loop=1&playlist=OPf0YbXqDm0");
    expect(urls[0]).toContain("&v=dQw4w9WgXcQ");
    expect(urls[1]).toContain("&v=kJQP7kiw5Fk");
  });

  /** A report from the docked embed, as YouTube posts it. */
  const report = async (data: unknown) => {
    const frame = $<HTMLIFrameElement>("iframe.music-video");
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify(data),
          origin: "https://www.youtube-nocookie.com",
          source: frame.contentWindow,
        })
      );
    });
  };

  it("turning loop off lets the song play on, then resumes the list after it", async () => {
    await playListLink();
    await click("Enable loop");
    await click("Next song");
    const looping = frameSrc();
    await click("Disable loop");
    // No reload mid-song: reloading YouTube cut the sound for seconds.
    expect(frameSrc()).toBe(looping);

    await report({ event: "onStateChange", info: 0 });
    expect(frameSrc()).toContain("/embed/kJQP7kiw5Fk?");
    expect(frameSrc()).toContain("&list=RDAMVMdQw4w9WgXcQ");
    expect(frameSrc()).not.toContain("loop=1");
  });

  it("notices the end of the song when the loop embed restarts it without saying so", async () => {
    await playListLink();
    await click("Enable loop");
    await click("Next song");
    await click("Disable loop");
    await report({ event: "infoDelivery", info: { currentTime: 199, duration: 200 } });
    await report({ event: "infoDelivery", info: { currentTime: 0.4 } });
    expect(frameSrc()).toContain("/embed/kJQP7kiw5Fk?");
    expect(frameSrc()).not.toContain("loop=1");
  });

  it("switching loop back on before the song ends keeps looping it", async () => {
    await playListLink();
    await click("Enable loop");
    await click("Next song");
    const looping = frameSrc();
    await click("Disable loop");
    await click("Enable loop");
    await report({ event: "onStateChange", info: 0 });
    expect(frameSrc()).toBe(looping);
  });

  it("ignores more Next presses while the next song is still being found", async () => {
    const pending: (() => void)[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (!String(url).startsWith("/api/youtube-playlist"))
          return { ok: true, json: async () => [] };
        playlistFetches += 1;
        await new Promise<void>((r) => pending.push(r));
        return { ok: true, json: async () => LIST };
      })
    );
    await playListLink();
    await click("Enable loop"); // starts fetching the list ahead (still pending)
    await act(async () => {
      for (let i = 0; i < 3; i++) {
        $<HTMLButtonElement>("button[aria-label='Next song']").click();
      }
    });
    // The look-ahead fetch plus ONE for Next, not one per press.
    expect(playlistFetches).toBe(2);
    await act(async () => pending.forEach((r) => r()));
    expect(frameSrc()).toContain("/embed/9bZkp7q5F5I?");
  });

  it("without loop, Next still lets YouTube advance inside the list", async () => {
    await playListLink();
    const frame = $<HTMLIFrameElement>("iframe.music-video");
    const post = vi.fn();
    Object.defineProperty(frame, "contentWindow", { value: { postMessage: post } });
    const before = frameSrc();
    await click("Next song");
    expect(frameSrc()).toBe(before);
    expect(post.mock.calls.map(([m]) => JSON.parse(String(m)).func)).toContain("nextVideo");
    expect(playlistFetches).toBe(0);
  });
});
