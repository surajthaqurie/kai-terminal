import { describe, expect, it } from "vitest";
import {
  embedSrcForTrack,
  parseYouTubePlayerMessage,
  progressPercent,
} from "../services/musicService";

describe("music playback progress", () => {
  it("enables the embed JS API for direct and search tracks", () => {
    const direct = embedSrcForTrack({
      title: "t",
      videoId: "dQw4w9WgXcQ",
      playlistId: null,
      query: "q",
    });
    const search = embedSrcForTrack({
      title: "t",
      videoId: null,
      playlistId: null,
      query: "lofi beats",
    });
    expect(direct).toContain("enablejsapi=1");
    expect(search).toContain("enablejsapi=1");
  });

  it("parses infoDelivery telemetry", () => {
    const msg = JSON.stringify({
      event: "infoDelivery",
      info: { currentTime: 30.5, duration: 120, playerState: 1, volume: 50 },
    });
    expect(parseYouTubePlayerMessage(msg)).toEqual({
      currentTime: 30.5,
      duration: 120,
      playerState: 1,
    });
  });

  it("parses onStateChange including the ended state (0)", () => {
    expect(parseYouTubePlayerMessage(JSON.stringify({ event: "onStateChange", info: 0 }))).toEqual({
      playerState: 0,
    });
  });

  it("ignores malformed, oversized, non-string and unrelated payloads", () => {
    expect(parseYouTubePlayerMessage("not json")).toBeNull();
    expect(parseYouTubePlayerMessage({ event: "infoDelivery" })).toBeNull();
    expect(
      parseYouTubePlayerMessage(JSON.stringify({ event: "initialDelivery", info: {} }))
    ).toBeNull();
    expect(
      parseYouTubePlayerMessage(JSON.stringify({ event: "infoDelivery", info: {} }))
    ).toBeNull();
    expect(
      parseYouTubePlayerMessage(
        JSON.stringify({ event: "infoDelivery", info: { currentTime: "9", duration: null } })
      )
    ).toBeNull();
    expect(parseYouTubePlayerMessage("x".repeat(9000))).toBeNull();
    expect(parseYouTubePlayerMessage("null")).toBeNull();
  });

  it("computes a clamped whole-number percentage", () => {
    expect(progressPercent(30, 120)).toBe(25);
    expect(progressPercent(0, 120)).toBe(0);
    expect(progressPercent(10, 0)).toBe(0);
    expect(progressPercent(500, 120)).toBe(100);
    expect(progressPercent(Number.NaN, 120)).toBe(0);
  });
});
