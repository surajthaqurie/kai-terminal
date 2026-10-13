// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import {
  getCachedGitInfo,
  setCachedGitInfo,
  invalidateGitCache,
  gitCacheKey,
  GIT_CACHE_TTL_MS,
  GitInfo,
} from "../services/projectService";

const info: GitInfo = {
  branch: "main",
  dirty: false,
  ahead_behind: null,
  repo_root: "/tmp",
  error: null,
};

beforeEach(() => {
  invalidateGitCache();
});

describe("git cache invalidation regressions", () => {
  it("normalizes keys so trailing whitespace cannot fork entries", () => {
    expect(gitCacheKey("  /tmp  ")).toBe("/tmp");
    setCachedGitInfo("  /tmp ", info);
    expect(getCachedGitInfo("/tmp")).toEqual(info);
  });

  it("explicit invalidation drops entries and TTL expiry is enforced", () => {
    setCachedGitInfo("/repo", info, 5000);
    expect(getCachedGitInfo("/repo", 5000 + GIT_CACHE_TTL_MS - 1)).toEqual(info);
    expect(getCachedGitInfo("/repo", 5000 + GIT_CACHE_TTL_MS + 1)).toBeNull();
    setCachedGitInfo("/repo", info);
    invalidateGitCache("/repo");
    expect(getCachedGitInfo("/repo")).toBeNull();
  });

  it("mutating git actions invalidate the cache (no stale badges)", async () => {
    // Outside the desktop app the IPC rejects — but the finally-block
    // invalidation must still clear the badge so a later success can never
    // read a stale entry. Inside the app the same finally runs on success.
    for (const call of [
      () => import("../services/projectService").then((m) => m.runGitAction("/repo", "fetch")),
      () => import("../services/projectService").then((m) => m.stageGitFile("/repo", "f.txt")),
      () => import("../services/projectService").then((m) => m.unstageGitFile("/repo", "f.txt")),
      () => import("../services/projectService").then((m) => m.discardGitFile("/repo", "f.txt")),
    ]) {
      const mod = await import("../services/projectService");
      mod.setCachedGitInfo("/repo", info);
      await expect(call()).rejects.toThrow();
      expect(mod.getCachedGitInfo("/repo")).toBeNull();
    }
  });

  it("distinguishes missing git / bad dirs without throwing", () => {
    const missing: GitInfo = {
      branch: null,
      dirty: false,
      ahead_behind: null,
      repo_root: null,
      error: "Git is not installed or not on PATH",
    };
    setCachedGitInfo("/repo", missing);
    expect(getCachedGitInfo("/repo")?.error).toContain("Git is not installed");
    const bad: GitInfo = {
      branch: null,
      dirty: false,
      ahead_behind: null,
      repo_root: null,
      error: "Directory is not accessible",
    };
    setCachedGitInfo("/priv", bad);
    expect(getCachedGitInfo("/priv")?.error).toContain("accessible");
  });

  it("unusual paths (spaces, unicode) are valid distinct cache keys", () => {
    setCachedGitInfo("/tmp/sp ace ünïcode", info);
    setCachedGitInfo("/tmp/nested/inner", info);
    expect(getCachedGitInfo("/tmp/sp ace ünïcode")).toEqual(info);
    expect(getCachedGitInfo("/tmp/nested/inner")).toEqual(info);
    invalidateGitCache("/tmp/sp ace ünïcode");
    expect(getCachedGitInfo("/tmp/sp ace ünïcode")).toBeNull();
    expect(getCachedGitInfo("/tmp/nested/inner")).toEqual(info);
  });
});
