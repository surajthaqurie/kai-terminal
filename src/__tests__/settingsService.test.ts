// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { SettingsService, DEFAULT_SETTINGS } from "../services/settingsService";

describe("SettingsService", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("should return default settings when localStorage is empty", () => {
    const settings = SettingsService.loadSettings();
    expect(settings).toEqual(DEFAULT_SETTINGS);
  });

  it("should save and reload user settings from localStorage", () => {
    const custom = {
      ...DEFAULT_SETTINGS,
      theme: "dracula" as const,
      fontSize: 18,
    };
    SettingsService.saveSettings(custom);

    const reloaded = SettingsService.loadSettings();
    expect(reloaded.theme).toBe("dracula");
    expect(reloaded.fontSize).toBe(18);
    expect(reloaded.fontFamily).toBe(DEFAULT_SETTINGS.fontFamily);
  });

  it("should return theme color objects for all supported theme names", () => {
    const themes = [
      "catppuccin-mocha",
      "one-dark",
      "dracula",
      "solarized-dark",
      "solarized-light",
    ] as const;
    for (const themeName of themes) {
      const colors = SettingsService.getThemeColors(themeName);
      expect(colors).toBeDefined();
      expect(colors.background).toBeDefined();
      expect(colors.foreground).toBeDefined();
      expect(colors.cursor).toBeDefined();
    }
  });
});
