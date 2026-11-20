// @vitest-environment node
import { describe, it, expect } from "vitest";
import { THEMES, type ChromeToken } from "../theme/registry";
import { composite, contrast } from "./helpers/contrast";

/**
 * WCAG 2.1 AA contrast for every theme, light and dark alike, read from the
 * theme registry: the single source the generated theme CSS is built from
 * (`themeRegistry.test.ts` proves the CSS matches it).
 */

const EXPECTED_THEMES = [
  "kai-dark",
  "gruvbox-dark",
  "catppuccin-mocha",
  "tokyo-night",
  "nord",
  "dracula",
  "solarized-dark",
  "one-dark",
  "rose-pine",
  "kai-light",
];

describe("WCAG 2.1 AA Theme Contrast Suite", () => {
  it("validates all ten known theme definitions exist in the registry", () => {
    const ids = THEMES.map((t) => t.id);
    for (const expected of EXPECTED_THEMES) {
      expect(ids, `Theme ${expected} must be defined in the registry`).toContain(expected);
    }
    expect(ids).toHaveLength(EXPECTED_THEMES.length);
  });

  const TEXT_BACKGROUND_PAIRS: Array<{
    fg: ChromeToken;
    bg: ChromeToken;
    minRatio: number;
    description: string;
  }> = [
    { fg: "text-primary", bg: "bg-surface", minRatio: 4.5, description: "Primary text on surface" },
    { fg: "text-primary", bg: "bg-canvas", minRatio: 4.5, description: "Primary text on canvas" },
    {
      fg: "text-secondary",
      bg: "bg-surface",
      minRatio: 4.5,
      description: "Secondary text on surface",
    },
    {
      fg: "text-secondary",
      bg: "bg-canvas",
      minRatio: 4.5,
      description: "Secondary text on canvas",
    },
    {
      fg: "text-tertiary",
      bg: "bg-surface",
      minRatio: 4.5,
      description: "Tertiary metadata on surface",
    },
    {
      fg: "accent-primary",
      bg: "bg-surface",
      minRatio: 4.5,
      description: "Interactive accent text on surface",
    },
    {
      fg: "color-success",
      bg: "bg-surface",
      minRatio: 4.5,
      description: "Success status text on surface",
    },
    {
      fg: "color-warning",
      bg: "bg-surface",
      minRatio: 4.5,
      description: "Warning status text on surface",
    },
    {
      fg: "color-danger",
      bg: "bg-surface",
      minRatio: 4.5,
      description: "Danger status text on surface",
    },
    {
      fg: "color-purple",
      bg: "bg-surface",
      minRatio: 4.5,
      description: "Purple status text on surface",
    },
    // Menus, the command palette, cards and popovers sit on the elevated surface.
    {
      fg: "text-primary",
      bg: "bg-surface-elevated",
      minRatio: 4.5,
      description: "Primary text on elevated surface",
    },
    {
      fg: "text-secondary",
      bg: "bg-surface-elevated",
      minRatio: 4.5,
      description: "Secondary text on elevated surface",
    },
    {
      fg: "text-tertiary",
      bg: "bg-surface-elevated",
      minRatio: 4.5,
      description: "Tertiary text on elevated surface",
    },
    {
      fg: "color-danger",
      bg: "bg-surface-elevated",
      minRatio: 4.5,
      description: "Danger text on elevated surface",
    },
    // Primary / danger button labels sit on the solid accent / danger colour.
    {
      fg: "text-inverse",
      bg: "accent-primary",
      minRatio: 4.5,
      description: "Primary button label",
    },
    {
      fg: "text-inverse",
      bg: "color-danger",
      minRatio: 4.5,
      description: "Danger button label (hover)",
    },
  ];

  for (const theme of THEMES) {
    it(`verifies WCAG AA 4.5:1 text contrast for theme "${theme.id}"`, () => {
      const v = theme.chrome;
      for (const pair of TEXT_BACKGROUND_PAIRS) {
        const ratio = contrast(v[pair.fg], v[pair.bg]);
        expect(
          ratio,
          `Contrast failure in theme "${theme.id}": ${pair.description} (${pair.fg}=${v[pair.fg]} on ${pair.bg}=${v[pair.bg]}) yielded ${ratio.toFixed(2)}:1, expected >= ${pair.minRatio}:1`
        ).toBeGreaterThanOrEqual(pair.minRatio);
      }
    });

    it(`keeps secondary and tertiary text visibly different in theme "${theme.id}"`, () => {
      // Two hierarchy levels that render the same colour carry no meaning.
      const v = theme.chrome;
      const separation = contrast(v["text-secondary"], v["text-tertiary"]);
      expect(
        separation,
        `secondary ${v["text-secondary"]} vs tertiary ${v["text-tertiary"]} = ${separation.toFixed(2)}:1`
      ).toBeGreaterThanOrEqual(1.25);
      // ... and in the right order: secondary is the stronger of the two.
      expect(contrast(v["text-secondary"], v["bg-surface"])).toBeGreaterThan(
        contrast(v["text-tertiary"], v["bg-surface"])
      );
    });
  }

  const BADGE_PAIRS: Array<{ fg: ChromeToken; bgToken: ChromeToken; description: string }> = [
    { fg: "color-success", bgToken: "color-success-bg", description: "Success badge" },
    { fg: "color-warning", bgToken: "color-warning-bg", description: "Warning badge" },
    { fg: "color-danger", bgToken: "color-danger-bg", description: "Danger badge" },
    { fg: "color-purple", bgToken: "color-purple-bg", description: "Untracked purple badge" },
    // Selected rows: primary text on the accent tint (the accent marks the row, not the text).
    { fg: "text-primary", bgToken: "accent-subtle", description: "Selected row" },
  ];

  for (const theme of THEMES) {
    it(`verifies badge contrast on composited background for theme "${theme.id}"`, () => {
      const v = theme.chrome;
      for (const surface of ["bg-surface", "bg-surface-elevated"] as const) {
        for (const badge of BADGE_PAIRS) {
          const bg = composite(v[badge.bgToken], v[surface]);
          const ratio = contrast(v[badge.fg], bg);
          expect(
            ratio,
            `Badge contrast failure in theme "${theme.id}": ${badge.description} on ${surface} yielded ${ratio.toFixed(2)}:1, expected >= 4.5:1`
          ).toBeGreaterThanOrEqual(4.5);
        }
      }
    });
  }

  for (const theme of THEMES) {
    it(`keeps terminal text readable in theme "${theme.id}"`, () => {
      const t = theme.terminal;
      expect(contrast(t.foreground, t.background)).toBeGreaterThanOrEqual(4.5);
      // Selected text keeps its colour: the selection tint must not swallow it.
      const selected = composite(t.selectionBackground, t.background);
      expect(contrast(t.foreground, selected)).toBeGreaterThanOrEqual(3);
    });
  }
});
