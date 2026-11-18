// @vitest-environment jsdom
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  PIP_EVENTS,
  closeMusicPip,
  emitPip,
  isMusicPipWindow,
  listenPip,
  openMusicPip,
} from "../services/musicPip";
import { embedSrcForTrack } from "../services/musicService";

const track = { title: "Song", videoId: "dQw4w9WgXcQ", playlistId: null, query: "Song" };

describe("music picture-in-picture", () => {
  it("recognises the detached window by its query string only", () => {
    window.history.pushState({}, "", "/index.html?pip=music");
    expect(isMusicPipWindow()).toBe(true);
    window.history.pushState({}, "", "/index.html?pip=other");
    expect(isMusicPipWindow()).toBe(false);
    window.history.pushState({}, "", "/");
    expect(isMusicPipWindow()).toBe(false);
  });

  it("does nothing outside the desktop app", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(emitPip(PIP_EVENTS.state, {})).resolves.toBeUndefined();
    await expect(openMusicPip()).resolves.toBe(false);
    await expect(closeMusicPip(true)).resolves.toBeUndefined();
    const unlisten = await listenPip(PIP_EVENTS.closed, () => {});
    expect(typeof unlisten).toBe("function");
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("lets a resumed embed stay paused, and autoplays by default", () => {
    expect(embedSrcForTrack(track)).toContain("autoplay=1");
    expect(embedSrcForTrack(track, false, false, 42, false)).toContain("autoplay=0");
    expect(embedSrcForTrack(track, false, false, 42, false)).toContain("start=42");
  });

  it("gives the pip window its own least-privilege capability", () => {
    const dir = path.resolve(__dirname, "../../src-tauri/capabilities");
    const pip = JSON.parse(fs.readFileSync(path.join(dir, "music-pip.json"), "utf-8"));
    const main = JSON.parse(fs.readFileSync(path.join(dir, "default.json"), "utf-8"));
    expect(pip.windows).toEqual(["music-pip"]);
    expect(main.windows).not.toContain("music-pip");
    // Dragging is the only window power it needs; it cannot close or minimize the app.
    expect(pip.permissions).toEqual(["core:default", "core:window:allow-start-dragging"]);
  });

  it("only lets the main window end the app", () => {
    const rs = fs.readFileSync(path.resolve(__dirname, "../../src-tauri/src/lib.rs"), "utf-8");
    expect(rs).toMatch(/CloseRequested \{ \.\. \} if window\.label\(\) == "main"/);
    expect(rs).toContain("open_music_pip,");
    expect(rs).toContain("close_music_pip,");
  });
});
