import { isTauriAvailable } from "./ptyService";

/**
 * Fixed-pitch test by measurement: a monospace face draws "i" as wide as "W".
 * A font that is not installed falls back to the default proportional face, so
 * it fails the test too. Pure over the measuring function (exported for tests).
 */
export function isMonospaceBy(measure: (font: string, text: string) => number, name: string) {
  if (!name || /["\\]/.test(name)) return false;
  const font = `48px "${name}"`;
  const narrow = measure(font, "iiiiiiiiii");
  const wide = measure(font, "WWWWWWWWWW");
  return narrow > 0 && Math.abs(narrow - wide) < 0.5;
}

function canvasMeasure(): ((font: string, text: string) => number) | null {
  try {
    const ctx = document.createElement("canvas").getContext("2d");
    if (!ctx) return null;
    return (font, text) => {
      ctx.font = font;
      return ctx.measureText(text).width;
    };
  } catch {
    return null;
  }
}

// Fixed-pitch but not for typing code: symbol / icon / dingbat faces, CJK
// faces (`MS Gothic`, `SimSun`, `-ExtB` / `-ExtG` extension planes), outdated
// Courier, and specialty faces (`OCR A`, `MS Outlook`, `MT Extra`).
const NOT_A_CODING_FONT = new RegExp(
  [
    "icon|symbol|dings|marlett|mdl2|emoji|outlook|mt extra|barcode",
    "-ext[a-z]$|^ocr( |$)|^courier",
    "gothic|simsun|mingliu|mincho|gulim|batang|dotum|gungsuh|simhei|kaiti|fangsong",
  ].join("|"),
  "i"
);

/** Shown first, in this order, when installed. The rest follow alphabetically. */
const PREFERRED_FONTS = [
  // Windows
  "Cascadia Code",
  "Cascadia Mono",
  "Consolas",
  "Ubuntu Sans Mono",
  // macOS
  "SF Mono",
  "Menlo",
  "Monaco",
  // Linux and cross-platform coding fonts
  "JetBrains Mono",
  "Fira Code",
  "Source Code Pro",
  "Hack",
  "DejaVu Sans Mono",
  "Liberation Mono",
  "Ubuntu Mono",
];

function fontRank(name: string): number {
  const i = PREFERRED_FONTS.findIndex((p) => p.toLowerCase() === name.toLowerCase());
  return i < 0 ? PREFERRED_FONTS.length : i;
}

/** Primary family of a CSS font stack: `"Fira Code", monospace` -> `Fira Code`. */
export function primaryFamily(stack: string): string {
  const first = stack.split(",")[0]?.trim() ?? "";
  return first.replace(/^["']|["']$/g, "");
}

/** Keeps the fixed-pitch families. Empty when widths cannot be measured. */
export function filterMonospace(names: string[]): string[] {
  const measure = canvasMeasure();
  if (!measure) return [];
  return names
    .filter((n) => !NOT_A_CODING_FONT.test(n) && isMonospaceBy(measure, n))
    .sort((x, y) => fontRank(x) - fontRank(y) || x.localeCompare(y));
}

let cached: Promise<string[]> | null = null;

/**
 * Monospace font families installed on this machine (desktop app only; the
 * backend asks the OS). Resolved once per session; any failure yields `[]` so
 * the font list simply shows its built-in presets.
 */
export function listInstalledMonospaceFonts(): Promise<string[]> {
  if (!isTauriAvailable()) return Promise.resolve([]);
  if (!cached) {
    cached = (async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const names = await invoke<string[]>("list_system_fonts_cmd");
        return filterMonospace(Array.isArray(names) ? names : []);
      } catch {
        return [];
      }
    })();
  }
  return cached;
}

/** CSS `font-family` value used for an installed family. */
export function installedFontStack(name: string): string {
  return `"${name}", monospace`;
}
