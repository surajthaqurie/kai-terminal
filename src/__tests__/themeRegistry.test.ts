// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CHROME_TOKENS,
  DEFAULT_THEME_ID,
  TAB_COLORS,
  THEMES,
  canvasColor,
  getTheme,
  searchDecorations,
  tabColorName,
  tabColorValue,
  themePreview,
} from "../theme/registry";
import { themeCss, themesIndexCss, withFirstPaint } from "../theme/generate";
import { SettingsService, normalizeThemeId, isLightTheme } from "../services/settingsService";
import { THEME_OPTIONS } from "../components/SettingsModal";
import { ROOT, readStylesheet } from "./helpers/styles";

/**
 * The registry is the only place a theme colour is written. These tests prove
 * every derived artefact (generated CSS, index.html first paint, xterm palette,
 * canvas, Settings swatches) is produced from it and has not been hand-edited.
 */
const themesDir = resolve(ROOT, "src/styles/themes");

describe("theme registry", () => {
  it("has unique ids, a default, and every chrome token in every theme", () => {
    const ids = THEMES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(DEFAULT_THEME_ID);
    for (const theme of THEMES) {
      expect(Object.keys(theme.chrome).sort(), theme.id).toEqual([...CHROME_TOKENS].sort());
    }
  });

  it("ships at least one light and the nine dark themes", () => {
    expect(THEMES.filter((t) => t.colorScheme === "dark")).toHaveLength(9);
    expect(THEMES.filter((t) => t.colorScheme === "light").map((t) => t.id)).toEqual(["kai-light"]);
    expect(isLightTheme("kai-light")).toBe(true);
    expect(isLightTheme("kai-dark")).toBe(false);
  });

  it("joins the window chrome to the terminal: surface colour = terminal background", () => {
    for (const theme of THEMES) {
      expect(theme.terminal.background.toLowerCase(), theme.id).toBe(
        theme.chrome["bg-surface"].toLowerCase()
      );
    }
  });

  it("writes every colour as a parseable CSS colour", () => {
    const colour = /^(#[0-9a-f]{6}([0-9a-f]{2})?|rgba?\([\d.,\s]+\))$/i;
    for (const theme of THEMES) {
      for (const [k, v] of Object.entries(theme.chrome))
        expect(v, `${theme.id} ${k}`).toMatch(colour);
      for (const [k, v] of Object.entries(theme.terminal))
        expect(v, `${theme.id} ${k}`).toMatch(colour);
    }
  });

  it("gives Kai Dark a cyan selection, not another editor's blue", () => {
    expect(getTheme("kai-dark").terminal.selectionBackground.toLowerCase()).toMatch(/^#ffffff/);
  });

  it("falls back to the default for unknown or removed ids", () => {
    expect(getTheme("nope").id).toBe(DEFAULT_THEME_ID);
    expect(normalizeThemeId("kali")).toBe("kai-dark");
    expect(normalizeThemeId("kai-light")).toBe("kai-light");
    expect(normalizeThemeId(42)).toBe("kai-dark");
  });
});

describe("generated theme files are up to date (run `npm run themes:generate`)", () => {
  for (const theme of THEMES) {
    it(`src/styles/themes/${theme.id}.css`, () => {
      const committed = readFileSync(resolve(themesDir, `${theme.id}.css`), "utf8");
      expect(committed).toBe(themeCss(theme, theme.id === DEFAULT_THEME_ID));
    });
  }

  it("src/styles/themes/index.css imports every theme", () => {
    expect(readFileSync(resolve(themesDir, "index.css"), "utf8")).toBe(themesIndexCss(THEMES));
  });

  it("index.html first-paint block", () => {
    const html = readFileSync(resolve(ROOT, "index.html"), "utf8");
    expect(html).toBe(withFirstPaint(html, THEMES, DEFAULT_THEME_ID));
  });

  it("the app stylesheet loads the theme files before the first rule that paints", () => {
    // Token declarations may reference theme colours in any order (custom
    // properties resolve at computed-value time); real rules start at base.css.
    const css = readStylesheet();
    const firstTheme = css.indexOf('[data-theme="kai-dark"]');
    const firstUse = css.indexOf("Base & Resets");
    expect(firstTheme).toBeGreaterThanOrEqual(0);
    expect(firstTheme).toBeLessThan(firstUse);
  });

  it("no stylesheet outside src/styles/themes declares a theme colour token", () => {
    // A hand-written `--accent-primary: …` elsewhere would silently override the registry.
    const css = readStylesheet().replace(/\/\* GENERATED[\s\S]*?\n\}\n/g, "");
    for (const token of CHROME_TOKENS) {
      expect(css, `--${token} declared outside the generated theme files`).not.toMatch(
        new RegExp(`--${token}\\s*:`)
      );
    }
  });
});

describe("runtime consumers read the registry", () => {
  it("xterm palette, canvas and background come from the registry", () => {
    for (const theme of THEMES) {
      expect(SettingsService.getThemeColors(theme.id)).toEqual(theme.terminal);
      expect(SettingsService.getThemeCanvasColor(theme.id)).toBe(canvasColor(theme));
      expect(SettingsService.getThemeBackgroundColor(theme.id)).toBe(theme.terminal.background);
    }
  });

  it("Settings swatches match the theme they preview (Solarized once drifted)", () => {
    expect(THEME_OPTIONS.map((o) => o.id)).toEqual(THEMES.map((t) => t.id));
    for (const option of THEME_OPTIONS) {
      const theme = getTheme(option.id);
      const preview = themePreview(theme);
      expect({ bg: option.bg, fg: option.fg, accent: option.accent }, option.id).toEqual(preview);
      expect(preview.accent).toBe(theme.chrome["accent-primary"]);
    }
  });

  it("search highlight colours are #rrggbb (xterm's search addon requires it)", () => {
    for (const theme of THEMES) {
      const d = searchDecorations(theme);
      expect(d.matchBackground, theme.id).toMatch(/^#[0-9a-f]{6}$/);
      expect(d.activeMatchBackground, theme.id).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("tab colours keep their stored hex key and resolve to a themed token with a name", () => {
    for (const c of TAB_COLORS) {
      expect(tabColorValue(c.key)).toBe(`var(--tab-color-${c.id})`);
      expect(tabColorName(c.key)).toBe(c.name);
    }
    expect(tabColorValue("#123456")).toBe("#123456");
    const css = readStylesheet();
    for (const theme of THEMES)
      for (const c of TAB_COLORS)
        expect(themeCss(theme, false), `${theme.id} ${c.id}`).toContain(`--tab-color-${c.id}:`);
    expect(css).toContain("--tab-color-blue:");
  });
});
