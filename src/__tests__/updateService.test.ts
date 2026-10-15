// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import {
  isNewerVersion,
  normalizeVersion,
  checkForUpdates,
  openReleasePage,
  RELEASES_PAGE_URL,
  shouldAutoCheck,
  recordCheckTime,
  dismissVersion,
  getDismissedVersion,
  isDismissed,
  UPDATE_LAST_CHECK_KEY,
  UPDATE_DISMISSED_KEY,
  selectUpdateAsset,
  describeAsset,
  type ReleaseAsset,
} from "../services/updateService";

function asset(name: string): ReleaseAsset {
  return {
    name,
    browser_download_url: `https://github.com/surajthaqurie/kai-terminal/releases/download/v9.9.9/${name}`,
    size: 1024,
    content_type: null,
  };
}

describe("updateService version compare", () => {
  it("normalizes v prefix and pre-release/build suffixes", () => {
    expect(normalizeVersion("v0.1.1")).toBe("0.1.1");
    expect(normalizeVersion("V1.2.3")).toBe("1.2.3");
    expect(normalizeVersion("  v2.0.0-beta+build ")).toBe("2.0.0");
  });

  it("detects newer versions", () => {
    expect(isNewerVersion("v0.1.2", "0.1.1")).toBe(true);
    expect(isNewerVersion("0.2.0", "0.1.9")).toBe(true);
    expect(isNewerVersion("1.0.0", "0.9.9")).toBe(true);
    expect(isNewerVersion("0.1.1", "0.1.1")).toBe(false);
    expect(isNewerVersion("0.1.0", "0.1.1")).toBe(false);
    expect(isNewerVersion("v0.1.10", "v0.1.9")).toBe(true);
  });
});

describe("checkForUpdates", () => {
  it("flags update when tag is newer", async () => {
    const fetchFn = (async () =>
      new Response(
        JSON.stringify({
          tag_name: "v9.9.9",
          name: "Big release",
          html_url: "https://example.com/r",
          published_at: "2026-01-01T00:00:00Z",
        }),
        { status: 200 }
      )) as unknown as typeof fetch;
    const res = await checkForUpdates("0.1.1", { fetchFn });
    expect(res.updateAvailable).toBe(true);
    expect(res.latestVersion).toBe("9.9.9");
    expect(res.releaseUrl).toBe("https://example.com/r");
    expect(res.error).toBeNull();
  });

  it("reports the release author, falling back to the repo owner", async () => {
    const withAuthor = (async () =>
      new Response(JSON.stringify({ tag_name: "v9.9.9", author: { login: "surajthaqurie" } }), {
        status: 200,
      })) as unknown as typeof fetch;
    expect((await checkForUpdates("0.1.1", { fetchFn: withAuthor })).releaseAuthor).toBe(
      "surajthaqurie"
    );
    const withoutAuthor = (async () =>
      new Response(JSON.stringify({ tag_name: "v9.9.9" }), {
        status: 200,
      })) as unknown as typeof fetch;
    expect((await checkForUpdates("0.1.1", { fetchFn: withoutAuthor })).releaseAuthor).toBe(
      "surajthaqurie"
    );
  });

  it("credits the repo owner instead of a CI bot author", async () => {
    // Releases are published by CI, so the API author is github-actions[bot].
    const botAuthor = (async () =>
      new Response(
        JSON.stringify({ tag_name: "v9.9.9", author: { login: "github-actions[bot]" } }),
        { status: 200 }
      )) as unknown as typeof fetch;
    expect((await checkForUpdates("0.1.1", { fetchFn: botAuthor })).releaseAuthor).toBe(
      "surajthaqurie"
    );
  });

  it("reports no update when same version", async () => {
    const fetchFn = (async () =>
      new Response(JSON.stringify({ tag_name: "v0.1.1" }), {
        status: 200,
      })) as unknown as typeof fetch;
    const res = await checkForUpdates("0.1.1", { fetchFn });
    expect(res.updateAvailable).toBe(false);
    expect(res.error).toBeNull();
  });

  it("never throws on network failure", async () => {
    const fetchFn = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    const res = await checkForUpdates("0.1.1", { fetchFn });
    expect(res.updateAvailable).toBe(false);
    expect(res.error).toContain("offline");
  });

  it("handles 404 (no releases yet) gracefully", async () => {
    const fetchFn = (async () =>
      new Response("not found", { status: 404 })) as unknown as typeof fetch;
    const res = await checkForUpdates("0.1.1", { fetchFn });
    expect(res.updateAvailable).toBe(false);
    expect(res.error).not.toBeNull();
  });
});

describe("openReleasePage", () => {
  it("opens the given URL via window.open outside Tauri", async () => {
    const opened: string[] = [];
    const origOpen = window.open;
    (window as unknown as { open: unknown }).open = ((target: string) => {
      opened.push(target);
      return { closed: false };
    }) as typeof window.open;
    try {
      await openReleasePage("https://github.com/surajthaqurie/kai-terminal/releases/tag/v9.9.9");
      expect(opened).toEqual(["https://github.com/surajthaqurie/kai-terminal/releases/tag/v9.9.9"]);
    } finally {
      window.open = origOpen;
    }
  });

  it("falls back to the releases page for an empty URL", async () => {
    const opened: string[] = [];
    const origOpen = window.open;
    (window as unknown as { open: unknown }).open = ((target: string) => {
      opened.push(target);
      return { closed: false };
    }) as typeof window.open;
    try {
      await openReleasePage("");
      expect(opened).toEqual([RELEASES_PAGE_URL]);
    } finally {
      window.open = origOpen;
    }
  });

  it("never throws when window.open is unavailable", async () => {
    const origOpen = window.open;
    (window as unknown as { open: unknown }).open = () => null;
    try {
      // jsdom has no navigation: must resolve, not reject.
      await expect(openReleasePage(RELEASES_PAGE_URL)).resolves.toBeUndefined();
    } finally {
      window.open = origOpen;
    }
  });
});

describe("update persistence", () => {
  beforeEach(() => {
    localStorage.removeItem(UPDATE_LAST_CHECK_KEY);
    localStorage.removeItem(UPDATE_DISMISSED_KEY);
  });

  it("auto-checks when never checked, throttles afterwards", () => {
    expect(shouldAutoCheck()).toBe(true);
    recordCheckTime();
    expect(shouldAutoCheck()).toBe(false);
    // Far future forces a re-check.
    expect(shouldAutoCheck(Date.now() + 25 * 60 * 60 * 1000)).toBe(true);
  });

  it("tracks dismissed versions", () => {
    expect(isDismissed("9.9.9")).toBe(false);
    dismissVersion("9.9.9");
    expect(getDismissedVersion()).toBe("9.9.9");
    expect(isDismissed("v9.9.9")).toBe(true);
    expect(isDismissed("9.9.10")).toBe(false);
  });
});

describe("selectUpdateAsset", () => {
  const assets = [
    asset("kai_9.9.9_x64-setup.exe"),
    asset("kai_9.9.9_x64_en-US.msi"),
    asset("kai_9.9.9_aarch64.dmg"),
    asset("kai_9.9.9_amd64.deb"),
    asset("kai_9.9.9_amd64.AppImage"),
  ];

  it("prefers NSIS exe on Windows", () => {
    const picked = selectUpdateAsset(assets, {
      platform: "Win32",
      userAgent: "Windows NT",
    });
    expect(picked?.name).toContain(".exe");
  });

  it("prefers arm64 dmg on macOS", () => {
    const picked = selectUpdateAsset(assets, {
      platform: "MacIntel",
      userAgent: "Macintosh ARM",
    });
    expect(picked?.name).toMatch(/\.dmg$/);
  });

  it("prefers deb over AppImage on Linux", () => {
    const picked = selectUpdateAsset(assets, {
      platform: "Linux x86_64",
      userAgent: "Linux x86_64",
    });
    expect(picked?.name).toMatch(/\.deb$/);
  });

  it("falls back to AppImage when no deb exists", () => {
    const picked = selectUpdateAsset([asset("kai_9.9.9_amd64.AppImage")], {
      platform: "Linux x86_64",
      userAgent: "Linux",
    });
    expect(picked?.name).toMatch(/\.AppImage$/);
  });

  it("returns null when no assets exist", () => {
    expect(selectUpdateAsset([], { platform: "Win32", userAgent: "Windows" })).toBeNull();
  });

  it("exposes installer assets from the release payload", async () => {
    const fetchFn = (async () =>
      new Response(
        JSON.stringify({
          tag_name: "v9.9.9",
          assets: [
            {
              name: "kai_9.9.9_x64-setup.exe",
              browser_download_url: "https://github.com/x/y/releases/download/v9.9.9/f.exe",
              size: 10,
            },
            { name: "src.zip", browser_download_url: "https://example.com/s.zip" },
          ],
        }),
        { status: 200 }
      )) as unknown as typeof fetch;
    const res = await checkForUpdates("0.1.1", { fetchFn });
    expect(res.assets.length).toBe(1);
    expect(res.assets[0].name).toContain(".exe");
    expect(describeAsset(res.assets[0])).toContain("Windows");
  });
});
