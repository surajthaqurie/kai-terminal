// @vitest-environment node
import { describe, expect, it } from "vitest";
import { readStylesheet } from "./helpers/styles";

/**
 * Design-system guardrails. A `var(--x)` that nothing defines resolves to
 * nothing (or to whatever hard-coded fallback someone typed), which is how
 * the indigo hovers and missing music hovers in the audit happened.
 */
const css = readStylesheet();
/** Rules only: comments may mention values ("z-index: 2100") without setting them. */
const rules = css.replace(/\/\*[\s\S]*?\*\//g, "");

/** Set at runtime by components (`style.setProperty` / inline style), never in CSS. */
const RUNTIME_VARIABLES = new Set([
  "--tab-color", // TabBar: the tab's chosen colour
  "--win-alpha", // index.html boot script + windowOpacity.ts
  "--music-custom-opacity", // music player dimmer
  "--music-dim-arrow", // music dim popover arrow position
  "--music-pip-opacity", // music picture-in-picture window
]);

const declared = new Set([...css.matchAll(/(--[a-z0-9-]+)\s*:/gi)].map((m) => m[1]));
const referenced = [...css.matchAll(/var\(\s*(--[a-z0-9-]+)\s*([,)])/gi)];

describe("design tokens", () => {
  it("every var() refers to a token that is defined, or to an allow-listed runtime variable", () => {
    const missing = [
      ...new Set(
        referenced.map((m) => m[1]).filter((v) => !declared.has(v) && !RUNTIME_VARIABLES.has(v))
      ),
    ];
    expect(missing, `undefined custom properties: ${missing.join(", ")}`).toEqual([]);
  });

  it("only runtime variables carry a fallback (a fallback on a real token hides a typo)", () => {
    const withFallback = [
      ...new Set(referenced.filter((m) => m[2] === ",").map((m) => m[1])),
    ].filter((v) => !RUNTIME_VARIABLES.has(v));
    expect(withFallback).toEqual([]);
  });

  it("no colour from another design system leaks in (Tailwind indigo / violet / red)", () => {
    for (const foreign of ["#6366f1", "#8b5cf6", "#ef4444", "99, 102, 241"]) {
      expect(css.toLowerCase(), foreign).not.toContain(foreign);
    }
  });

  it("declares no token that nothing uses (a scale entry without a use is noise)", () => {
    const used = (token: string) =>
      new RegExp(`var\\(\\s*${token}\\s*[,)]`).test(css) ||
      // Read by name from TypeScript (tabColorValue builds `--tab-color-<id>`).
      token.startsWith("--tab-color-");
    const unused = [...declared].filter((t) => !RUNTIME_VARIABLES.has(t) && !used(t));
    expect(unused, `unused custom properties: ${unused.join(", ")}`).toEqual([]);
  });

  it("uses the global layer tokens for anything that floats over the app", () => {
    const raw = [...rules.matchAll(/z-index:\s*(\d+)/g)].map((m) => Number(m[1]));
    expect(raw.filter((z) => z >= 100)).toEqual([]);
  });

  it("keeps UI text on the type scale (no raw pixel font sizes below 14px)", () => {
    const raw = [...rules.matchAll(/font-size:\s*([\d.]+)px/g)].map((m) => Number(m[1]));
    expect(raw.filter((px) => px < 14)).toEqual([]);
  });

  it("defines the semantic and state tokens every component relies on", () => {
    for (const token of [
      "--state-hover",
      "--state-active",
      "--state-disabled-opacity",
      "--focus-ring-color",
      "--focus-ring-width",
      "--color-info",
      "--color-info-bg",
      "--bg-tab-bar",
      "--bg-statusbar",
      "--bg-tab-active",
      "--bg-tab-inactive",
      "--bg-tab-hover",
    ]) {
      expect(declared.has(token), token).toBe(true);
    }
  });
});

describe("button states", () => {
  const rule = (selector: string) => {
    const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[\\s,}])${esc}\\s*[,{]`, "m").test(css);
  };

  it("styles the danger variant used by destructive actions", () => {
    expect(rule(".btn-danger")).toBe(true);
    expect(rule(".btn-danger:hover:not(:disabled)")).toBe(true);
  });

  it("gives disabled buttons a disabled look and no hover / press feedback", () => {
    expect(rule(".btn:disabled")).toBe(true);
    expect(css).toMatch(
      /\.btn:disabled,\s*\.btn\[aria-disabled="true"\]\s*\{[^}]*cursor:\s*not-allowed/
    );
    // Every hover/press rule on a .btn variant is gated on :not(:disabled).
    const ungated = [
      ...css.matchAll(/(\.btn(?:-[a-z]+)?):(hover|active)(?!:not\(:disabled\))/g),
    ].map((m) => m[0]);
    expect(ungated).toEqual([]);
  });

  it("does not animate every property (`transition: all`) on buttons", () => {
    const btn = /\n\.btn\s*\{[^}]*\}/.exec(css)?.[0] ?? "";
    expect(btn).not.toMatch(/transition:\s*all/);
  });
});

describe("split panes", () => {
  it("only frames the active pane when the tab is split", () => {
    expect(css).toMatch(/\.pane-grid\[data-split="true"\] \.pane-item\.active-pane::after/);
    expect(css).not.toMatch(/\n\.pane-item\.active-pane::after/);
  });
});
