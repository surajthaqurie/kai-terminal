// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  canControlEmbed,
  clearLegacyQueue,
  describePlayerError,
  embedSrcForTrack,
  extractPlaylistId,
  hasNextItem,
  isFavoriteTrack,
  loadFavorites,
  parseYouTubePlayerMessage,
  resolveInputToTrack,
  saveFavorites,
  searchYouTubeVideoId,
  toggleFavoriteTrack,
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
    // Native loop only applies to single videos, at load time.
    expect(embedSrcForTrack(t)).not.toContain("loop=1");
    expect(embedSrcForTrack(t, false, true)).toContain("loop=1&playlist=dQw4w9WgXcQ");
    const pl = resolveInputToTrack("https://www.youtube.com/playlist?list=PLabcdefghijkl")!;
    expect(embedSrcForTrack(pl, false, true)).not.toContain("loop=1");
    // `start` resumes at a position (loop-off rebuilds), floored and omitted at 0.
    expect(embedSrcForTrack(t, false, false, 0)).not.toContain("start=");
    expect(embedSrcForTrack(t, false, false, 83.7)).toContain("start=83");
    expect(embedSrcForTrack(pl)).toContain("listType=playlist&list=PLabcdefghijkl");
  });

  describe("embed origin", () => {
    const t = resolveInputToTrack("dQw4w9WgXcQ")!;
    const originalLocation = window.location;
    const withLocation = (href: string, run: () => void) => {
      try {
        Object.defineProperty(window, "location", {
          value: new URL(href),
          writable: true,
          configurable: true,
        });
        run();
      } finally {
        Object.defineProperty(window, "location", {
          value: originalLocation,
          writable: true,
          configurable: true,
        });
      }
    };

    it("always embeds from youtube-nocookie.com", () => {
      expect(embedSrcForTrack(t)).toContain("youtube-nocookie.com/embed/dQw4w9WgXcQ");
    });

    it("passes the page's real origin so YouTube accepts commands from it", () => {
      withLocation("http://localhost:1420/", () => {
        const src = embedSrcForTrack(t)!;
        expect(src).toContain("origin=http%3A%2F%2Flocalhost%3A1420");
        expect(src).not.toContain("widget_referrer=");
        expect(src).toContain("controls=0");
        expect(canControlEmbed()).toBe(true);
      });
    });

    // Regression: the desktop app on Windows serves the UI from
    // http://tauri.localhost. It used to be swapped for a placeholder origin, so
    // YouTube ignored every command and no button did anything.
    it.each(["http://tauri.localhost/", "https://tauri.localhost/"])(
      "uses %s as the origin instead of a placeholder (Windows desktop)",
      (href) => {
        withLocation(href, () => {
          const src = embedSrcForTrack(t)!;
          expect(src).toContain(`origin=${encodeURIComponent(new URL(href).origin)}`);
          expect(src).not.toContain("origin=https%3A%2F%2Fwww.youtube-nocookie.com");
          expect(src).toContain("controls=0");
          expect(canControlEmbed()).toBe(true);
        });
      }
    );

    it("falls back to a placeholder origin for the tauri:// scheme (Error 153) and shows native controls", () => {
      withLocation("tauri://localhost", () => {
        const src = embedSrcForTrack(t)!;
        expect(src).not.toContain("origin=tauri");
        expect(src).toContain("origin=https%3A%2F%2Fwww.youtube-nocookie.com");
        expect(src).toContain("widget_referrer=");
        // Our buttons cannot reach the player here, so YouTube's own controls show.
        expect(src).toContain("controls=1");
        expect(canControlEmbed()).toBe(false);
      });
    });
  });

  it("only offers random presets that allow embedding", () => {
    // jfKfPfyJRdk (Lofi Girl radio) returns YouTube error 101/150 when embedded.
    for (let i = 0; i < 200; i++) {
      expect(resolveInputToTrack("random")?.videoId).not.toBe("jfKfPfyJRdk");
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

describe("YouTube embed errors", () => {
  it("surfaces an onError code so the player can stop claiming it is playing", () => {
    expect(parseYouTubePlayerMessage(JSON.stringify({ event: "onError", info: 150 }))).toEqual({
      error: 150,
    });
  });

  it("ignores an onError without a numeric code", () => {
    expect(parseYouTubePlayerMessage(JSON.stringify({ event: "onError", info: null }))).toBeNull();
    expect(parseYouTubePlayerMessage(JSON.stringify({ event: "onError", info: "x" }))).toBeNull();
  });

  it("explains embedding-disabled, removed and unknown errors in plain words", () => {
    expect(describePlayerError(101)).toBe(describePlayerError(150));
    expect(describePlayerError(150)).toMatch(/doesn't allow it to play in an embedded player/);
    expect(describePlayerError(100)).toMatch(/removed or is private/);
    expect(describePlayerError(153)).toMatch(/blocked the embedded player/);
    expect(describePlayerError(999)).toContain("999");
  });
});

describe("legacy queue cleanup", () => {
  it("removes the old stored queue and keeps nothing", () => {
    localStorage.setItem("kai_music_queue_v1", "[{}]");
    clearLegacyQueue();
    expect(localStorage.getItem("kai_music_queue_v1")).toBeNull();
  });
});

describe("curated presets and random playback", () => {
  it("resolves 'random' and 'random video' to a valid track with a playable videoId", () => {
    const t1 = resolveInputToTrack("random");
    expect(t1).not.toBeNull();
    expect(t1?.videoId).toMatch(/^[\w-]{11}$/);
    expect(t1?.playlistId).toBeNull();
    expect(embedSrcForTrack(t1!)).toContain("youtube-nocookie.com/embed/");

    const t2 = resolveInputToTrack("random video");
    expect(t2).not.toBeNull();
    expect(t2?.videoId).toMatch(/^[\w-]{11}$/);
  });

  it("extracts existing video id immediately in searchYouTubeVideoId", async () => {
    const id = await searchYouTubeVideoId("dQw4w9WgXcQ");
    expect(id).toBe("dQw4w9WgXcQ");
    const empty = await searchYouTubeVideoId("   ");
    expect(empty).toBeNull();
  });
});

describe("favorites", () => {
  beforeEach(() => localStorage.clear());

  const video = resolveInputToTrack("https://youtu.be/dQw4w9WgXcQ")!;
  const other = resolveInputToTrack("https://youtu.be/4xDzrJKXOOO")!;

  it("toggles a track in and out of the favorites list", () => {
    let list = toggleFavoriteTrack(video, []);
    expect(list).toHaveLength(1);
    expect(isFavoriteTrack(video, list)).toBe(true);
    list = toggleFavoriteTrack(other, list);
    expect(list).toHaveLength(2);
    list = toggleFavoriteTrack(video, list);
    expect(list).toHaveLength(1);
    expect(isFavoriteTrack(video, list)).toBe(false);
    expect(isFavoriteTrack(other, list)).toBe(true);
  });

  it("matches the same song by identity, not object equality", () => {
    const list = toggleFavoriteTrack(video, []);
    expect(isFavoriteTrack({ ...video, title: "Different title" }, list)).toBe(true);
    expect(isFavoriteTrack(other, list)).toBe(false);
  });

  it("persists and reloads favorites from localStorage", () => {
    saveFavorites(toggleFavoriteTrack(video, []));
    expect(loadFavorites()).toMatchObject([{ videoId: "dQw4w9WgXcQ" }]);
  });

  it("drops corrupt or unplayable persisted entries", () => {
    localStorage.setItem(
      "kai_music_favorites",
      JSON.stringify([
        "nope",
        { title: "x" },
        { title: "Bad id", videoId: "short" },
        { title: "Good", videoId: "dQw4w9WgXcQ", playlistId: null, query: "q" },
      ])
    );
    expect(loadFavorites()).toHaveLength(1);
    expect(loadFavorites()[0].videoId).toBe("dQw4w9WgXcQ");
  });

  it("caps the favorites list at 50 songs", () => {
    const many = Array.from({ length: 60 }, (_, i) => ({
      title: `Song ${i}`,
      videoId: String(1e10 + i)
        .slice(0, 11)
        .padEnd(11, "0"),
      playlistId: null,
      query: `Song ${i}`,
    }));
    saveFavorites(many);
    expect(loadFavorites()).toHaveLength(50);
    // The oldest favorites are dropped, newest survive.
    expect(loadFavorites()[49].title).toBe("Song 59");
  });

  it("survives unavailable storage silently", () => {
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    expect(() => saveFavorites(toggleFavoriteTrack(video, []))).not.toThrow();
    spy.mockRestore();
  });
});
