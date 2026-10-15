// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  clearLegacyQueue,
  embedSrcForTrack,
  extractPlaylistId,
  hasNextItem,
  parseYouTubePlayerMessage,
  resolveInputToTrack,
  watchUrlForTrack,
  youtubeCommand,
} from "../services/musicService";

describe("music input resolution", () => {
  it("resolves a video link, a playlist link and plain text", () => {
    const v = resolveInputToTrack("https://youtu.be/dQw4w9WgXcQ");
    expect(v).toMatchObject({ videoId: "dQw4w9WgXcQ", playlistId: null });
    const p = resolveInputToTrack("https://www.youtube.com/playlist?list=PLabcdefghijkl");
    expect(p).toMatchObject({ videoId: null, playlistId: "PLabcdefghijkl" });
    const both = resolveInputToTrack(
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLabcdefghijkl"
    );
    expect(both).toMatchObject({ videoId: "dQw4w9WgXcQ", playlistId: "PLabcdefghijkl" });
    expect(resolveInputToTrack("lofi beats")).toMatchObject({ videoId: null, title: "lofi beats" });
    expect(resolveInputToTrack("   ")).toBeNull();
    // unparseable YouTube link is rejected, not searched
    expect(resolveInputToTrack("https://www.youtube.com/channel/abc")).toBeNull();
  });

  it("only reads list= from YouTube links", () => {
    expect(extractPlaylistId("https://example.com/?list=PLabcdefghijkl")).toBeNull();
  });

  it("builds embeds and only sends mute at load", () => {
    const t = resolveInputToTrack("dQw4w9WgXcQ")!;
    expect(embedSrcForTrack(t)).not.toContain("mute=1");
    expect(embedSrcForTrack(t, true)).toContain("mute=1");
    expect(embedSrcForTrack(t)).toContain("enablejsapi=1");
    const pl = resolveInputToTrack("https://www.youtube.com/playlist?list=PLabcdefghijkl")!;
    expect(embedSrcForTrack(pl)).toContain("listType=playlist&list=PLabcdefghijkl");
  });

  it("uses youtube-nocookie.com and never leaks tauri:// origin to prevent Error 153", () => {
    const t = resolveInputToTrack("dQw4w9WgXcQ")!;
    const src = embedSrcForTrack(t)!;
    expect(src).toContain("youtube-nocookie.com/embed/dQw4w9WgXcQ");
    expect(src).not.toContain("origin=tauri");

    const originalLocation = window.location;
    try {
      Object.defineProperty(window, "location", {
        value: new URL("tauri://localhost"),
        writable: true,
        configurable: true,
      });
      const tauriSrc = embedSrcForTrack(t)!;
      expect(tauriSrc).toContain("youtube-nocookie.com/embed/dQw4w9WgXcQ");
      expect(tauriSrc).not.toContain("origin=tauri");
      expect(tauriSrc).toContain("widget_referrer=");
    } finally {
      Object.defineProperty(window, "location", {
        value: originalLocation,
        writable: true,
        configurable: true,
      });
    }
  });

  it("knows when YouTube can go to a next item", () => {
    expect(hasNextItem(null)).toBe(false);
    expect(hasNextItem(resolveInputToTrack("dQw4w9WgXcQ"))).toBe(false);
    // Plain song names are browser-search only (no embed), so there is no
    // in-player next item — only playlists have one.
    expect(hasNextItem(resolveInputToTrack("lofi beats"))).toBe(false);
    expect(
      hasNextItem(resolveInputToTrack("https://www.youtube.com/playlist?list=PLabcdefghijkl"))
    ).toBe(true);
  });
});

describe("open in browser URL", () => {
  it("uses only the shapes the backend allow-list accepts", () => {
    expect(watchUrlForTrack(resolveInputToTrack("dQw4w9WgXcQ")!)).toBe(
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
    );
    expect(
      watchUrlForTrack(resolveInputToTrack("https://www.youtube.com/playlist?list=PLabcdefghijkl")!)
    ).toBe("https://www.youtube.com/playlist?list=PLabcdefghijkl");
    expect(watchUrlForTrack(resolveInputToTrack("lofi  beats")!)).toBe(
      "https://www.youtube.com/results?search_query=lofi+beats"
    );
  });

  it("strips every shell metacharacter from search words", () => {
    const url = watchUrlForTrack(resolveInputToTrack('a&b|c^d%e"f<g>h && calc')!);
    expect(url).toBe("https://www.youtube.com/results?search_query=a+b+c+d+e+f+g+h+calc");
    expect(url.slice("https://www.youtube.com/results?search_query=".length)).toMatch(
      /^[\p{L}\p{M}\p{N}+._~-]+$/u
    );
  });

  it("keeps non-latin words and never produces an empty search", () => {
    expect(watchUrlForTrack(resolveInputToTrack("गीत songs")!)).toContain("search_query=गीत+songs");
    expect(watchUrlForTrack(resolveInputToTrack("क्ष")!)).toContain("search_query=क्ष");
    expect(watchUrlForTrack(resolveInputToTrack("!!!")!)).toBe(
      "https://www.youtube.com/results?search_query=music"
    );
  });
});

describe("embed control + telemetry", () => {
  it("builds YouTube command messages", () => {
    expect(JSON.parse(youtubeCommand("pauseVideo"))).toEqual({
      event: "command",
      func: "pauseVideo",
      args: "",
    });
  });

  it("reads the video title from infoDelivery, trimmed and capped", () => {
    const msg = JSON.stringify({
      event: "infoDelivery",
      info: { videoData: { title: `  ${"x".repeat(200)}  ` } },
    });
    expect(parseYouTubePlayerMessage(msg)?.title).toHaveLength(80);
    expect(
      parseYouTubePlayerMessage(
        JSON.stringify({ event: "infoDelivery", info: { videoData: { title: 5 } } })
      )
    ).toBeNull();
  });
});

describe("legacy queue cleanup", () => {
  it("removes the old stored queue and keeps nothing", () => {
    localStorage.setItem("kai_music_queue_v1", "[{}]");
    clearLegacyQueue();
    expect(localStorage.getItem("kai_music_queue_v1")).toBeNull();
  });
});
