import { describe, expect, it } from "vitest";
import {
  DEFAULT_RULES,
  RulesError,
  compactRules,
  effectiveRules,
  isValidBranchName,
  normalizeBranch,
  readStoredRules,
  validateRules,
} from "../core/integrations/workflowRules";

describe("workflow rules: merge branch", () => {
  it("defaults to the repository's own default branch (empty)", () => {
    expect(DEFAULT_RULES).toEqual({ mergeBranch: "" });
    expect(effectiveRules()).toEqual({ mergeBranch: "" });
    expect(effectiveRules({ mergeBranch: "develop" })).toEqual({ mergeBranch: "develop" });
  });

  it("accepts git-safe branch names and refuses the rest", () => {
    for (const ok of ["main", "develop", "release/1.2", "feature/42-crash_on.save"]) {
      expect(isValidBranchName(ok), ok).toBe(true);
    }
    for (const bad of [
      "",
      "-x",
      "/x",
      "x/",
      "a..b",
      "a//b",
      "a/.b",
      "x.lock",
      "x.",
      "a b",
      "a;b",
    ]) {
      expect(isValidBranchName(bad), bad).toBe(false);
    }
    expect(isValidBranchName("a".repeat(201))).toBe(false);
  });

  it("treats refs/heads/main and main as the same branch", () => {
    expect(normalizeBranch("  refs/heads/main ")).toBe("main");
    expect(compactRules({ mergeBranch: "refs/heads/develop" })).toEqual({ mergeBranch: "develop" });
  });

  it("validates only what it is given", () => {
    expect(validateRules({})).toBeNull();
    expect(validateRules({ mergeBranch: "" })).toBeNull();
    expect(validateRules({ mergeBranch: "develop" })).toBeNull();
    expect(validateRules({ mergeBranch: "bad branch" })).toMatch(/not a valid branch name/);
    expect(validateRules({ mergeBranch: 7 })).toMatch(/must be text/);
  });

  it("stores only a difference from the default", () => {
    expect(compactRules({ mergeBranch: "" })).toEqual({});
    expect(compactRules({})).toEqual({});
    expect(compactRules({ mergeBranch: "develop" })).toEqual({ mergeBranch: "develop" });
    expect(() => compactRules({ mergeBranch: "bad branch" })).toThrow(RulesError);
  });

  it("drops a bad or removed stored field instead of failing", () => {
    expect(readStoredRules(undefined)).toBeUndefined();
    expect(readStoredRules([])).toBeUndefined();
    expect(readStoredRules({ mergeBranch: "develop" })).toEqual({ mergeBranch: "develop" });
    expect(readStoredRules({ mergeBranch: "bad branch" })).toBeUndefined();
    // Fields from the earlier, larger version of the rules are ignored.
    expect(
      readStoredRules({ commitRule: "x {summary}", branchNameRule: "{id}-{slug}" })
    ).toBeUndefined();
    expect(readStoredRules({ mergeBranch: "develop", commitRule: "x" })).toEqual({
      mergeBranch: "develop",
    });
  });
});
