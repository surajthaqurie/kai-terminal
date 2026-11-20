import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SettingsService } from "../services/settingsService";
import { THEMES, DEFAULT_THEME_ID } from "../theme/registry";
import type { ThemeName } from "../types/terminal";

/**
 * Guards the "blank window on start" fix: the native window and the page both
 * paint the theme's canvas color before any script runs, and those colors
 * must stay in step with the theme table the app uses afterwards.
 */
const html = readFileSync(resolve(process.cwd(), "index.html"), "utf8");
const conf = JSON.parse(
  readFileSync(resolve(process.cwd(), "src-tauri", "tauri.conf.json"), "utf8")
) as { app: { windows: Array<{ label: string; backgroundColor?: string }> } };

describe("first paint", () => {
  it("the default page background is the default theme's canvas color", () => {
    const base = /html\s*\{\s*background:\s*(#[0-9a-f]{6})\s*;/i.exec(html)?.[1];
    expect(base?.toLowerCase()).toBe(SettingsService.getThemeCanvasColor(DEFAULT_THEME_ID));
  });

  it("every themed background matches getThemeCanvasColor", () => {
    const themed = [
      ...html.matchAll(/html\[data-theme="([a-z-]+)"\]\s*\{\s*background:\s*(#[0-9a-f]{6})\s*;/gi),
    ];
    expect(themed).toHaveLength(THEMES.length - 1);
    for (const [, theme, color] of themed) {
      expect(color.toLowerCase(), theme).toBe(
        SettingsService.getThemeCanvasColor(theme as ThemeName)
      );
    }
  });

  it("the boot script knows every theme, its canvas and its color-scheme", () => {
    const scripted = [
      ...html.matchAll(/"([a-z-]+)":\s*\["(#[0-9a-f]{6})",\s*"(dark|light)"\]/gi),
    ].map((m) => ({ id: m[1], canvas: m[2], scheme: m[3] }));
    expect(scripted).toEqual(
      THEMES.map((t) => ({ id: t.id, canvas: t.chrome["bg-canvas"], scheme: t.colorScheme }))
    );
  });

  it("the boot script and the static styles name the same themes", () => {
    const styled = new Set([...html.matchAll(/html\[data-theme="([a-z-]+)"\]/g)].map((m) => m[1]));
    for (const theme of THEMES.filter((t) => t.id !== DEFAULT_THEME_ID))
      expect(styled.has(theme.id), theme.id).toBe(true);
  });

  it("the native window starts in the default canvas color, not the webview's blank default", () => {
    const main = conf.app.windows.find((w) => w.label === "main");
    expect(main?.backgroundColor?.toLowerCase()).toBe(
      SettingsService.getThemeCanvasColor(DEFAULT_THEME_ID)
    );
  });
});
