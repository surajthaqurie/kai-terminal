import {
  UserSettings,
  ThemeName,
  KeybindingsConfig,
  ProjectWorkspaceSettings,
} from "../types/terminal";
import { ITheme } from "@xterm/xterm";

export const DEFAULT_KEYBINDINGS: KeybindingsConfig = {
  newTab: "Ctrl+Shift+T",
  closeTab: "Ctrl+Shift+W",
  splitHorizontal: "Ctrl+Alt+S",
  splitVertical: "Ctrl+Alt+V",
  closePane: "Ctrl+Alt+W",
  search: "Ctrl+Shift+F",
  commandPalette: "Ctrl+Shift+P",
  settings: "Ctrl+Shift+,",
  restart: "Ctrl+Shift+R",
  nextTab: "Ctrl+Shift+]",
  prevTab: "Ctrl+Shift+[",
  nextPane: "Ctrl+Alt+]",
};

export const DEFAULT_SETTINGS: UserSettings = {
  theme: "catppuccin-mocha",
  fontFamily: 'Menlo, Monaco, "Courier New", monospace',
  fontSize: 14,
  scrollback: 10000,
  cursorBlink: true,
  cursorStyle: "block",
  opacity: 1.0,
  customShellPath: "",
  editorPath: "",
  keybindings: DEFAULT_KEYBINDINGS,
};

const STORAGE_KEY = "kai_user_settings";
const LEGACY_STORAGE_KEY = "terminal_user_settings";
const PROJECT_SETTINGS_PREFIX = "kai_project_settings_";
const LEGACY_PROJECT_SETTINGS_PREFIX = "terminal_project_settings_";
const SETTINGS_VERSION = 1;

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
    for (const key of Object.keys(DEFAULT_KEYBINDINGS) as Array<keyof KeybindingsConfig>) {
      const v = kb[key];
      if (typeof v !== "string" || !v.includes("+") || v.length > 32 || /[\0\n\r]/.test(v)) {
        kb[key] = DEFAULT_KEYBINDINGS[key];
      } else {
        kb[key] = v.trim().slice(0, 32);
      }
    }
    const themes: Array<UserSettings["theme"]> = [
      "catppuccin-mocha",
      "one-dark",
      "dracula",
      "solarized-dark",
      "solarized-light",
      "nord",
      "tokyo-night",
    ];
    if (!themes.includes(merged.theme)) merged.theme = DEFAULT_SETTINGS.theme;

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
    if (!Number.isFinite(merged.fontSize)) merged.fontSize = 14;
    merged.fontSize = Math.max(8, Math.min(36, Math.round(merged.fontSize)));
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
    return merged;
  }

  static loadSettings(): UserSettings {
    try {
      const stored = localStorage.getItem(STORAGE_KEY) || localStorage.getItem(LEGACY_STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        // Version-tolerant: unknown future keys are dropped by normalize.
        void parsed.version;
        return SettingsService.normalize(parsed);
      }
    } catch {
      // Fallback on error
    }
    return { ...DEFAULT_SETTINGS };
  }

  static saveSettings(settings: UserSettings): void {
    try {
      const safe = SettingsService.normalize(settings);
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...safe, version: SETTINGS_VERSION }));
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
    let baseTheme: ITheme;
    switch (themeName) {
      case "nord":
        baseTheme = {
          background: "#2e3440",
          foreground: "#d8dee9",
          cursor: "#d8dee9",
          selectionBackground: "#434c5e",
          black: "#3b4252",
          red: "#bf616a",
          green: "#a3be8c",
          yellow: "#ebcb8b",
          blue: "#81a1c1",
          magenta: "#b48ead",
          cyan: "#88c0d0",
          white: "#e5e9f0",
          brightBlack: "#4c566a",
          brightRed: "#bf616a",
          brightGreen: "#a3be8c",
          brightYellow: "#ebcb8b",
          brightBlue: "#81a1c1",
          brightMagenta: "#b48ead",
          brightCyan: "#8fbcbb",
          brightWhite: "#eceff4",
        };
        break;
      case "tokyo-night":
        baseTheme = {
          background: "#1a1b26",
          foreground: "#c0caf5",
          cursor: "#c0caf5",
          selectionBackground: "#283457",
          black: "#15161e",
          red: "#f7768e",
          green: "#9ece6a",
          yellow: "#e0af68",
          blue: "#7aa2f7",
          magenta: "#bb9af7",
          cyan: "#7dcfff",
          white: "#a9b1d6",
          brightBlack: "#414868",
          brightRed: "#f7768e",
          brightGreen: "#9ece6a",
          brightYellow: "#e0af68",
          brightBlue: "#7aa2f7",
          brightMagenta: "#bb9af7",
          brightCyan: "#7dcfff",
          brightWhite: "#c0caf5",
        };
        break;
      case "one-dark":
        baseTheme = {
          background: "#282c34",
          foreground: "#abb2bf",
          cursor: "#528bff",
          selectionBackground: "#3e4451",
          black: "#1e222a",
          red: "#e06c75",
          green: "#98c379",
          yellow: "#d19a66",
          blue: "#61afef",
          magenta: "#c678dd",
          cyan: "#56b6c2",
          white: "#abb2bf",
          brightBlack: "#545862",
          brightRed: "#e06c75",
          brightGreen: "#98c379",
          brightYellow: "#d19a66",
          brightBlue: "#61afef",
          brightMagenta: "#c678dd",
          brightCyan: "#56b6c2",
          brightWhite: "#c8ccd4",
        };
        break;
      case "dracula":
        baseTheme = {
          background: "#282a36",
          foreground: "#f8f8f2",
          cursor: "#f8f8f2",
          selectionBackground: "#44475a",
          black: "#21222c",
          red: "#ff5555",
          green: "#50fa7b",
          yellow: "#f1fa8c",
          blue: "#bd93f9",
          magenta: "#ff79c6",
          cyan: "#8be9fd",
          white: "#f8f8f2",
          brightBlack: "#6272a4",
          brightRed: "#ff6e6e",
          brightGreen: "#69ff94",
          brightYellow: "#ffffa5",
          brightBlue: "#d6acff",
          brightMagenta: "#ff92d0",
          brightCyan: "#a4ffff",
          brightWhite: "#ffffff",
        };
        break;
      case "solarized-dark":
        baseTheme = {
          background: "#002b36",
          foreground: "#839496",
          cursor: "#93a1a1",
          selectionBackground: "#073642",
          black: "#073642",
          red: "#dc322f",
          green: "#859900",
          yellow: "#b58900",
          blue: "#268bd2",
          magenta: "#d33682",
          cyan: "#2aa198",
          white: "#eee8d5",
          brightBlack: "#002b36",
          brightRed: "#cb4b16",
          brightGreen: "#586e75",
          brightYellow: "#657b83",
          brightBlue: "#839496",
          brightMagenta: "#6c71c4",
          brightCyan: "#93a1a1",
          brightWhite: "#fdf6e3",
        };
        break;
      case "solarized-light":
        baseTheme = {
          background: "#fdf6e3",
          foreground: "#657b83",
          cursor: "#586e75",
          selectionBackground: "#eee8d5",
          black: "#073642",
          red: "#dc322f",
          green: "#859900",
          yellow: "#b58900",
          blue: "#268bd2",
          magenta: "#d33682",
          cyan: "#2aa198",
          white: "#eee8d5",
          brightBlack: "#002b36",
          brightRed: "#cb4b16",
          brightGreen: "#586e75",
          brightYellow: "#657b83",
          brightBlue: "#839496",
          brightMagenta: "#6c71c4",
          brightCyan: "#93a1a1",
          brightWhite: "#fdf6e3",
        };
        break;
      case "catppuccin-mocha":
      default:
        baseTheme = {
          background: "#1e1e2e",
          foreground: "#cdd6f4",
          cursor: "#f5e0dc",
          selectionBackground: "#585b7055",
          black: "#45475a",
          red: "#f38ba8",
          green: "#a6e3a1",
          yellow: "#f9e2af",
          blue: "#89b4fa",
          magenta: "#cba6f7",
          cyan: "#94e2d5",
          white: "#bac2de",
          brightBlack: "#585b70",
          brightRed: "#f38ba8",
          brightGreen: "#a6e3a1",
          brightYellow: "#f9e2af",
          brightBlue: "#89b4fa",
          brightMagenta: "#cba6f7",
          brightCyan: "#94e2d5",
          brightWhite: "#a6adc8",
        };
        break;
    }

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
    return colors.background || "#1e1e2e";
  }
}
