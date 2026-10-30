// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
  DEFAULT_SETTINGS,
  PREVIOUS_DEFAULT_FONT_FAMILY,
  SettingsService,
} from "../services/settingsService";
import type { ThemeName } from "../types/terminal";

/**
 * Guards for the UI refinement: tab/status chrome has real depth, hint text
 * stays readable on it, the active tab joins its terminal, and the fonts are
 * bundled instead of left to whatever each OS happens to have installed.
 */
const ROOT = path.resolve(__dirname, "../..");
const css = fs.readFileSync(path.join(ROOT, "src/App.css"), "utf8");

const THEMES: ThemeName[] = [
  "kai-dark",
  "gruvbox-dark",
  "catppuccin-mocha",
  "tokyo-night",
  "nord",
  "dracula",
  "solarized-dark",
  "one-dark",
  "rose-pine",
];

function themeVars(theme: ThemeName): Record<string, string> {
  const m = new RegExp(`\\[data-theme="${theme}"\\]\\s*\\{([\\s\\S]*?)\\n\\}`).exec(css);
  expect(m, `theme ${theme} block`).not.toBeNull();
  const vars: Record<string, string> = {};
  for (const v of m![1].matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/g)) vars[v[1]] = v[2].trim();
  return vars;
}

type RGB = [number, number, number];
function rgb(color: string, over: RGB = [0, 0, 0]): RGB {
  const hex = /^#([0-9a-f]{6})$/i.exec(color);
  if (hex) return [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16)) as RGB;
  const m = /rgba?\(\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\s*\)/.exec(color)!;
  const a = m[4] === undefined ? 1 : parseFloat(m[4]);
  return [1, 2, 3].map((i) => parseFloat(m[i]) * a + over[i - 1] * (1 - a)) as RGB;
}
function luminance([r, g, b]: RGB): number {
  const [R, G, B] = [r, g, b].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * R + 0.7152 * G + 0.0722 * B;
}
function contrast(fg: string, bg: string): number {
  const back = rgb(bg);
  const [hi, lo] = [luminance(rgb(fg, back)), luminance(back)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
}

describe("refined theme chrome", () => {
  for (const theme of THEMES) {
    describe(theme, () => {
      const v = themeVars(theme);

      it("defines a status bar surface and joins the active tab to the terminal colour", () => {
        expect(v["bg-statusbar"]).toBeDefined();
        expect(v["bg-tab-active"].toLowerCase()).toBe(
          SettingsService.getThemeColors(theme).background!.toLowerCase()
        );
      });

      it("keeps hint and secondary text readable, in the right order, on the tab bar and status bar", () => {
        for (const bg of ["bg-tab-bar", "bg-statusbar"]) {
          const secondary = contrast(v["text-secondary"], v[bg]);
          const hint = contrast(v["text-tertiary"], v[bg]);
          expect(secondary, `secondary on ${bg}`).toBeGreaterThanOrEqual(5.4);
          expect(hint, `hint on ${bg}`).toBeGreaterThanOrEqual(5.2);
          expect(secondary, `hierarchy on ${bg}`).toBeGreaterThanOrEqual(hint);
        }
        expect(contrast(v["text-primary"], v["bg-tab-active"])).toBeGreaterThanOrEqual(4.5);
      });

      it("separates the chrome from the terminal so the layers read as layers", () => {
        const lum = (k: string) => luminance(rgb(v[k]));
        const [a, b] = [lum("bg-tab-bar"), lum("bg-tab-active")].sort((x, y) => y - x);
        expect((a + 0.05) / (b + 0.05)).toBeGreaterThan(1.05);
        expect(v["bg-tab-inactive"]).not.toBe(v["bg-tab-bar"]);
      });
    });
  }
});

describe("bundled fonts", () => {
  const fontsCss = fs.readFileSync(path.join(ROOT, "src/fonts.css"), "utf8");

  it("declares Inter and JetBrains Mono from files that exist in the package", () => {
    for (const family of ["Inter Variable", "JetBrains Mono Variable"]) {
      expect(fontsCss).toContain(`font-family: "${family}"`);
    }
    const urls = [...fontsCss.matchAll(/url\("(@fontsource-variable\/[^"]+)"\)/g)].map((m) => m[1]);
    expect(urls).toHaveLength(4);
    for (const u of urls) {
      expect(fs.existsSync(path.join(ROOT, "node_modules", u)), u).toBe(true);
    }
  });

  it("is loaded before the app renders, and the packages are real dependencies", () => {
    const main = fs.readFileSync(path.join(ROOT, "src/main.tsx"), "utf8");
    expect(main).toContain('import "./fonts.css"');
    expect(main).toContain("document.fonts.load");
    const deps = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).dependencies;
    expect(deps["@fontsource-variable/inter"]).toBeDefined();
    expect(deps["@fontsource-variable/jetbrains-mono"]).toBeDefined();
  });

  it("puts the bundled faces first in the UI and terminal stacks", () => {
    expect(css).toMatch(/--font-sans:\s*"Inter Variable"/);
    expect(css).toMatch(/--font-mono:\s*"JetBrains Mono Variable"/);
    expect(DEFAULT_SETTINGS.fontFamily.startsWith("'JetBrains Mono Variable'")).toBe(true);
  });

  it("keeps a fallback chain so a missing font never leaves an empty terminal", () => {
    expect(DEFAULT_SETTINGS.fontFamily).toMatch(/monospace$/);
  });
});

describe("font setting migration", () => {
  beforeEach(() => localStorage.clear());

  it("moves people still on the old default stack to the bundled font", () => {
    localStorage.setItem(
      "kai_user_settings",
      JSON.stringify({ ...DEFAULT_SETTINGS, fontFamily: PREVIOUS_DEFAULT_FONT_FAMILY })
    );
    expect(SettingsService.loadSettings().fontFamily).toBe(DEFAULT_SETTINGS.fontFamily);
  });

  it("leaves a font the person chose themselves alone", () => {
    localStorage.setItem(
      "kai_user_settings",
      JSON.stringify({ ...DEFAULT_SETTINGS, fontFamily: '"Cascadia Code", monospace' })
    );
    expect(SettingsService.loadSettings().fontFamily).toBe('"Cascadia Code", monospace');
  });
});

describe("header layout", () => {
  it("no longer ships toolbar or editor-dropdown styles that nothing renders", () => {
    for (const dead of [".terminal-toolbar", ".toolbar-group", ".editor-dropdown-menu"]) {
      expect(css).not.toContain(dead);
    }
  });
});
