import { describe, it, expect } from "vitest";
import { getAiCliStatus, isAnyAiCliAvailable, versionBadgeLabel } from "../services/aiCliService";

describe("aiCliService (optional, safe detection)", () => {
  it("works without Tauri and without any CLI installed", async () => {
    const statuses = await getAiCliStatus();
    expect(statuses).toHaveLength(10);
    for (const s of statuses) {
      expect([
        "codex",
        "claude",
        "gemini",
        "opencode",
        "copilot",
        "aider",
        "cursor",
        "windsurf",
        "cline",
        "agy",
      ]).toContain(s.id);
      // In jsdom (no Tauri) every CLI must report unavailable, never throw.
      expect(s.available).toBe(false);
      expect(s.path).toBeNull();
    }
  });

  it("reports a boolean without throwing", async () => {
    await expect(isAnyAiCliAvailable()).resolves.toBe(false);
  });

  it("never requires a CLI to be present", async () => {
    // The app must function independently of CLI installation.
    const statuses = await getAiCliStatus();
    expect(Array.isArray(statuses)).toBe(true);
  });
});

describe("versionBadgeLabel", () => {
  it("reduces vendor decoration to the version token", () => {
    expect(versionBadgeLabel("codex-cli 0.46.0")).toBe("0.46.0");
    expect(versionBadgeLabel("2.1.5 (Claude Code)")).toBe("2.1.5");
    expect(versionBadgeLabel("v1.2.3-beta.1")).toBe("v1.2.3-beta.1");
  });

  it("returns nothing for a sentence that has no version in it", () => {
    expect(
      versionBadgeLabel("GitHub Copilot CLI was not found. Run Copilot in a terminal to install it")
    ).toBeNull();
    expect(versionBadgeLabel("")).toBeNull();
  });
});
