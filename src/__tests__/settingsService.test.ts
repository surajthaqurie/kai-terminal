// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import {
  SettingsService,
  DEFAULT_SETTINGS,
  isLightTheme,
  normalizeThemeId,
} from "../services/settingsService";
import type { ThemeName } from "../types/terminal";

const ALL_THEMES: ThemeName[] = [
  "kai-dark",
  "github-dark",
  "one-dark",
  "dracula",
  "tokyo-night",
  "catppuccin-mocha",
  "gruvbox-dark",
  "nord",
  "monokai",
  "solarized-dark",
  "github-light",
  "solarized-light",
];

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
      "kai-dark",
      "github-dark",
      "one-dark",
      "dracula",
      "tokyo-night",
      "catppuccin-mocha",
      "gruvbox-dark",
      "nord",
      "monokai",
      "solarized-dark",
      "github-light",
      "solarized-light",
    ] as const;
    for (const themeName of themes) {
      const colors = SettingsService.getThemeColors(themeName);
      expect(colors).toBeDefined();
      expect(colors.background).toBeDefined();
      expect(colors.foreground).toBeDefined();
      expect(colors.cursor).toBeDefined();

      const canvasColor = SettingsService.getThemeCanvasColor(themeName);
      expect(canvasColor).toBeDefined();
      expect(canvasColor.startsWith("#")).toBe(true);
    }
    expect(SettingsService.getThemeCanvasColor("solarized-light")).toBe("#eee8d5");
    expect(SettingsService.getThemeCanvasColor("kai-dark")).toBe("#0b0d10");
  });

  it("should default to the Kai Dark theme", () => {
    expect(DEFAULT_SETTINGS.theme).toBe("kai-dark");
    const kai = SettingsService.getThemeColors("kai-dark");
    expect(kai.background).toBe("#0f1115");
    expect(kai.foreground).toBeDefined();
    expect(kai.cursor).toBeDefined();
  });

  it("moves the removed Kali theme to Kai Dark when settings load", () => {
    expect(SettingsService.normalize({ theme: "kali" as never }).theme).toBe("kai-dark");
    localStorage.setItem("kai_user_settings", JSON.stringify({ theme: "kali", fontSize: 15 }));
    const loaded = SettingsService.loadSettings();
    expect(loaded.theme).toBe("kai-dark");
    expect(loaded.fontSize).toBe(15);
  });

  it("flags only the light themes", () => {
    for (const id of ALL_THEMES) {
      expect(isLightTheme(id), id).toBe(id === "github-light" || id === "solarized-light");
    }
  });

  it("keeps every theme's dim colour (bright black) readable against its background", () => {
    // Autosuggestions and comments are drawn in bright black; the old
    // Solarized Dark used the background colour itself and vanished.
    const lum = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map((i) => {
        const c = parseInt(hex.slice(i, i + 2), 16) / 255;
        return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    for (const id of ALL_THEMES) {
      const c = SettingsService.getThemeColors(id);
      const [hi, lo] = [lum(c.brightBlack!), lum(c.background!)].sort((a, b) => b - a);
      expect((hi + 0.05) / (lo + 0.05), id).toBeGreaterThanOrEqual(2.5);
    }
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

  it("should default skipShellProfile to false and coerce truthy values", () => {
    expect(DEFAULT_SETTINGS.skipShellProfile).toBe(false);
    expect(SettingsService.normalize({}).skipShellProfile).toBe(false);
    expect(SettingsService.normalize({ skipShellProfile: true }).skipShellProfile).toBe(true);
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

  it("should recover unknown theme ids to the Kai Dark default", () => {
    expect(normalizeThemeId("one-dark")).toBe("one-dark");
    expect(normalizeThemeId("github-light")).toBe("github-light");
    expect(normalizeThemeId("kali")).toBe("kai-dark");
    expect(normalizeThemeId("Kali-Dark")).toBe("kai-dark");
    expect(normalizeThemeId("")).toBe("kai-dark");
    expect(normalizeThemeId(undefined)).toBe("kai-dark");
    expect(normalizeThemeId(null)).toBe("kai-dark");
    expect(SettingsService.normalize({ theme: "no-such-theme" as never }).theme).toBe("kai-dark");
  });
});
