// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  SettingsService,
  TERMINAL_LAYOUT_DEFAULTS,
} from "../services/settingsService";
import { readStylesheet } from "./helpers/styles";

/** Settings → Terminal: line height and padding (audit L6). */
describe("terminal layout settings", () => {
  beforeEach(() => localStorage.clear());

  it("defaults to the values Kai always used, so nothing changes for anyone", () => {
    expect(DEFAULT_SETTINGS.lineHeight).toBe(1.2);
    expect(DEFAULT_SETTINGS.terminalPaddingX).toBe(6);
    expect(DEFAULT_SETTINGS.terminalPaddingY).toBe(4);
    // The stylesheet fallback (before any pane sets the variables) matches too.
    const css = readStylesheet();
    expect(css).toContain(`--terminal-padding-x: ${TERMINAL_LAYOUT_DEFAULTS.paddingX}px;`);
    expect(css).toContain(`--terminal-padding-y: ${TERMINAL_LAYOUT_DEFAULTS.paddingY}px;`);
    expect(css).toMatch(
      /\.terminal-xterm-host \.xterm \{[^}]*padding: var\(--terminal-padding-y\) var\(--terminal-padding-x\)/
    );
  });

  it("an older saved settings file without these keys loads with the defaults", () => {
    const { lineHeight, terminalPaddingX, terminalPaddingY, ...old } = DEFAULT_SETTINGS;
    void lineHeight;
    void terminalPaddingX;
    void terminalPaddingY;
    localStorage.setItem("kai_user_settings", JSON.stringify({ ...old, theme: "nord" }));
    const loaded = SettingsService.loadSettings();
    expect(loaded.theme).toBe("nord");
    expect(loaded.lineHeight).toBe(1.2);
    expect(loaded.terminalPaddingX).toBe(6);
    expect(loaded.terminalPaddingY).toBe(4);
  });

  it("clamps out-of-range and invalid values instead of breaking the grid", () => {
    const n = SettingsService.normalize({
      lineHeight: 9,
      terminalPaddingX: -5,
      terminalPaddingY: Number.NaN,
    });
    expect(n.lineHeight).toBe(2);
    expect(n.terminalPaddingX).toBe(0);
    expect(n.terminalPaddingY).toBe(4);
    expect(SettingsService.normalize({ lineHeight: 1.333 }).lineHeight).toBe(1.33);
  });

  it("round-trips a chosen value through save and load", () => {
    SettingsService.saveSettings({ ...DEFAULT_SETTINGS, lineHeight: 1.5, terminalPaddingX: 12 });
    const loaded = SettingsService.loadSettings();
    expect(loaded.lineHeight).toBe(1.5);
    expect(loaded.terminalPaddingX).toBe(12);
  });
});
