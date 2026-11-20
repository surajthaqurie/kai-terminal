import {
  UserSettings,
  ThemeName,
  CursorStyle,
  FixedShortcutsConfig,
  KeybindingsConfig,
  ProjectWorkspaceSettings,
} from "../types/terminal";
import { ITheme } from "@xterm/xterm";
import { THEMES, canvasColor, getTheme, isThemeId } from "../theme/registry";
import { PtyService } from "./ptyService";
import {
  DEFAULT_FIXED_SHORTCUTS,
  findConflicts,
  parseBinding,
  resolveFixedBindings,
  type ShortcutActionId,
} from "./shortcuts";

/**
 * Windows Terminal-style defaults. Ctrl+Shift is for tabs and app panels,
 * Alt+Shift is for panes, and nothing needs Ctrl+Alt (which is AltGr on
 * Windows, so it types characters on many layouts). Ctrl and Cmd are
 * interchangeable.
 */
export const DEFAULT_KEYBINDINGS: KeybindingsConfig = {
  newTab: "Ctrl+Shift+T",
  closeTab: "Ctrl+Shift+W",
  splitHorizontal: "Alt+Shift+-",
  splitVertical: "Alt+Shift+=",
  closePane: "Alt+Shift+W",
  search: "Ctrl+Shift+F",
  commandPalette: "Ctrl+Shift+P",
  settings: "Ctrl+,",
  nextTab: "Ctrl+Tab",
  prevTab: "Ctrl+Shift+Tab",
  nextPane: "Alt+Shift+]",
  prevPane: "Alt+Shift+[",
  // One cluster on Ctrl+Shift: M opens the player, Space plays / pauses, and the
  // `<` and `>` keys go back and forward like the arrows on a media player.
  toggleMusic: "Ctrl+Shift+M",
  musicPlayPause: "Ctrl+Shift+Space",
  musicPrevious: "Ctrl+Shift+,",
  musicNext: "Ctrl+Shift+.",
  musicMute: "Ctrl+Shift+0",
};

/**
 * Mute used to sit on `Ctrl+Shift+,`, the `<` key, which belongs to Previous
 * song. Someone who never changed it moves to the new default once (see
 * `migrateMusicKeybindings`).
 */
const SUPERSEDED_MUSIC_MUTE = "Ctrl+Shift+,";

/**
 * One-time move of an untouched old Mute binding to its new default, so Mute
 * and Previous do not both claim `Ctrl+Shift+,`. A Mute binding the user chose
 * stays as chosen, and so does the old one if the new key is already taken by
 * something they bound. Returns the bindings to feed into `normalize`.
 */
export function migrateMusicKeybindings(
  saved: unknown,
  fixed?: Partial<FixedShortcutsConfig> | null
): Partial<KeybindingsConfig> {
  if (!saved || typeof saved !== "object") return {};
  const next = { ...(saved as Record<string, unknown>) } as Partial<KeybindingsConfig>;
  const current = next.musicMute;
  const parsedCurrent = typeof current === "string" ? parseBinding(current) : null;
  const parsedOld = parseBinding(SUPERSEDED_MUSIC_MUTE);
  const untouched =
    parsedCurrent !== null &&
    parsedOld !== null &&
    parsedCurrent.ctrlOrCmd === parsedOld.ctrlOrCmd &&
    parsedCurrent.alt === parsedOld.alt &&
    parsedCurrent.shift === parsedOld.shift &&
    parsedCurrent.code === parsedOld.code;
  if (!untouched) return next;
  const moved = { ...next, musicMute: DEFAULT_KEYBINDINGS.musicMute };
  const full = { ...DEFAULT_KEYBINDINGS, ...moved } as KeybindingsConfig;
  const clash = findConflicts(full, resolveFixedBindings(fixed)).some((c) =>
    c.actions.includes("musicMute")
  );
  return clash ? next : moved;
}

/**
 * The defaults before the Windows Terminal-style scheme. A saved binding that
 * still equals one of these was never customised, so it moves to the new
 * default once (see `migrateLegacyKeybindings`). Actions absent here
 * (`prevPane`) are new and simply take their default.
 */
export const LEGACY_DEFAULT_KEYBINDINGS: Readonly<Partial<KeybindingsConfig>> = {
  newTab: "Ctrl+Shift+T",
  closeTab: "Ctrl+Shift+W",
  splitHorizontal: "Ctrl+Alt+S",
  splitVertical: "Ctrl+Alt+V",
  closePane: "Ctrl+Alt+W",
  search: "Ctrl+Shift+F",
  commandPalette: "Ctrl+Shift+P",
  settings: "Ctrl+Shift+,",
  nextTab: "Ctrl+Shift+]",
  prevTab: "Ctrl+Shift+[",
  nextPane: "Ctrl+Alt+]",
  toggleMusic: "Ctrl+Alt+M",
  musicPlayPause: "Ctrl+Alt+Space",
  musicNext: "Ctrl+Alt+N",
  musicMute: "Ctrl+Alt+U",
};

/**
 * One-time move of untouched legacy defaults to the new ones. A binding the
 * user changed is left alone, and so is an old default whose replacement would
 * now collide with something the user bound (it keeps working as before).
 * Returns the bindings to feed into `normalize`; missing keys take defaults.
 */
export function migrateLegacyKeybindings(
  saved: unknown,
  fixed?: Partial<FixedShortcutsConfig> | null
): Partial<KeybindingsConfig> {
  if (!saved || typeof saved !== "object") return {};
  const input = saved as Record<string, unknown>;
  const kept: Record<string, unknown> = {};
  const moved: ShortcutActionId[] = [];
  for (const action of Object.keys(DEFAULT_KEYBINDINGS) as ShortcutActionId[]) {
    const value = input[action];
    const legacy = LEGACY_DEFAULT_KEYBINDINGS[action];
    const parsedValue = typeof value === "string" ? parseBinding(value) : null;
    const parsedLegacy = legacy ? parseBinding(legacy) : null;
    const untouched =
      parsedValue !== null &&
      parsedLegacy !== null &&
      parsedValue.ctrlOrCmd === parsedLegacy.ctrlOrCmd &&
      parsedValue.alt === parsedLegacy.alt &&
      parsedValue.shift === parsedLegacy.shift &&
      parsedValue.code === parsedLegacy.code;
    if (untouched && legacy !== DEFAULT_KEYBINDINGS[action]) {
      moved.push(action);
    } else if (value !== undefined) {
      kept[action] = value;
    }
  }
  // A moved action takes its new default unless that now collides with a kept
  // binding; then it keeps the old key so nothing silently stops working.
  const next: Partial<KeybindingsConfig> = { ...(kept as Partial<KeybindingsConfig>) };
  for (const action of moved) next[action] = DEFAULT_KEYBINDINGS[action];
  const resolvedFixed = resolveFixedBindings(fixed);
  const reverted = new Set<ShortcutActionId>();
  for (let pass = 0; pass < moved.length; pass++) {
    const full = { ...DEFAULT_KEYBINDINGS, ...next } as KeybindingsConfig;
    const clashes = findConflicts(full, resolvedFixed)
      .flatMap((c) => c.actions)
      .filter((a): a is ShortcutActionId => a in DEFAULT_KEYBINDINGS)
      .filter((a) => moved.includes(a as ShortcutActionId)) as ShortcutActionId[];
    const target = clashes.find((a) => !reverted.has(a));
    if (!target) break;
    reverted.add(target);
    next[target] = LEGACY_DEFAULT_KEYBINDINGS[target] as string;
  }
  return next;
}

/** Default terminal font before the bundled JetBrains Mono; still migrated on load. */
export const PREVIOUS_DEFAULT_FONT_FAMILY =
  "'Fira Code', 'FiraCode', 'DejaVu Sans Mono', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace";

/** Terminal layout defaults and limits (Settings → Terminal). */
export const TERMINAL_LAYOUT_DEFAULTS = { lineHeight: 1.2, paddingX: 6, paddingY: 4 } as const;
export const TERMINAL_LAYOUT_LIMITS = {
  lineHeight: { min: 1, max: 2 },
  padding: { min: 0, max: 24 },
} as const;

export const DEFAULT_SETTINGS: UserSettings = {
  theme: "kai-dark",
  fontFamily:
    "'JetBrains Mono Variable', 'JetBrains Mono', 'Fira Code', 'DejaVu Sans Mono', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace",
  fontSize: 14,
  // The values Kai always used before these became settings: an older saved
  // file has none of them and so keeps exactly the look it had.
  lineHeight: TERMINAL_LAYOUT_DEFAULTS.lineHeight,
  terminalPaddingX: TERMINAL_LAYOUT_DEFAULTS.paddingX,
  terminalPaddingY: TERMINAL_LAYOUT_DEFAULTS.paddingY,
  scrollback: 10000,
  cursorBlink: true,
  cursorStyle: "block",
  opacity: 1.0,
  customShellPath: "",
  editorPath: "",
  launchAtStartup: false,
  autoRestoreSession: false,
  autoCheckUpdates: true,
  skipShellProfile: false,
  showMusicPlayer: false,
  musicStartMuted: false,
  keybindings: DEFAULT_KEYBINDINGS,
  fixedKeybindings: { ...DEFAULT_FIXED_SHORTCUTS },
};

const STORAGE_KEY = "kai_user_settings";
const LEGACY_STORAGE_KEY = "terminal_user_settings";
const PROJECT_SETTINGS_PREFIX = "kai_project_settings_";
const LEGACY_PROJECT_SETTINGS_PREFIX = "terminal_project_settings_";
const SETTINGS_VERSION = 1;
/** Stored beside the settings once they were saved after the 14 -> 12 font default change. */
const FONT_DEFAULT_MIGRATED = "_fontDefaultMigrated";
/** Stored beside the settings once they were saved after the shortcut-defaults change. */
const KEYBINDINGS_MIGRATED = "_keybindingsMigrated";
/** Stored beside the settings once they were saved after the 14 / blinking-cursor defaults returned. */
const TERMINAL_DEFAULTS_MIGRATED = "_terminalDefaultsMigrated";
/** The font size and cursor blink defaults before they became 14 and on. */
const PREVIOUS_DEFAULT_FONT_SIZE = 12;
const PREVIOUS_DEFAULT_CURSOR_BLINK = false;
/** Stored beside the settings once they were saved after Mute moved off `Ctrl+Shift+,`. */
const MUSIC_KEYS_MIGRATED = "_musicKeysMigrated";

/** Theme ids removed in a later release, mapped to the theme that replaces them. */
const LEGACY_THEME_IDS: Readonly<Record<string, ThemeName>> = {
  kali: "kai-dark",
};

/** Themes with a light background: drives the native `color-scheme` and scrollbars. */
export function isLightTheme(theme: ThemeName): boolean {
  return getTheme(theme).colorScheme === "light";
}

/**
 * Coerce any input to a known theme id. A removed theme (`kali`) moves to its
 * replacement; unknown/missing values recover to the default ("Kai Dark") so
 * the Appearance panel never renders with nothing selected.
 */
export function normalizeThemeId(input: unknown): ThemeName {
  if (typeof input !== "string") return DEFAULT_SETTINGS.theme;
  if (isThemeId(input)) return input;
  return LEGACY_THEME_IDS[input] ?? DEFAULT_SETTINGS.theme;
}

/** Colour behind the panes and window chrome, per theme (from the theme registry). */
export const THEME_CANVAS_COLORS: Readonly<Record<ThemeName, string>> = Object.fromEntries(
  THEMES.map((t) => [t.id, canvasColor(t)])
) as Record<ThemeName, string>;

export class SettingsService {
  /** Validates and clamps settings; always recovers to safe defaults. */
  static normalize(input: Partial<UserSettings>): UserSettings {
    const merged: UserSettings = {
      ...DEFAULT_SETTINGS,
      ...input,
      keybindings: {
        ...DEFAULT_KEYBINDINGS,
        ...(input.keybindings || {}),
      },
    };
    // Sanitize keybindings: corrupted persisted values recover to defaults
    // instead of breaking the shortcut registry. Full conflict detection
    // lives in shortcuts.ts + the settings UI.
    const kb = merged.keybindings as unknown as Record<string, unknown>;
    // Drop obsolete bindings from older versions (e.g. removed restart).
    for (const key of Object.keys(kb)) {
      if (!(key in DEFAULT_KEYBINDINGS)) delete kb[key];
    }
    for (const key of Object.keys(DEFAULT_KEYBINDINGS) as Array<keyof KeybindingsConfig>) {
      const v = kb[key];
      // Same parser the shortcut registry uses, so every binding the recorder
      // accepts (including a bare "F5") survives a save and a reload.
      if (typeof v !== "string" || v.length > 32 || /[\0\n\r]/.test(v) || !parseBinding(v)) {
        kb[key] = DEFAULT_KEYBINDINGS[key];
      } else {
        kb[key] = v.trim().slice(0, 32);
      }
    }
    // Remappable terminal shortcuts: unparsable entries recover to defaults.
    merged.fixedKeybindings = resolveFixedBindings(input.fixedKeybindings);
    merged.theme = normalizeThemeId(merged.theme);

    const cursorStyles: Array<NonNullable<UserSettings["cursorStyle"]>> = [
      "block",
      "underline",
      "bar",
    ];
    if (!merged.cursorStyle || !cursorStyles.includes(merged.cursorStyle)) {
      merged.cursorStyle = "block";
    }

    if (!Number.isFinite(merged.opacity) || merged.opacity === undefined) {
      merged.opacity = 1.0;
    } else {
      merged.opacity = Math.max(0.2, Math.min(1.0, Math.round(merged.opacity * 100) / 100));
    }

    if (typeof merged.fontFamily !== "string" || !merged.fontFamily.trim()) {
      merged.fontFamily = DEFAULT_SETTINGS.fontFamily;
    } else {
      merged.fontFamily = merged.fontFamily.slice(0, 512);
    }
    if (!Number.isFinite(merged.fontSize)) merged.fontSize = DEFAULT_SETTINGS.fontSize;
    merged.fontSize = Math.max(8, Math.min(36, Math.round(merged.fontSize)));
    const clamp = (v: unknown, min: number, max: number, fallback: number) =>
      typeof v === "number" && Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : fallback;
    const { lineHeight, padding } = TERMINAL_LAYOUT_LIMITS;
    merged.lineHeight =
      Math.round(
        clamp(
          merged.lineHeight,
          lineHeight.min,
          lineHeight.max,
          TERMINAL_LAYOUT_DEFAULTS.lineHeight
        ) * 100
      ) / 100;
    merged.terminalPaddingX = Math.round(
      clamp(merged.terminalPaddingX, padding.min, padding.max, TERMINAL_LAYOUT_DEFAULTS.paddingX)
    );
    merged.terminalPaddingY = Math.round(
      clamp(merged.terminalPaddingY, padding.min, padding.max, TERMINAL_LAYOUT_DEFAULTS.paddingY)
    );
    if (!Number.isFinite(merged.scrollback)) merged.scrollback = 10000;
    merged.scrollback = Math.max(1000, Math.min(100000, Math.round(merged.scrollback)));
    merged.cursorBlink = Boolean(merged.cursorBlink);
    if (typeof merged.customShellPath !== "string" || merged.customShellPath.includes("\0")) {
      merged.customShellPath = "";
    } else {
      merged.customShellPath = merged.customShellPath.trim().slice(0, 4096);
    }
    if (typeof merged.editorPath !== "string" || merged.editorPath.includes("\0")) {
      merged.editorPath = "";
    } else {
      merged.editorPath = merged.editorPath.trim().slice(0, 4096);
    }
    if (merged.defaultShellId !== undefined && typeof merged.defaultShellId !== "string") {
      merged.defaultShellId = undefined;
    }
    merged.launchAtStartup = Boolean(merged.launchAtStartup);
    merged.autoRestoreSession = Boolean(merged.autoRestoreSession);
    merged.skipShellProfile = Boolean(merged.skipShellProfile);
    merged.showMusicPlayer = Boolean(merged.showMusicPlayer);
    merged.musicStartMuted = Boolean(merged.musicStartMuted);
    merged.autoCheckUpdates =
      merged.autoCheckUpdates === undefined ? true : Boolean(merged.autoCheckUpdates);
    return merged;
  }

  static loadSettings(): UserSettings {
    try {
      const stored = localStorage.getItem(STORAGE_KEY) || localStorage.getItem(LEGACY_STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        // Version-tolerant: unknown future keys are dropped by normalize.
        void parsed.version;
        // Migrate legacy hardcoded font and 14px default if unmodified
        if (
          parsed.fontFamily === 'Menlo, Monaco, "Courier New", monospace' ||
          parsed.fontFamily === "Menlo, Monaco, 'Courier New', monospace" ||
          parsed.fontFamily === PREVIOUS_DEFAULT_FONT_FAMILY
        ) {
          parsed.fontFamily = DEFAULT_SETTINGS.fontFamily;
        }
        // One-time: the default moved from 14 to 12. Every save writes
        // FONT_DEFAULT_MIGRATED, so a 14 the user chose afterwards is kept.
        if (parsed.fontSize === 14 && !parsed[FONT_DEFAULT_MIGRATED]) {
          parsed.fontSize = 12;
        }
        // One-time: the defaults are now font size 14 and a blinking cursor. A saved
        // 12 / off is what every install wrote while those were the defaults, so it
        // moves once; anything else the user picked is kept. Every save writes
        // TERMINAL_DEFAULTS_MIGRATED, so a 12 or a steady cursor chosen afterwards
        // stays. (Runs after the 14 -> 12 step above, so an old 14 ends up at 14.)
        if (!parsed[TERMINAL_DEFAULTS_MIGRATED]) {
          if (parsed.fontSize === PREVIOUS_DEFAULT_FONT_SIZE) {
            parsed.fontSize = DEFAULT_SETTINGS.fontSize;
          }
          if (parsed.cursorBlink === PREVIOUS_DEFAULT_CURSOR_BLINK) {
            parsed.cursorBlink = DEFAULT_SETTINGS.cursorBlink;
          }
        }
        // One-time: the default shortcuts moved to the Windows Terminal-style
        // scheme. Every save writes KEYBINDINGS_MIGRATED, so a combo the user
        // sets afterwards (even an old default) is kept as chosen.
        if (!parsed[KEYBINDINGS_MIGRATED]) {
          parsed.keybindings = migrateLegacyKeybindings(
            parsed.keybindings,
            parsed.fixedKeybindings
          );
        }
        // One-time: Mute moved off `Ctrl+Shift+,` so Previous song can have it.
        if (!parsed[MUSIC_KEYS_MIGRATED]) {
          parsed.keybindings = migrateMusicKeybindings(parsed.keybindings, parsed.fixedKeybindings);
        }
        return SettingsService.normalize(parsed);
      }
    } catch {
      // Fallback on error
    }
    return { ...DEFAULT_SETTINGS };
  }

  /**
   * Discovers and returns host system terminal preferences (e.g. Kali Linux
   * QTerminal / XFCE terminal / system monospace font) via backend IPC.
   */
  static async loadSystemDefaults(): Promise<Partial<UserSettings>> {
    const config = await PtyService.getSystemTerminalConfig();
    if (!config) return {};
    return {
      fontFamily: config.font_family || DEFAULT_SETTINGS.fontFamily,
      fontSize: DEFAULT_SETTINGS.fontSize,
      theme: normalizeThemeId(config.theme),
      cursorBlink: config.cursor_blink ?? DEFAULT_SETTINGS.cursorBlink,
      cursorStyle: (config.cursor_style as CursorStyle) || "block",
      opacity: config.opacity ?? 1.0,
    };
  }

  static saveSettings(settings: UserSettings): void {
    try {
      const safe = SettingsService.normalize(settings);
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          ...safe,
          version: SETTINGS_VERSION,
          [FONT_DEFAULT_MIGRATED]: true,
          [KEYBINDINGS_MIGRATED]: true,
          [MUSIC_KEYS_MIGRATED]: true,
          [TERMINAL_DEFAULTS_MIGRATED]: true,
        })
      );
    } catch {
      // Fail silently if localStorage disabled
    }
  }

  static getProjectSettings(projectDir: string): ProjectWorkspaceSettings | null {
    if (!projectDir || !projectDir.trim()) return null;
    try {
      const key = `${PROJECT_SETTINGS_PREFIX}${encodeURIComponent(projectDir.trim())}`;
      const legacyKey = `${LEGACY_PROJECT_SETTINGS_PREFIX}${encodeURIComponent(projectDir.trim())}`;
      const raw = localStorage.getItem(key) || localStorage.getItem(legacyKey);
      if (raw) {
        return JSON.parse(raw) as ProjectWorkspaceSettings;
      }
    } catch {
      // ignore errors
    }
    return null;
  }

  static saveProjectSettings(settings: ProjectWorkspaceSettings): void {
    if (!settings.projectDir || !settings.projectDir.trim()) return;
    try {
      const key = `${PROJECT_SETTINGS_PREFIX}${encodeURIComponent(settings.projectDir.trim())}`;
      localStorage.setItem(key, JSON.stringify(settings));
    } catch {
      // ignore errors
    }
  }

  static getThemeColors(themeName: ThemeName, opacity: number = 1.0): ITheme {
    const baseTheme: ITheme = getTheme(themeName).terminal;

    if (opacity < 1.0 && baseTheme.background) {
      return {
        ...baseTheme,
        background: SettingsService.colorWithOpacity(baseTheme.background, opacity),
      };
    }
    return baseTheme;
  }

  static colorWithOpacity(hexColor: string, opacity: number): string {
    if (opacity >= 1.0) return hexColor;
    let hex = hexColor.replace("#", "").trim();
    if (hex.length === 3) {
      hex = hex
        .split("")
        .map((c) => c + c)
        .join("");
    }
    if (hex.length === 6) {
      const r = parseInt(hex.substring(0, 2), 16) || 0;
      const g = parseInt(hex.substring(2, 4), 16) || 0;
      const b = parseInt(hex.substring(4, 6), 16) || 0;
      const alpha = Math.max(0.2, Math.min(1.0, opacity));
      return `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(2)})`;
    }
    return hexColor;
  }

  static getThemeBackgroundColor(themeName: ThemeName, opacity: number = 1.0): string {
    const colors = SettingsService.getThemeColors(themeName, opacity);
    return colors.background || THEME_CANVAS_COLORS[DEFAULT_SETTINGS.theme];
  }

  static getThemeCanvasColor(themeName: ThemeName): string {
    return THEME_CANVAS_COLORS[themeName] ?? THEME_CANVAS_COLORS[DEFAULT_SETTINGS.theme];
  }
}
