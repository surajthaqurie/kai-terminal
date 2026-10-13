// @vitest-environment node
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

function parseThemes(css: string): Record<string, Record<string, string>> {
  const themeRegex = /((?:\[data-theme="([^"]+)"\]|:root))[\s\S]*?\{([\s\S]*?)\}/g;
  const themes: Record<string, Record<string, string>> = {};
  let match: RegExpExecArray | null;
  while ((match = themeRegex.exec(css)) !== null) {
    const themeName = match[2] || "kali";
    const body = match[3];
    const vars: Record<string, string> = {};
    const varRegex = /--([a-z0-9-]+)\s*:\s*([^;]+);/g;
    let vMatch: RegExpExecArray | null;
    while ((vMatch = varRegex.exec(body)) !== null) {
      vars["--" + vMatch[1]] = vMatch[2].trim();
    }
    if (Object.keys(vars).length > 10) {
      themes[themeName] = vars;
    }
  }
  return themes;
}

interface RGB {
  r: number;
  g: number;
  b: number;
}

function parseColor(str: string, bgRgb: RGB = { r: 0, g: 0, b: 0 }): RGB {
  const s = str.trim();
  if (s.startsWith("#")) {
    let hex = s.slice(1);
    if (hex.length === 3)
      hex = hex
        .split("")
        .map((c) => c + c)
        .join("");
    return {
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16),
    };
  }
  const rgbaMatch = s.match(
    /rgba?\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)(?:\s*,\s*([0-9.]+))?\s*\)/
  );
  if (rgbaMatch) {
    const r = parseFloat(rgbaMatch[1]);
    const g = parseFloat(rgbaMatch[2]);
    const b = parseFloat(rgbaMatch[3]);
    const a = rgbaMatch[4] !== undefined ? parseFloat(rgbaMatch[4]) : 1.0;
    return {
      r: Math.round(r * a + bgRgb.r * (1 - a)),
      g: Math.round(g * a + bgRgb.g * (1 - a)),
      b: Math.round(b * a + bgRgb.b * (1 - a)),
    };
  }
  return { r: 128, g: 128, b: 128 };
}

function relLuminance(rgb: RGB): number {
  const [r, g, b] = [rgb.r / 255, rgb.g / 255, rgb.b / 255].map((v) =>
    v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
  );
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(fgStr: string, bgStr: string): number {
  const bg = parseColor(bgStr);
  const fg = parseColor(fgStr, bg);
  const l1 = relLuminance(fg);
  const l2 = relLuminance(bg);
  const max = Math.max(l1, l2);
  const min = Math.min(l1, l2);
  return (max + 0.05) / (min + 0.05);
}

describe("WCAG 2.1 AA Theme Contrast Suite", () => {
  const cssPath = path.resolve(__dirname, "../App.css");
  const css = fs.readFileSync(cssPath, "utf8");
  const themes = parseThemes(css);

  const EXPECTED_THEMES = [
    "kali",
    "catppuccin-mocha",
    "tokyo-night",
    "nord",
    "one-dark",
    "dracula",
    "solarized-dark",
    "solarized-light",
  ];

  it("validates all eight known theme definitions are parsed from App.css", () => {
    for (const expected of EXPECTED_THEMES) {
      expect(themes[expected], `Theme ${expected} must be defined in App.css`).toBeDefined();
    }
  });

  const TEXT_BACKGROUND_PAIRS: Array<{
    fg: string;
    bg: string;
    minRatio: number;
    description: string;
  }> = [
    {
      fg: "--text-primary",
      bg: "--bg-surface",
      minRatio: 4.5,
      description: "Primary text on surface",
    },
    {
      fg: "--text-primary",
      bg: "--bg-canvas",
      minRatio: 4.5,
      description: "Primary text on canvas",
    },
    {
      fg: "--text-secondary",
      bg: "--bg-surface",
      minRatio: 4.5,
      description: "Secondary text on surface",
    },
    {
      fg: "--text-secondary",
      bg: "--bg-canvas",
      minRatio: 4.5,
      description: "Secondary text on canvas",
    },
    {
      fg: "--text-tertiary",
      bg: "--bg-surface",
      minRatio: 4.5,
      description: "Tertiary metadata on surface",
    },
    {
      fg: "--accent-primary",
      bg: "--bg-surface",
      minRatio: 4.5,
      description: "Interactive accent text on surface",
    },
    {
      fg: "--color-success",
      bg: "--bg-surface",
      minRatio: 4.5,
      description: "Success status text on surface",
    },
    {
      fg: "--color-warning",
      bg: "--bg-surface",
      minRatio: 4.5,
      description: "Warning status text on surface",
    },
    {
      fg: "--color-danger",
      bg: "--bg-surface",
      minRatio: 4.5,
      description: "Danger status text on surface",
    },
    {
      fg: "--color-purple",
      bg: "--bg-surface",
      minRatio: 4.5,
      description: "Purple status text on surface",
    },
  ];

  for (const themeName of EXPECTED_THEMES) {
    it(`verifies WCAG AA 4.5:1 text contrast for theme "${themeName}"`, () => {
      const vars = themes[themeName];
      expect(vars).toBeDefined();

      for (const pair of TEXT_BACKGROUND_PAIRS) {
        const fgColor = vars[pair.fg];
        const bgColor = vars[pair.bg];
        expect(fgColor, `Theme ${themeName} missing token ${pair.fg}`).toBeDefined();
        expect(bgColor, `Theme ${themeName} missing token ${pair.bg}`).toBeDefined();

        const ratio = contrastRatio(fgColor, bgColor);
        expect(
          ratio,
          `Contrast failure in theme "${themeName}": ${pair.description} (${pair.fg}=${fgColor} on ${pair.bg}=${bgColor}) yielded ${ratio.toFixed(2)}:1, expected >= ${pair.minRatio}:1`
        ).toBeGreaterThanOrEqual(pair.minRatio);
      }
    });
  }

  const BADGE_PAIRS: Array<{
    fg: string;
    bgToken: string;
    description: string;
  }> = [
    { fg: "--color-success", bgToken: "--color-success-bg", description: "Success badge" },
    { fg: "--color-warning", bgToken: "--color-warning-bg", description: "Warning badge" },
    { fg: "--color-danger", bgToken: "--color-danger-bg", description: "Danger badge" },
    { fg: "--color-purple", bgToken: "--color-purple-bg", description: "Untracked purple badge" },
  ];

  for (const themeName of EXPECTED_THEMES) {
    it(`verifies badge contrast on composited background for theme "${themeName}"`, () => {
      const vars = themes[themeName];
      const surfaceBg = vars["--bg-surface"];

      for (const badge of BADGE_PAIRS) {
        const fg = vars[badge.fg];
        const bgRaw = vars[badge.bgToken];
        expect(fg).toBeDefined();
        expect(bgRaw).toBeDefined();

        const surfaceRgb = parseColor(surfaceBg);
        const compositedBg = parseColor(bgRaw, surfaceRgb);
        const compositedBgHex = `rgb(${compositedBg.r},${compositedBg.g},${compositedBg.b})`;

        const ratio = contrastRatio(fg, compositedBgHex);
        expect(
          ratio,
          `Badge contrast failure in theme "${themeName}": ${badge.description} (${badge.fg}=${fg} on ${badge.bgToken}) yielded ${ratio.toFixed(2)}:1, expected >= 4.5:1`
        ).toBeGreaterThanOrEqual(4.5);
      }
    });
  }
});
