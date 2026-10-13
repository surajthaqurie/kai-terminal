// @vitest-environment node
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { SettingsService } from "../services/settingsService";
import type { ThemeName } from "../types/terminal";

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
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

function themeVars(css: string, theme: string): Record<string, string> {
  const blockRegex = /\[data-theme="([^"]+)"\][\s\S]*?\{([\s\S]*?)\}/g;
  let match: RegExpExecArray | null;
  // :root carries the kali defaults; a theme block overrides them.
  const rootVars: Record<string, string> = {};
  const rootMatch = /:root[\s\S]*?\{([\s\S]*?)\}/.exec(css);
  const varRegex = /--([a-z0-9-]+)\s*:\s*([^;]+);/g;
  if (rootMatch) {
    let v: RegExpExecArray | null;
    while ((v = varRegex.exec(rootMatch[1])) !== null) {
      rootVars["--" + v[1]] = v[2].trim();
    }
  }
  while ((match = blockRegex.exec(css)) !== null) {
    if (match[1] !== theme) continue;
    const vars = { ...rootVars };
    let v: RegExpExecArray | null;
    const inner = new RegExp(varRegex.source, "g");
    while ((v = inner.exec(match[2])) !== null) {
      vars["--" + v[1]] = v[2].trim();
    }
    return vars;
  }
  return rootVars;
}

describe("Split divider visibility (no invisible seams)", () => {
  const css = fs.readFileSync(path.resolve(__dirname, "../App.css"), "utf8");
  // The divider rule must stay on the strong token: the old subtle token
  // composited to ~1.1:1 on dark terminals (kali) — an invisible seam.
  it("keeps .pane-divider on the --border-strong token", () => {
    const rule = /\.pane-divider\s*\{[^}]*\}/.exec(css);
    expect(rule, ".pane-divider rule must exist in App.css").toBeDefined();
    expect(rule![0]).toContain("var(--border-strong)");
  });

  const THEMES: ThemeName[] = [
    "kali",
    "catppuccin-mocha",
    "tokyo-night",
    "nord",
    "one-dark",
    "dracula",
    "solarized-dark",
    "solarized-light",
  ];

  for (const theme of THEMES) {
    it(`divider is distinguishable from the terminal background in "${theme}"`, () => {
      const vars = themeVars(css, theme);
      const divider = vars["--border-strong"] as string | undefined;
      expect(divider, `Theme ${theme} must define --border-strong`).toBeDefined();
      if (!divider) return;
      // The seam sits between two xterm panes: composite the divider color
      // over the theme's terminal background (opacity 1).
      const termBg = SettingsService.getThemeColors(theme, 1.0).background as string | undefined;
      expect(termBg, `Theme ${theme} must define a terminal background`).toBeDefined();
      if (!termBg) return;
      const ratio = contrastRatio(divider, termBg);
      // Hairline floor (not text AA): the seam must be perceivably different
      // from the terminal background. The old subtle token scored ~1.1-1.4.
      expect(
        ratio,
        `Divider invisible in theme "${theme}": ${divider} over terminal ${termBg} = ${ratio.toFixed(2)}:1, expected >= 1.6:1`
      ).toBeGreaterThanOrEqual(1.6);
    });
  }
});
