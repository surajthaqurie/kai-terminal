// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { MusicPanel } from "../components/MusicPlayer/MusicPanel";
import { relatedSearchSeed, type MusicTrack } from "../services/musicService";

const track = (over: Partial<MusicTrack>): MusicTrack => ({
  title: "YouTube video",
  videoId: "dQw4w9WgXcQ",
  playlistId: null,
  query: "",
  ...over,
});

describe("relatedSearchSeed", () => {
  it("is null without a track", () => {
    expect(relatedSearchSeed(null)).toBeNull();
  });

  it("uses plain words as they are (a search result's query is its title)", () => {
    expect(relatedSearchSeed(track({ title: "Song A", query: "lofi study beats" }))).toBe(
      "lofi study beats"
    );
  });

  it("never seeds with a pasted link or a bare id: that search only returns the playing video", () => {
    const link = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
    expect(relatedSearchSeed(track({ query: link }))).toBeNull();
    expect(relatedSearchSeed(track({ query: "https://youtu.be/dQw4w9WgXcQ" }))).toBeNull();
    expect(relatedSearchSeed(track({ query: "dQw4w9WgXcQ" }))).toBeNull();
  });

  it("falls back to the real title once YouTube reported it", () => {
    const link = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
    expect(
      relatedSearchSeed(track({ query: link, title: "Rick Astley - Never Gonna Give You Up" }))
    ).toBe("Rick Astley - Never Gonna Give You Up");
    expect(relatedSearchSeed(track({ query: "jfKfPfyJRdk", title: "Lofi Hip Hop Radio" }))).toBe(
      "Lofi Hip Hop Radio"
    );
  });

  it("ignores the placeholder titles", () => {
    expect(relatedSearchSeed(track({ query: "dQw4w9WgXcQ", title: "YouTube video" }))).toBeNull();
    expect(
      relatedSearchSeed(track({ query: "dQw4w9WgXcQ", title: "YouTube Playlist" }))
    ).toBeNull();
    expect(relatedSearchSeed(track({ query: "dQw4w9WgXcQ", title: "   " }))).toBeNull();
  });
});

describe("MusicPanel: Next after a pasted link", () => {
  let container: HTMLDivElement;
  let root: Root;
  let searched: string[];
  const RELATED = [
    { videoId: "relat111111", title: "Related One" },
    { videoId: "relat222222", title: "Related Two" },
  ];

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    searched = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const q = new URL(url, "http://localhost").searchParams.get("q") ?? "";
        searched.push(q);
        // What the real search does for an input holding a video id: only that video.
        const own = q.includes("dQw4w9WgXcQ")
          ? [{ videoId: "dQw4w9WgXcQ", title: "YouTube Video" }]
          : RELATED;
        return { ok: true, json: async () => own };
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

  const paste = async (value: string) => {
    const input = container.querySelector(".music-search input") as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      (container.querySelector(".music-search") as HTMLFormElement).dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true })
      );
    });
  };

  const reportTitle = async (title: string) => {
    const frame = container.querySelector("iframe.music-video") as HTMLIFrameElement;
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent("message", {
          origin: "https://www.youtube-nocookie.com",
          source: frame.contentWindow,
          data: JSON.stringify({
            event: "infoDelivery",
            info: { playerState: 1, videoData: { title } },
          }),
        })
      );
    });
    await act(async () => {});
  };

  it("fetches related songs with the real title, not the link, and Next moves to a different song", async () => {
    const onTrackChange = vi.fn();
    await act(async () => {
      root.render(
        <MusicPanel startMuted={false} open onClose={vi.fn()} onTrackChange={onTrackChange} />
      );
    });

    await paste("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    // Nothing useful can be searched yet: the link/id would only find this video.
    expect(searched).toEqual([]);

    await reportTitle("Rick Astley - Never Gonna Give You Up");
    expect(searched).toEqual(["Rick Astley - Never Gonna Give You Up"]);

    await act(async () => {
      (container.querySelector('[aria-label="Next song"]') as HTMLButtonElement).click();
    });
    await act(async () => {});
    const last = onTrackChange.mock.calls[onTrackChange.mock.calls.length - 1][0] as MusicTrack;
    expect(last.videoId).toBe("relat111111");
    expect(last.title).toBe("Related One");
  });

  it("does not search again just because the queue changed contents", async () => {
    await act(async () => {
      root.render(<MusicPanel startMuted={false} open onClose={vi.fn()} />);
    });
    await paste("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    await reportTitle("Some Real Title");
    expect(searched).toEqual(["Some Real Title"]);
    await reportTitle("Some Real Title");
    expect(searched).toEqual(["Some Real Title"]);
  });
});
