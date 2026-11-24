import type { UserSettings } from "../types/terminal";

/**
 * The settings that change how a terminal LOOKS, and what each kind of change costs.
 *
 * `TerminalView` used to react to ANY new `settings` object (a music toggle, a shortcut
 * edit, each Ctrl+= zoom step, startup's system-default load) by rebuilding the glyph
 * atlas and repainting every row of every pane in every tab, WebGL panes included, then
 * re-fitting. Now it diffs the fields below and does only the work the change needs.
 */
export interface TerminalAppearance {
  fontFamily: string;
  fontSize: number;
  lineHeight: number | undefined;
  cursorBlink: boolean;
  cursorStyle: string;
  scrollback: number;
  theme: string;
  opacity: number;
}

export function terminalAppearance(settings: UserSettings): TerminalAppearance {
  return {
    fontFamily: settings.fontFamily,
    fontSize: settings.fontSize,
    lineHeight: settings.lineHeight,
    cursorBlink: settings.cursorBlink,
    cursorStyle: settings.cursorStyle || "block",
    scrollback: settings.scrollback,
    theme: settings.theme,
    opacity: settings.opacity ?? 1.0,
  };
}

export interface AppearanceChange {
  /** Fields whose value differs (all of them when nothing was applied before). */
  changed: ReadonlySet<keyof TerminalAppearance>;
  /** Glyph shapes or colours changed: the renderer's glyph atlas must be rebuilt and rows repainted. */
  rebuildGlyphs: boolean;
  /** Cell size changed: the grid has to be re-fitted and the PTY told the new cols/rows. */
  refit: boolean;
}

const KEYS = [
  "fontFamily",
  "fontSize",
  "lineHeight",
  "cursorBlink",
  "cursorStyle",
  "scrollback",
  "theme",
  "opacity",
] as const satisfies readonly (keyof TerminalAppearance)[];

/** What has to be done to take a terminal from `applied` to `next` (`null`: apply everything). */
export function diffAppearance(
  applied: TerminalAppearance | null,
  next: TerminalAppearance
): AppearanceChange {
  const changed = new Set<keyof TerminalAppearance>(
    KEYS.filter((key) => applied === null || applied[key] !== next[key])
  );
  const has = (...keys: (keyof TerminalAppearance)[]) => keys.some((k) => changed.has(k));
  return {
    changed,
    rebuildGlyphs: has("fontFamily", "fontSize", "lineHeight", "theme", "opacity"),
    refit: has("fontFamily", "fontSize", "lineHeight"),
  };
}
