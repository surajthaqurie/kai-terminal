// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { SettingsService, DEFAULT_SETTINGS } from "../services/settingsService";
import { loadRecentProjects, recordRecentProject } from "../services/projectService";
import { getAiCliDetails } from "../services/aiCliService";

describe("SettingsService hardening", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("recovers from corrupt storage to safe defaults", () => {
    localStorage.setItem("terminal_user_settings", "{not-json");
    const s = SettingsService.loadSettings();
    expect(s.fontSize).toBe(DEFAULT_SETTINGS.fontSize);
  });

  it("clamps out-of-range values and strips NUL custom paths", () => {
    const s = SettingsService.normalize({
      fontSize: 999,
      scrollback: 9999999,
      theme: "nope" as never,
      customShellPath: "bad\0path",
    });
    expect(s.fontSize).toBeLessThanOrEqual(36);
    expect(s.scrollback).toBeLessThanOrEqual(100000);
    expect(s.theme).toBe(DEFAULT_SETTINGS.theme);
    expect(s.customShellPath).toBe("");
  });

  it("preserves compatible settings across normalize (upgrade-safe)", () => {
    const s = SettingsService.normalize({
      theme: "dracula",
      fontSize: 16,
    });
    expect(s.theme).toBe("dracula");
    expect(s.fontSize).toBe(16);
  });
});

describe("projectService (no filesystem scanning)", () => {
  it("stores recent projects without replaying history", () => {
    localStorage.clear();
    expect(loadRecentProjects()).toEqual([]);
    recordRecentProject("/tmp/proj-a");
    recordRecentProject("/tmp/proj-b");
    const rec = loadRecentProjects();
    expect(rec[0]).toBe("/tmp/proj-b");
    expect(rec).toHaveLength(2);
  });
});

describe("aiCliService details fallback", () => {
  it("returns safe unavailable details outside Tauri", async () => {
    const details = await getAiCliDetails();
    expect(details).toHaveLength(10);
    for (const d of details) {
      expect(d.available).toBe(false);
      expect(d.install_guidance.length).toBeGreaterThan(0);
    }
  });
});
