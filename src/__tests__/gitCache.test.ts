// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import {
  getCachedGitInfo,
  setCachedGitInfo,
  invalidateGitCache,
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

describe("git status cache", () => {
  it("returns cached results within TTL and expires after", () => {
    setCachedGitInfo("/tmp", info, 1000);
    expect(getCachedGitInfo("/tmp", 1000 + GIT_CACHE_TTL_MS - 1)).toEqual(info);
    expect(getCachedGitInfo("/tmp", 1000 + GIT_CACHE_TTL_MS + 1)).toBeNull();
  });

  it("invalidates per directory", () => {
    setCachedGitInfo("/a", info);
    setCachedGitInfo("/b", info);
    invalidateGitCache("/a");
    expect(getCachedGitInfo("/a")).toBeNull();
    expect(getCachedGitInfo("/b")).toEqual(info);
  });

  it("keeps non-git directories as valid workspaces", () => {
    const errInfo: GitInfo = {
      branch: null,
      dirty: false,
      ahead_behind: null,
      repo_root: null,
      error: "Not a git repository or git is missing",
    };
    setCachedGitInfo("/not-a-repo", errInfo);
    expect(getCachedGitInfo("/not-a-repo")?.error).toContain("Not a git");
  });
});
