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

  it("should return theme color objects for all supported theme names including nord and tokyo-night", () => {
    const themes = [
      "kali",
      "catppuccin-mocha",
      "one-dark",
      "dracula",
      "solarized-dark",
      "solarized-light",
      "nord",
      "tokyo-night",
    ] as const;
    for (const themeName of themes) {
      const colors = SettingsService.getThemeColors(themeName);
      expect(colors).toBeDefined();
      expect(colors.background).toBeDefined();
      expect(colors.foreground).toBeDefined();
      expect(colors.cursor).toBeDefined();
    }
  });

  it("should default to the Kali theme", () => {
    expect(DEFAULT_SETTINGS.theme).toBe("kali");
    const kali = SettingsService.getThemeColors("kali");
    expect(kali.background).toBe("#0a1428");
    expect(kali.foreground).toBeDefined();
    expect(kali.cursor).toBeDefined();
    // Legacy stored settings without kali migrate safely.
    expect(SettingsService.normalize({ theme: "kali" as never }).theme).toBe("kali");
  });
  it("should apply opacity to theme background color correctly", () => {
    const defaultColors = SettingsService.getThemeColors("catppuccin-mocha", 1.0);
    expect(defaultColors.background).toBe("#1e1e2e");

    const transparentColors = SettingsService.getThemeColors("catppuccin-mocha", 0.85);
    expect(transparentColors.background).toContain("rgba");

    const normalized = SettingsService.normalize({ opacity: 0.1 });
    expect(normalized.opacity).toBe(0.2); // clamped to min 0.2

    const normalizedMax = SettingsService.normalize({ opacity: 1.5 });
    expect(normalizedMax.opacity).toBe(1.0); // clamped to max 1.0
  });

  it("should normalize cursorStyle safely", () => {
    const valid = SettingsService.normalize({ cursorStyle: "underline" });
    expect(valid.cursorStyle).toBe("underline");

    const invalid = SettingsService.normalize({ cursorStyle: "invalid" as never });
    expect(invalid.cursorStyle).toBe("block");
  });

  it("should default launchAtStartup to false and coerce truthy values", () => {
    expect(DEFAULT_SETTINGS.launchAtStartup).toBe(false);
    expect(SettingsService.normalize({}).launchAtStartup).toBe(false);
    expect(SettingsService.normalize({ launchAtStartup: true }).launchAtStartup).toBe(true);
    // Legacy stored settings without the key migrate safely.
    const reloaded = SettingsService.normalize(JSON.parse(JSON.stringify(DEFAULT_SETTINGS)));
    expect(reloaded.launchAtStartup).toBe(false);
  });

  it("should default autoRestoreSession to false so startup stays fast", () => {
    expect(DEFAULT_SETTINGS.autoRestoreSession).toBe(false);
    expect(SettingsService.normalize({}).autoRestoreSession).toBe(false);
    expect(SettingsService.normalize({ autoRestoreSession: true }).autoRestoreSession).toBe(true);
  });

  it("should have default fontSize of 12 and system font family", () => {
    expect(DEFAULT_SETTINGS.fontSize).toBe(12);
    expect(DEFAULT_SETTINGS.fontFamily).toContain("Fira Code");
    expect(DEFAULT_SETTINGS.fontFamily).toContain("monospace");
    const normalized = SettingsService.normalize({});
    expect(normalized.fontSize).toBe(12);
  });

  it("should safely handle loadSystemDefaults", async () => {
    const defaults = await SettingsService.loadSystemDefaults();
    expect(defaults).toBeDefined();
  });
});
