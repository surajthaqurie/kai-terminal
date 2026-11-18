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
  loadPipPosition,
  loadPipSize,
  openMusicPip,
  pipOpacity,
  savePipPosition,
  savePipSize,
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

  it("remembers where the mini window was dropped", () => {
    localStorage.removeItem("kai_music_pip_position");
    expect(loadPipPosition()).toBeNull();
    savePipPosition(812.4, -40);
    expect(loadPipPosition()).toEqual({ x: 812, y: -40 });
    savePipPosition(Number.NaN, 5);
    expect(loadPipPosition()).toEqual({ x: 812, y: -40 });
    localStorage.setItem("kai_music_pip_position", "{bad");
    expect(loadPipPosition()).toBeNull();
  });

  it("remembers the mini window's size", () => {
    localStorage.removeItem("kai_music_pip_size");
    expect(loadPipSize()).toBeNull();
    savePipSize(480.6, 270.2);
    expect(loadPipSize()).toEqual({ width: 481, height: 270 });
    // Below the native minimum or not a number: ignored, the last good size stays.
    savePipSize(100, 80);
    savePipSize(Number.NaN, 300);
    expect(loadPipSize()).toEqual({ width: 481, height: 270 });
    localStorage.setItem("kai_music_pip_size", JSON.stringify({ width: 10, height: 10 }));
    expect(loadPipSize()).toBeNull();
    localStorage.setItem("kai_music_pip_size", "{bad");
    expect(loadPipSize()).toBeNull();
  });

  it("carries the player's dim opacity to the mini window", () => {
    expect(pipOpacity(false, 40)).toBe(1);
    expect(pipOpacity(true, 40)).toBe(0.4);
    expect(pipOpacity(true, 5)).toBe(0.15);
    expect(pipOpacity(true, 100)).toBe(1);
  });

  it("keeps the WebView2 arguments in one place, with autoplay allowed", () => {
    const rs = fs.readFileSync(path.resolve(__dirname, "../../src-tauri/src/lib.rs"), "utf-8");
    const conf = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, "../../src-tauri/tauri.windows.conf.json"), "utf-8")
    );
    const args: string = conf.app.windows[0].additionalBrowserArgs;
    expect(args).toContain("--autoplay-policy=no-user-gesture-required");
    // WebView2 refuses a second window whose arguments differ from the first, so the
    // music window reads the very same string instead of keeping a copy that can drift.
    expect(rs).toContain('include_str!("../tauri.windows.conf.json")');
    expect(rs).toContain(".additional_browser_args(&args)");
    expect(rs).not.toContain("--disable-features");
  });
});
