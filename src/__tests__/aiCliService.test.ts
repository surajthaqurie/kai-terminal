import { describe, it, expect } from "vitest";
import { getAiCliStatus, isAnyAiCliAvailable } from "../services/aiCliService";

describe("aiCliService (optional, safe detection)", () => {
  it("works without Tauri and without any CLI installed", async () => {
    const statuses = await getAiCliStatus();
    expect(statuses).toHaveLength(6);
    for (const s of statuses) {
      expect(["codex", "claude", "gemini", "opencode", "copilot", "aider"]).toContain(s.id);
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
