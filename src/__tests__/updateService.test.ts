// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import {
  isNewerVersion,
  normalizeVersion,
  checkForUpdates,
  shouldAutoCheck,
  recordCheckTime,
  dismissVersion,
  getDismissedVersion,
  isDismissed,
  UPDATE_LAST_CHECK_KEY,
  UPDATE_DISMISSED_KEY,
} from "../services/updateService";

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
