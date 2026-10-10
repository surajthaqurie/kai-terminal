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
    ];
    if (!themes.includes(merged.theme)) merged.theme = DEFAULT_SETTINGS.theme;
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

  static getThemeColors(themeName: ThemeName): ITheme {
    switch (themeName) {
      case "one-dark":
        return {
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
      case "dracula":
        return {
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
      case "solarized-dark":
        return {
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
      case "solarized-light":
        return {
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
      case "catppuccin-mocha":
      default:
        return {
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
    }
  }
}
