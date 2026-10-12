// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import {
  currentToken,
  getCompletions,
  recordCommand,
  completionRemainder,
  loadCommandHistory,
  saveCommandHistory,
  AUTOCOMPLETE_HISTORY_KEY,
} from "../services/autocomplete";

beforeEach(() => {
  localStorage.clear();
});

describe("terminal autocomplete", () => {
  it("extracts the current token after separators", () => {
    expect(currentToken("git sta")).toBe("sta");
    expect(currentToken("sudo apt inst")).toBe("inst");
    expect(currentToken("")).toBe("");
    expect(currentToken("cd /tmp && ls --")).toBe("--");
    expect(currentToken("echo foo; git ch")).toBe("ch");
  });

  it("prefers recent history then builtins, deduped and capped", () => {
    const history = ["git status", "git stash", "docker ps"];
    const matches = getCompletions("git st", history);
    expect(matches[0]).toBe("git status");
    expect(matches).toContain("git stash");
    // No duplicates even when builtin overlaps history.
    expect(new Set(matches).size).toBe(matches.length);
    expect(matches.length).toBeLessThanOrEqual(8);
  });

  it("matches mid-line tokens and returns nothing for empty prefix", () => {
    expect(getCompletions("", ["git status"])).toEqual([]);
    const matches = getCompletions("doc", ["docker ps"]);
    expect(matches).toContain("docker ps");
  });

  it("records history most-recent-first without secrets", () => {
    let h = recordCommand([], "git status");
    h = recordCommand(h, "ls -la");
    expect(h[0]).toBe("ls -la");
    // Re-recording moves to front without duplication.
    h = recordCommand(h, "git status");
    expect(h[0]).toBe("git status");
    expect(h.filter((c) => c === "git status")).toHaveLength(1);
    // Likely-secret assignments are never persisted.
    h = recordCommand(h, "export GITHUB_TOKEN=abc123");
    expect(h).not.toContain("export GITHUB_TOKEN=abc123");
    expect(recordCommand(h, "   ")).toEqual(h);
  });

  it("computes only the missing remainder on accept", () => {
    expect(completionRemainder("git st", "git status")).toBe("atus");
    // Full-line history suggestion completes a single word for a short token.
    expect(completionRemainder("doc", "docker compose up")).toBe("ker");
  });

  it("persists history across loads", () => {
    saveCommandHistory(["git status", "ls"]);
    expect(loadCommandHistory()).toEqual(["git status", "ls"]);
    expect(localStorage.getItem(AUTOCOMPLETE_HISTORY_KEY)).toContain("git status");
  });
});
