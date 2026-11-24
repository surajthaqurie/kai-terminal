// @vitest-environment jsdom
import fs from "fs";
import path from "path";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MusicPanel } from "../components/MusicPlayer/MusicPanel";
import { preconnectMusicEmbed } from "../services/musicService";

/**
 * RES-07: index.html carried `<link rel="preconnect" href="https://www.youtube-nocookie.com">`,
 * so every launch opened a connection to YouTube's servers, including for the users who
 * never open the music player (and the README says the app makes no unprompted requests).
 * The connection is now warmed up only when the player opens.
 */
const links = () =>
  Array.from(document.head.querySelectorAll('link[rel="preconnect"]')).map((l) =>
    l.getAttribute("href")
  );

afterEach(() => {
  document.head.querySelectorAll('link[rel="preconnect"]').forEach((l) => l.remove());
});

describe("music embed preconnect", () => {
  it("is not in the page that loads at launch", () => {
    const html = fs.readFileSync(path.resolve(__dirname, "../../index.html"), "utf8");
    expect(html).not.toMatch(/youtube/i);
    expect(html).not.toMatch(/rel="preconnect"/);
  });

  it("adds the hint once the player asks for it, and only once", () => {
    expect(links()).toEqual([]);
    preconnectMusicEmbed();
    preconnectMusicEmbed();
    expect(links()).toEqual(["https://www.youtube-nocookie.com"]);
  });

  it("is added when the music panel opens, not while it is closed", async () => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
      true;
    localStorage.clear();
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const panel = (open: boolean) => (
      <MusicPanel startMuted={false} open={open} onClose={vi.fn()} />
    );

    await act(async () => root.render(panel(false)));
    expect(links()).toEqual([]);
    await act(async () => root.render(panel(true)));
    expect(links()).toEqual(["https://www.youtube-nocookie.com"]);

    act(() => root.unmount());
    host.remove();
  });
});
