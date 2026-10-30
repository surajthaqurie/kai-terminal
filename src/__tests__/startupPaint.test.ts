import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SettingsService } from "../services/settingsService";
import type { ThemeName } from "../types/terminal";

/**
 * Guards the "blank window on start" fix: the native window and the page both
 * paint the theme's canvas color before any script runs, and those hard-coded
 * colors must stay in step with the theme table the app uses afterwards.
 */
const html = readFileSync(resolve(process.cwd(), "index.html"), "utf8");
const conf = JSON.parse(
  readFileSync(resolve(process.cwd(), "src-tauri", "tauri.conf.json"), "utf8")
) as { app: { windows: Array<{ label: string; backgroundColor?: string }> } };

describe("first paint", () => {
  it("the default page background is the default theme's canvas color", () => {
    const base = /html\s*\{\s*background:\s*(#[0-9a-f]{6})\s*;/i.exec(html)?.[1];
    expect(base?.toLowerCase()).toBe(SettingsService.getThemeCanvasColor("kai-dark"));
  });

  it("every themed background matches getThemeCanvasColor", () => {
    const themed = [
      ...html.matchAll(/html\[data-theme="([a-z-]+)"\]\s*\{\s*background:\s*(#[0-9a-f]{6})\s*;/gi),
    ];
    expect(themed.length).toBeGreaterThanOrEqual(7);
    for (const [, theme, color] of themed) {
      expect(color.toLowerCase(), theme).toBe(
        SettingsService.getThemeCanvasColor(theme as ThemeName)
      );
    }
  });

  it("the boot script and the static styles name the same themes", () => {
    const styled = new Set([...html.matchAll(/html\[data-theme="([a-z-]+)"\]/g)].map((m) => m[1]));
    const scripted = [...html.matchAll(/"?([a-z-]+)"?:\s*"#[0-9a-f]{6}"/gi)].map((m) => m[1]);
    for (const theme of scripted.filter((t) => t !== "kai-dark"))
      expect(styled.has(theme), theme).toBe(true);
  });

  it("the native window starts in the default canvas color, not the webview's blank default", () => {
    const main = conf.app.windows.find((w) => w.label === "main");
    expect(main?.backgroundColor?.toLowerCase()).toBe(
      SettingsService.getThemeCanvasColor("kai-dark")
    );
  });
});
