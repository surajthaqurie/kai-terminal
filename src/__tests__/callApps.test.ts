// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import {
  MAX_EXTRA_CALL_APPS,
  formatCallAppsInput,
  parseCallAppsInput,
  sanitizeCallApps,
  syncExtraCallApps,
} from "../services/callAppsService";
import { DEFAULT_SETTINGS, SettingsService } from "../services/settingsService";

describe("extra call apps setting", () => {
  it("defaults to none", () => {
    expect(DEFAULT_SETTINGS.extraCallApps).toEqual([]);
    expect(SettingsService.normalize({}).extraCallApps).toEqual([]);
  });

  it("trims, lowercases, de-duplicates and drops unusable entries", () => {
    expect(
      sanitizeCallApps(["  GoToMeet ", "gotomeet", "ab", "", 42, null, "bad\u0007name", "Mumble"])
    ).toEqual(["gotomeet", "mumble"]);
    expect(sanitizeCallApps("not a list")).toEqual([]);
    expect(sanitizeCallApps(["x".repeat(65)])).toEqual([]);
    expect(sanitizeCallApps(Array.from({ length: 100 }, (_, i) => `app-number-${i}`))).toHaveLength(
      MAX_EXTRA_CALL_APPS
    );
  });

  it("parses the comma / newline separated field and formats it back", () => {
    expect(parseCallAppsInput("GoToMeet, mumble\nteamspeak ,, x")).toEqual([
      "gotomeet",
      "mumble",
      "teamspeak",
    ]);
    expect(formatCallAppsInput(["gotomeet", "mumble"])).toBe("gotomeet, mumble");
    expect(formatCallAppsInput(undefined)).toBe("");
  });

  it("is normalized and survives a save / load round trip", () => {
    localStorage.clear();
    SettingsService.saveSettings({
      ...DEFAULT_SETTINGS,
      extraCallApps: [" Mumble ", "mumble", "ab"],
    });
    expect(SettingsService.loadSettings().extraCallApps).toEqual(["mumble"]);
    localStorage.clear();
  });

  it("sync is a safe no-op outside the desktop app", async () => {
    await expect(syncExtraCallApps(["mumble"])).resolves.toBeUndefined();
  });
});
