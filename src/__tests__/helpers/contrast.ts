/** WCAG 2.x contrast helpers shared by the theme tests. */

export type RGB = [number, number, number];

/** Parses #rgb, #rrggbb, #rrggbbaa, rgb() and rgba(), compositing alpha over `over`. */
export function parseColor(color: string, over: RGB = [0, 0, 0]): RGB {
  const s = color.trim();
  if (s.startsWith("#")) {
    let hex = s.slice(1);
    if (hex.length === 3)
      hex = hex
        .split("")
        .map((c) => c + c)
        .join("");
    const rgb = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)) as RGB;
    const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
    return rgb.map((v, i) => v * a + over[i] * (1 - a)) as RGB;
  }
  const m = /rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)/.exec(s);
  if (!m) throw new Error(`unparseable colour: ${color}`);
  const a = m[4] === undefined ? 1 : parseFloat(m[4]);
  return [1, 2, 3].map((i) => parseFloat(m[i]) * a + over[i - 1] * (1 - a)) as RGB;
}

export function luminance([r, g, b]: RGB): number {
  const [R, G, B] = [r, g, b].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * R + 0.7152 * G + 0.0722 * B;
}

/** Contrast of `fg` (composited over `bg`) against `bg` (composited over black). */
export function contrast(fg: string, bg: string): number {
  const back = parseColor(bg);
  const [hi, lo] = [luminance(parseColor(fg, back)), luminance(back)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
}

/** `rgb(...)` string for a colour composited over another (for nested tints). */
export function composite(fg: string, bg: string): string {
  const [r, g, b] = parseColor(fg, parseColor(bg));
  return `rgb(${r}, ${g}, ${b})`;
}
