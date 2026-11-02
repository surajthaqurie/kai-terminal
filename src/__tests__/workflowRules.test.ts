import { describe, expect, it } from "vitest";
import {
  DEFAULT_RULES,
  RulesError,
  checkBranchPattern,
  compactRules,
  effectiveRules,
  isValidBranchName,
  normalizeBranch,
  readStoredRules,
  validateRules,
} from "../core/integrations/workflowRules";

describe("workflow rules: merge branch", () => {
  it("defaults to the repository's own default branch (empty)", () => {
    expect(DEFAULT_RULES).toEqual({ mergeBranch: "", branchPattern: "" });
    expect(effectiveRules()).toEqual({ mergeBranch: "", branchPattern: "" });
    expect(effectiveRules({ mergeBranch: "develop" })).toEqual({
      mergeBranch: "develop",
      branchPattern: "",
    });
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

describe("workflow rules: branch naming pattern", () => {
  const GOOD = String.raw`^(feature|bugfix|task)/\d+-[a-z0-9-]+$`;

  it("accepts an empty pattern (no rule) and a normal anchored one", () => {
    expect(checkBranchPattern("")).toEqual({ error: null, warning: null });
    expect(checkBranchPattern(GOOD)).toEqual({ error: null, warning: null });
  });

  it("explains each kind of bad pattern", () => {
    expect(checkBranchPattern("   ").error).toMatch(/only spaces/);
    expect(checkBranchPattern(" ^a$").error).toMatch(/spaces before or after/);
    expect(checkBranchPattern("a".repeat(201)).error).toMatch(/too long \(201 of 200/);
    expect(checkBranchPattern("/^feature$/i").error).toMatch(/without the slashes/);
    expect(checkBranchPattern("^feature/(").error).toMatch(
      /^Not a valid regular expression: .+\.$/
    );
    expect(checkBranchPattern("^(a+)+$").error).toMatch(/repeats a repeat/);
    expect(checkBranchPattern(".*").error).toMatch(/matches an empty name/);
    expect(checkBranchPattern("^$").error).toMatch(/matches an empty name/);
  });

  it("does not mistake a character class for a repeated group", () => {
    expect(checkBranchPattern(String.raw`^([+*]x)+-\d$`).error).toBeNull();
  });

  it("only suggests anchors, without blocking", () => {
    const loose = checkBranchPattern(String.raw`feature/\d+`);
    expect(loose.error).toBeNull();
    expect(loose.warning).toMatch(/\^ and end with \$/);
    expect(checkBranchPattern(String.raw`^feature/\d+`).warning).not.toBeNull();
  });

  it("is validated, compacted and read back like the merge branch", () => {
    expect(validateRules({ branchPattern: GOOD })).toBeNull();
    expect(validateRules({ branchPattern: 5 })).toMatch(/Branch naming must be text/);
    expect(validateRules({ branchPattern: "^(" })).toMatch(/Not a valid regular expression/);
    expect(compactRules({ branchPattern: "" })).toEqual({});
    expect(compactRules({ branchPattern: GOOD })).toEqual({ branchPattern: GOOD });
    expect(compactRules({ mergeBranch: "develop", branchPattern: GOOD })).toEqual({
      mergeBranch: "develop",
      branchPattern: GOOD,
    });
    expect(() => compactRules({ branchPattern: "^(" })).toThrow(RulesError);
  });

  it("drops only the bad stored field", () => {
    expect(readStoredRules({ branchPattern: GOOD })).toEqual({ branchPattern: GOOD });
    expect(readStoredRules({ branchPattern: "^(" })).toBeUndefined();
    expect(readStoredRules({ mergeBranch: "develop", branchPattern: "^(" })).toEqual({
      mergeBranch: "develop",
    });
    expect(readStoredRules({ mergeBranch: "bad branch", branchPattern: GOOD })).toEqual({
      branchPattern: GOOD,
    });
  });
});
