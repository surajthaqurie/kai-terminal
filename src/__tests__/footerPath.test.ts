// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  normalizeCwdForCompare,
  cleanCwdForStore,
  formatFooterPath,
  gitCacheKey,
  setCachedGitInfo,
  getCachedGitInfo,
  invalidateGitCache,
  GitInfo,
} from "../services/projectService";

const info: GitInfo = {
  branch: "main",
  dirty: false,
  ahead_behind: null,
  repo_root: "C:\\repo",
  error: null,
};

describe("normalizeCwdForCompare", () => {
  it("unifies Windows separators, case, and verbatim prefixes", () => {
    expect(normalizeCwdForCompare("C:\\Repo\\Demo")).toBe(normalizeCwdForCompare("c:/repo/demo"));
    expect(normalizeCwdForCompare("\\\\?\\C:\\repo\\demo")).toBe(
      normalizeCwdForCompare("C:\\repo\\demo")
    );
    expect(normalizeCwdForCompare("C:\\repo\\demo\\")).toBe(
      normalizeCwdForCompare("C:\\repo\\demo")
    );
  });

  it("keeps POSIX comparison case-sensitive", () => {
    expect(normalizeCwdForCompare("/Repo/Demo")).not.toBe(normalizeCwdForCompare("/repo/demo"));
    expect(normalizeCwdForCompare("/repo/demo/")).toBe(normalizeCwdForCompare("/repo/demo"));
  });
});

describe("cleanCwdForStore", () => {
  it("strips verbatim prefixes and trailing slashes", () => {
    expect(cleanCwdForStore("\\\\?\\C:\\repo\\demo\\")).toBe("C:\\repo\\demo");
    expect(cleanCwdForStore("C:\\repo\\demo\\")).toBe("C:\\repo\\demo");
  });

  it("never strips a filesystem root", () => {
    expect(cleanCwdForStore("C:\\")).toBe("C:\\");
    expect(cleanCwdForStore("/")).toBe("/");
  });
});

describe("formatFooterPath", () => {
  it("returns short paths unchanged", () => {
    expect(formatFooterPath("/home/user/workspace/kai")).toBe("/home/user/workspace/kai");
    expect(formatFooterPath("C:\\repo\\demo")).toBe("C:\\repo\\demo");
    expect(formatFooterPath("")).toBe("");
  });

  it("compacts long paths keeping drive and tail within maxLen", () => {
    const long = "C:\\Users\\ann\\projects\\myrepo\\packages\\frontend\\src\\components";
    const compact = formatFooterPath(long);
    expect(compact.length).toBeLessThanOrEqual(48);
    expect(compact).toContain("…");
    expect(compact.startsWith("C:")).toBe(true);
    expect(compact.endsWith("components")).toBe(true);
  });

  it("uses ~ for long home paths when HOME is pinned", () => {
    const savedHome = process.env.HOME;
    const savedProfile = process.env.USERPROFILE;
    process.env.HOME = "/home/tester";
    process.env.USERPROFILE = "/home/tester";
    try {
      const long = "/home/tester/projects/myrepo/packages/frontend/src/components/deep";
      const compact = formatFooterPath(long);
      expect(compact.startsWith("~")).toBe(true);
      expect(compact.length).toBeLessThanOrEqual(48);
    } finally {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
      if (savedProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = savedProfile;
    }
  });
});

describe("git cache key normalization", () => {
  beforeEach(() => invalidateGitCache());
  afterEach(() => invalidateGitCache());

  it("treats verbatim/separator twins as one entry", () => {
    expect(gitCacheKey("\\\\?\\C:\\repo\\demo")).toBe(gitCacheKey("C:\\repo\\demo"));
    setCachedGitInfo("C:\\repo\\demo", info);
    expect(getCachedGitInfo("C:/repo/demo")).toEqual(info);
    expect(getCachedGitInfo("\\\\?\\C:\\repo\\demo\\")).toEqual(info);
  });
});
