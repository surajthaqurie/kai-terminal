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

  it("turning loop off afterwards resumes the list from the new song", async () => {
    await playListLink();
    await click("Enable loop");
    await click("Next song");
    await click("Disable loop");
    expect(frameSrc()).toContain("/embed/9bZkp7q5F5I?");
    expect(frameSrc()).toContain("&list=RDAMVMdQw4w9WgXcQ");
    expect(frameSrc()).not.toContain("loop=1");
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
