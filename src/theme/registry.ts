import type { ITheme } from "@xterm/xterm";

/**
 * Kai theme registry: the single source of truth for every theme colour.
 *
 * Everything else is derived from this file:
 * - `src/styles/themes/<id>.css` and the first-paint block in `index.html` are
 *   GENERATED from it (`npm run themes:generate`, see `scripts/generate-themes.ts`);
 *   `themeRegistry.test.ts` fails when a committed file is out of date.
 * - the xterm palette, canvas colour, Settings preview swatch, per-theme tab
 *   colours and search highlight colours are read from it at runtime.
 *
 * Only colours live here. Spacing, type, radii, motion and every derived
 * interaction token live in `src/styles/tokens/`.
 */

/** Per-theme chrome tokens, emitted as `--<name>` custom properties. */
export const CHROME_TOKENS = [
  "bg-canvas",
  "bg-header",
  "bg-surface",
  "bg-surface-elevated",
  "bg-surface-sunken",
  "bg-overlay",
  "border-subtle",
  "border-default",
  "border-strong",
  "border-accent",
  "text-primary",
  "text-secondary",
  "text-tertiary",
  "text-inverse",
  "accent-primary",
  "accent-hover",
  "accent-subtle",
  "accent-glow",
  "accent-ring",
  "color-success",
  "color-success-bg",
  "color-warning",
  "color-warning-bg",
  "color-danger",
  "color-danger-bg",
  "color-purple",
  "color-purple-bg",
  "scroll-track",
  "scroll-thumb",
  "scroll-thumb-hover",
] as const;

export type ChromeToken = (typeof CHROME_TOKENS)[number];

/** Terminal palette: xterm's own type, with every colour a theme must set. */
export type TerminalPalette = Required<
  Pick<
    ITheme,
    | "background"
    | "foreground"
    | "cursor"
    | "selectionBackground"
    | "black"
    | "red"
    | "green"
    | "yellow"
    | "blue"
    | "magenta"
    | "cyan"
    | "white"
    | "brightBlack"
    | "brightRed"
    | "brightGreen"
    | "brightYellow"
    | "brightBlue"
    | "brightMagenta"
    | "brightCyan"
    | "brightWhite"
  >
>;

export interface ThemeDefinition {
  id: string;
  /** Display name in Settings. */
  name: string;
  colorScheme: "dark" | "light";
  /** Stroke colour of the `<select>` chevron (an SVG data URL is built from it). */
  chevron: string;
  /** The one tab colour ANSI has no slot for. */
  orange: string;
  chrome: Record<ChromeToken, string>;
  terminal: TerminalPalette;
}

export const THEMES = [
  {
    id: "kai-dark",
    name: "Kai Dark",
    colorScheme: "dark",
    chevron: "#a0a0a0",
    orange: "#e5973c",
    // Plain neutral dark, modelled on the Windows Terminal default (Campbell):
    // pure greys for the chrome, no blue or purple tint.
    chrome: {
      "bg-canvas": "#0c0c0c",
      "bg-header": "#0c0c0c",
      "bg-surface": "#0c0c0c",
      "bg-surface-elevated": "#1f1f1f",
      "bg-surface-sunken": "#080808",
      "bg-overlay": "rgba(12, 12, 12, 0.82)",
      "border-subtle": "rgba(255, 255, 255, 0.08)",
      "border-default": "rgba(255, 255, 255, 0.16)",
      "border-strong": "#454545",
      "border-accent": "rgba(204, 204, 204, 0.4)",
      "text-primary": "#cccccc",
      "text-secondary": "#b4b4b4",
      "text-tertiary": "#8f8f8f",
      "text-inverse": "#0c0c0c",
      "accent-primary": "#d4d4d4",
      "accent-hover": "#f2f2f2",
      "accent-subtle": "rgba(255, 255, 255, 0.1)",
      "accent-glow": "rgba(255, 255, 255, 0.2)",
      "accent-ring": "rgba(255, 255, 255, 0.45)",
      "color-success": "#16c60c",
      "color-success-bg": "rgba(22, 198, 12, 0.12)",
      "color-warning": "#f9f1a5",
      "color-warning-bg": "rgba(249, 241, 165, 0.12)",
      "color-danger": "#f47781",
      "color-danger-bg": "rgba(244, 119, 129, 0.14)",
      "color-purple": "#d670d6",
      "color-purple-bg": "rgba(214, 112, 214, 0.14)",
      "scroll-track": "#0c0c0c",
      "scroll-thumb": "#3a3a3a",
      "scroll-thumb-hover": "#5a5a5a",
    },
    terminal: {
      background: "#0c0c0c",
      foreground: "#cccccc",
      cursor: "#cccccc",
      selectionBackground: "#ffffff40",
      black: "#0c0c0c",
      red: "#c50f1f",
      green: "#13a10e",
      yellow: "#c19c00",
      blue: "#0037da",
      magenta: "#881798",
      cyan: "#3a96dd",
      white: "#cccccc",
      brightBlack: "#767676",
      brightRed: "#e74856",
      brightGreen: "#16c60c",
      brightYellow: "#f9f1a5",
      brightBlue: "#3b78ff",
      brightMagenta: "#b4009e",
      brightCyan: "#61d6d6",
      brightWhite: "#f2f2f2",
    },
  },
  {
    id: "catppuccin-mocha",
    name: "Catppuccin Mocha",
    colorScheme: "dark",
    chevron: "#a6adc8",
    orange: "#fab387",
    chrome: {
      "bg-canvas": "#181825",
      "bg-header": "#11111b",
      "bg-surface": "#1e1e2e",
      "bg-surface-elevated": "#28283d",
      "bg-surface-sunken": "#11111b",
      "bg-overlay": "rgba(17, 17, 27, 0.82)",
      "border-subtle": "rgba(205, 214, 244, 0.1)",
      "border-default": "rgba(205, 214, 244, 0.18)",
      "border-strong": "#45475a",
      "border-accent": "rgba(137, 180, 250, 0.45)",
      "text-primary": "#cdd6f4",
      "text-secondary": "#aeb5d1",
      "text-tertiary": "#989db6",
      "text-inverse": "#11111b",
      "accent-primary": "#89b4fa",
      "accent-hover": "#b4befe",
      "accent-subtle": "rgba(137, 180, 250, 0.15)",
      "accent-glow": "rgba(137, 180, 250, 0.35)",
      "accent-ring": "rgba(137, 180, 250, 0.5)",
      "color-success": "#a6e3a1",
      "color-success-bg": "rgba(166, 227, 161, 0.12)",
      "color-warning": "#f9e2af",
      "color-warning-bg": "rgba(249, 226, 175, 0.14)",
      "color-danger": "#f38ba8",
      "color-danger-bg": "rgba(243, 139, 168, 0.15)",
      "color-purple": "#cba6f7",
      "color-purple-bg": "rgba(203, 166, 247, 0.15)",
      "scroll-track": "#11111b",
      "scroll-thumb": "#313244",
      "scroll-thumb-hover": "#45475a",
    },
    terminal: {
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
      brightBlack: "#6c7086",
      brightRed: "#f38ba8",
      brightGreen: "#a6e3a1",
      brightYellow: "#f9e2af",
      brightBlue: "#89b4fa",
      brightMagenta: "#cba6f7",
      brightCyan: "#94e2d5",
      brightWhite: "#a6adc8",
    },
  },
  {
    id: "tokyo-night",
    name: "Tokyo Night",
    colorScheme: "dark",
    chevron: "#a9b1d6",
    orange: "#ff9e64",
    chrome: {
      "bg-canvas": "#16161e",
      "bg-header": "#13141c",
      "bg-surface": "#1a1b26",
      "bg-surface-elevated": "#24283b",
      "bg-surface-sunken": "#13141c",
      "bg-overlay": "rgba(19, 20, 28, 0.82)",
      "border-subtle": "rgba(192, 202, 245, 0.1)",
      "border-default": "rgba(192, 202, 245, 0.18)",
      "border-strong": "#414868",
      "border-accent": "rgba(122, 162, 247, 0.45)",
      "text-primary": "#c0caf5",
      "text-secondary": "#a2acd6",
      "text-tertiary": "#8e98c2",
      "text-inverse": "#15161e",
      "accent-primary": "#7aa2f7",
      "accent-hover": "#89ddff",
      "accent-subtle": "rgba(122, 162, 247, 0.15)",
      "accent-glow": "rgba(122, 162, 247, 0.35)",
      "accent-ring": "rgba(122, 162, 247, 0.5)",
      "color-success": "#9ece6a",
      "color-success-bg": "rgba(158, 206, 106, 0.12)",
      "color-warning": "#e0af68",
      "color-warning-bg": "rgba(224, 175, 104, 0.14)",
      "color-danger": "#f7768e",
      "color-danger-bg": "rgba(247, 118, 142, 0.11)",
      "color-purple": "#bb9af7",
      "color-purple-bg": "rgba(187, 154, 247, 0.15)",
      "scroll-track": "#13141c",
      "scroll-thumb": "#292e42",
      "scroll-thumb-hover": "#414868",
    },
    terminal: {
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
      brightBlack: "#565f89",
      brightRed: "#f7768e",
      brightGreen: "#9ece6a",
      brightYellow: "#e0af68",
      brightBlue: "#7aa2f7",
      brightMagenta: "#bb9af7",
      brightCyan: "#7dcfff",
      brightWhite: "#c0caf5",
    },
  },
  {
    id: "nord",
    name: "Nord",
    colorScheme: "dark",
    chevron: "#d8dee9",
    orange: "#d08770",
    chrome: {
      "bg-canvas": "#242933",
      "bg-header": "#1e222a",
      "bg-surface": "#2e3440",
      "bg-surface-elevated": "#3b4252",
      "bg-surface-sunken": "#1e222a",
      "bg-overlay": "rgba(30, 34, 42, 0.82)",
      "border-subtle": "rgba(236, 239, 244, 0.1)",
      "border-default": "rgba(236, 239, 244, 0.18)",
      "border-strong": "#4c566a",
      "border-accent": "rgba(136, 192, 208, 0.45)",
      "text-primary": "#eceff4",
      "text-secondary": "#dce1eb",
      "text-tertiary": "#adb5c4",
      "text-inverse": "#2e3440",
      "accent-primary": "#88c0d0",
      "accent-hover": "#8fbcbb",
      "accent-subtle": "rgba(136, 192, 208, 0.15)",
      "accent-glow": "rgba(136, 192, 208, 0.35)",
      "accent-ring": "rgba(136, 192, 208, 0.5)",
      "color-success": "#aac593",
      "color-success-bg": "rgba(163, 190, 140, 0.08)",
      "color-warning": "#ebcb8b",
      "color-warning-bg": "rgba(235, 203, 139, 0.14)",
      "color-danger": "#eca1a8",
      "color-danger-bg": "rgba(191, 97, 106, 0.08)",
      "color-purple": "#ceb0ce",
      "color-purple-bg": "rgba(180, 142, 173, 0.08)",
      "scroll-track": "#1e222a",
      "scroll-thumb": "#3b4252",
      "scroll-thumb-hover": "#4c566a",
    },
    terminal: {
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
      brightBlack: "#697589",
      brightRed: "#d06f79",
      brightGreen: "#b1d196",
      brightYellow: "#f0d399",
      brightBlue: "#8cafd2",
      brightMagenta: "#c895bf",
      brightCyan: "#93ccdc",
      brightWhite: "#eceff4",
    },
  },
  {
    id: "one-dark",
    name: "One Dark",
    colorScheme: "dark",
    chevron: "#8e95a5",
    orange: "#d19a66",
    chrome: {
      "bg-canvas": "#1e2227",
      "bg-header": "#181a1f",
      "bg-surface": "#282c34",
      "bg-surface-elevated": "#323842",
      "bg-surface-sunken": "#181a1f",
      "bg-overlay": "rgba(24, 26, 31, 0.82)",
      "border-subtle": "rgba(171, 178, 191, 0.1)",
      "border-default": "rgba(171, 178, 191, 0.18)",
      "border-strong": "#4b5263",
      "border-accent": "rgba(97, 175, 239, 0.45)",
      "text-primary": "#c2c7d0",
      "text-secondary": "#b1b7c1",
      "text-tertiary": "#9ca2ae",
      "text-inverse": "#1e2227",
      "accent-primary": "#61afef",
      "accent-hover": "#74b8f2",
      "accent-subtle": "rgba(97, 175, 239, 0.15)",
      "accent-glow": "rgba(97, 175, 239, 0.35)",
      "accent-ring": "rgba(97, 175, 239, 0.5)",
      "color-success": "#98c379",
      "color-success-bg": "rgba(152, 195, 121, 0.12)",
      "color-warning": "#e5c07b",
      "color-warning-bg": "rgba(229, 192, 123, 0.14)",
      "color-danger": "#ed9098",
      "color-danger-bg": "rgba(224, 108, 117, 0.08)",
      "color-purple": "#d891e8",
      "color-purple-bg": "rgba(198, 120, 221, 0.08)",
      "scroll-track": "#181a1f",
      "scroll-thumb": "#3e4451",
      "scroll-thumb-hover": "#4b5263",
    },
    terminal: {
      background: "#282c34",
      foreground: "#abb2bf",
      cursor: "#528bff",
      selectionBackground: "#3e4451",
      black: "#3f4451",
      red: "#e06c75",
      green: "#98c379",
      yellow: "#e5c07b",
      blue: "#61afef",
      magenta: "#c678dd",
      cyan: "#56b6c2",
      white: "#abb2bf",
      brightBlack: "#667085",
      brightRed: "#e06c75",
      brightGreen: "#98c379",
      brightYellow: "#e5c07b",
      brightBlue: "#61afef",
      brightMagenta: "#c678dd",
      brightCyan: "#56b6c2",
      brightWhite: "#ffffff",
    },
  },
  {
    id: "dracula",
    name: "Dracula",
    colorScheme: "dark",
    chevron: "#b5b7c7",
    orange: "#ffb86c",
    chrome: {
      "bg-canvas": "#1e1f29",
      "bg-header": "#191a21",
      "bg-surface": "#282a36",
      "bg-surface-elevated": "#343746",
      "bg-surface-sunken": "#191a21",
      "bg-overlay": "rgba(25, 26, 33, 0.82)",
      "border-subtle": "rgba(248, 248, 242, 0.1)",
      "border-default": "rgba(248, 248, 242, 0.18)",
      "border-strong": "#6272a4",
      "border-accent": "rgba(189, 147, 249, 0.45)",
      "text-primary": "#f8f8f2",
      "text-secondary": "#c2c4d0",
      "text-tertiary": "#a4afd0",
      "text-inverse": "#282a36",
      "accent-primary": "#bd93f9",
      "accent-hover": "#ff79c6",
      "accent-subtle": "rgba(189, 147, 249, 0.15)",
      "accent-glow": "rgba(189, 147, 249, 0.35)",
      "accent-ring": "rgba(189, 147, 249, 0.5)",
      "color-success": "#50fa7b",
      "color-success-bg": "rgba(80, 250, 123, 0.12)",
      "color-warning": "#f1fa8c",
      "color-warning-bg": "rgba(241, 250, 140, 0.14)",
      "color-danger": "#ff8585",
      "color-danger-bg": "rgba(255, 85, 85, 0.08)",
      "color-purple": "#c69dfb",
      "color-purple-bg": "rgba(189, 147, 249, 0.09)",
      "scroll-track": "#191a21",
      "scroll-thumb": "#44475a",
      "scroll-thumb-hover": "#6272a4",
    },
    terminal: {
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
    },
  },
  {
    id: "solarized-dark",
    name: "Solarized Dark",
    colorScheme: "dark",
    chevron: "#839496",
    orange: "#cb4b16",
    chrome: {
      "bg-canvas": "#00212b",
      "bg-header": "#001920",
      "bg-surface": "#002b36",
      "bg-surface-elevated": "#073642",
      "bg-surface-sunken": "#001920",
      "bg-overlay": "rgba(0, 25, 32, 0.82)",
      "border-subtle": "rgba(147, 161, 161, 0.1)",
      "border-default": "rgba(147, 161, 161, 0.18)",
      "border-strong": "#586e75",
      "border-accent": "rgba(38, 139, 210, 0.45)",
      "text-primary": "#b5bfbf",
      "text-secondary": "#a3b0b1",
      "text-tertiary": "#8b9da2",
      "text-inverse": "#002b36",
      "accent-primary": "#359be2",
      "accent-hover": "#2aa198",
      "accent-subtle": "rgba(38, 139, 210, 0.15)",
      "accent-glow": "rgba(38, 139, 210, 0.35)",
      "accent-ring": "rgba(38, 139, 210, 0.5)",
      "color-success": "#98ac0c",
      "color-success-bg": "rgba(133, 153, 0, 0.08)",
      "color-warning": "#c89b0a",
      "color-warning-bg": "rgba(181, 137, 0, 0.08)",
      "color-danger": "#fa6f6c",
      "color-danger-bg": "rgba(220, 50, 47, 0.08)",
      "color-purple": "#969be0",
      "color-purple-bg": "rgba(108, 113, 196, 0.08)",
      "scroll-track": "#001920",
      "scroll-thumb": "#073642",
      "scroll-thumb-hover": "#586e75",
    },
    terminal: {
      background: "#002b36",
      foreground: "#93a1a1",
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
      brightBlack: "#586e75",
      brightRed: "#cb4b16",
      brightGreen: "#7a8f00",
      brightYellow: "#c9a227",
      brightBlue: "#4aa3e0",
      brightMagenta: "#6c71c4",
      brightCyan: "#93a1a1",
      brightWhite: "#fdf6e3",
    },
  },
  {
    id: "gruvbox-dark",
    name: "Gruvbox Dark",
    colorScheme: "dark",
    chevron: "#baae90",
    orange: "#fe8019",
    chrome: {
      "bg-canvas": "#1e1e1e",
      "bg-header": "#212121",
      "bg-surface": "#282828",
      "bg-surface-elevated": "#373737",
      "bg-surface-sunken": "#202020",
      "bg-overlay": "rgba(32, 32, 32, 0.82)",
      "border-subtle": "rgba(235, 219, 178, 0.1)",
      "border-default": "rgba(235, 219, 178, 0.18)",
      "border-strong": "#534f46",
      "border-accent": "rgba(250, 189, 47, 0.45)",
      "text-primary": "#ebdbb2",
      "text-secondary": "#d4c6a1",
      "text-tertiary": "#aba187",
      "text-inverse": "#1e1e1e",
      "accent-primary": "#fabd2f",
      "accent-hover": "#fbc954",
      "accent-subtle": "rgba(250, 189, 47, 0.15)",
      "accent-glow": "rgba(250, 189, 47, 0.35)",
      "accent-ring": "rgba(250, 189, 47, 0.5)",
      "color-success": "#b8bb26",
      "color-success-bg": "rgba(184, 187, 38, 0.11)",
      "color-warning": "#fabd2f",
      "color-warning-bg": "rgba(250, 189, 47, 0.14)",
      "color-danger": "#fc8d7f",
      "color-danger-bg": "rgba(252, 131, 117, 0.08)",
      "color-purple": "#d89daf",
      "color-purple-bg": "rgba(216, 149, 167, 0.08)",
      "scroll-track": "#1e1e1e",
      "scroll-thumb": "#4f4c44",
      "scroll-thumb-hover": "#6c6758",
    },
    terminal: {
      background: "#282828",
      foreground: "#ebdbb2",
      cursor: "#ebdbb2",
      selectionBackground: "#504945",
      black: "#3c3836",
      red: "#cc241d",
      green: "#98971a",
      yellow: "#d79921",
      blue: "#458588",
      magenta: "#b16286",
      cyan: "#689d6a",
      white: "#a89984",
      brightBlack: "#928374",
      brightRed: "#fb4934",
      brightGreen: "#b8bb26",
      brightYellow: "#fabd2f",
      brightBlue: "#83a598",
      brightMagenta: "#d3869b",
      brightCyan: "#8ec07c",
      brightWhite: "#ebdbb2",
    },
  },
  {
    id: "rose-pine",
    name: "Rosé Pine",
    colorScheme: "dark",
    chevron: "#908caa",
    orange: "#f6c177",
    chrome: {
      "bg-canvas": "#16141f",
      "bg-header": "#13111b",
      "bg-surface": "#191724",
      "bg-surface-elevated": "#26233a",
      "bg-surface-sunken": "#13111b",
      "bg-overlay": "rgba(19, 17, 27, 0.82)",
      "border-subtle": "rgba(224, 222, 244, 0.1)",
      "border-default": "rgba(224, 222, 244, 0.18)",
      "border-strong": "#403d52",
      "border-accent": "rgba(196, 167, 231, 0.45)",
      "text-primary": "#e0def4",
      "text-secondary": "#b4b0cc",
      "text-tertiary": "#908caa",
      "text-inverse": "#16141f",
      "accent-primary": "#c4a7e7",
      "accent-hover": "#d4bff0",
      "accent-subtle": "rgba(196, 167, 231, 0.15)",
      "accent-glow": "rgba(196, 167, 231, 0.35)",
      "accent-ring": "rgba(196, 167, 231, 0.5)",
      "color-success": "#9ccfd8",
      "color-success-bg": "rgba(156, 207, 216, 0.12)",
      "color-warning": "#f6c177",
      "color-warning-bg": "rgba(246, 193, 119, 0.14)",
      "color-danger": "#eb6f92",
      "color-danger-bg": "rgba(235, 111, 146, 0.08)",
      "color-purple": "#c4a7e7",
      "color-purple-bg": "rgba(196, 167, 231, 0.15)",
      "scroll-track": "#13111b",
      "scroll-thumb": "#2a283e",
      "scroll-thumb-hover": "#403d52",
    },
    terminal: {
      background: "#191724",
      foreground: "#e0def4",
      cursor: "#e0def4",
      selectionBackground: "#403d52",
      black: "#26233a",
      red: "#eb6f92",
      green: "#31748f",
      yellow: "#f6c177",
      blue: "#9ccfd8",
      magenta: "#c4a7e7",
      cyan: "#ebbcba",
      white: "#e0def4",
      brightBlack: "#6e6a86",
      brightRed: "#eb6f92",
      brightGreen: "#31748f",
      brightYellow: "#f6c177",
      brightBlue: "#9ccfd8",
      brightMagenta: "#c4a7e7",
      brightCyan: "#ebbcba",
      brightWhite: "#e0def4",
    },
  },
  {
    // A complete light theme, not an inverted dark one: tone separates the
    // layers (sunken < surface < elevated white), and cyan is darkened to
    // cyan-700 so it still reads as Kai's accent at 4.5:1 on white.
    id: "kai-light",
    name: "Kai Light",
    colorScheme: "light",
    chevron: "#57606a",
    orange: "#bc4c00",
    chrome: {
      "bg-canvas": "#eceef2",
      "bg-header": "#f3f4f6",
      "bg-surface": "#fafbfc",
      "bg-surface-elevated": "#ffffff",
      "bg-surface-sunken": "#eef0f3",
      "bg-overlay": "rgba(31, 35, 40, 0.32)",
      "border-subtle": "rgba(31, 35, 40, 0.08)",
      "border-default": "rgba(31, 35, 40, 0.15)",
      "border-strong": "#b8bec7",
      "border-accent": "rgba(14, 116, 144, 0.5)",
      "text-primary": "#1f2328",
      "text-secondary": "#3d444d",
      "text-tertiary": "#59636e",
      "text-inverse": "#ffffff",
      "accent-primary": "#0e7490",
      "accent-hover": "#0b5f76",
      "accent-subtle": "rgba(14, 116, 144, 0.1)",
      "accent-glow": "rgba(14, 116, 144, 0.22)",
      "accent-ring": "rgba(14, 116, 144, 0.45)",
      "color-success": "#1a7b33",
      "color-success-bg": "rgba(26, 127, 55, 0.08)",
      "color-warning": "#8a5c00",
      "color-warning-bg": "rgba(154, 103, 0, 0.1)",
      "color-danger": "#c21f2b",
      "color-danger-bg": "rgba(207, 34, 46, 0.08)",
      "color-purple": "#7a45d6",
      "color-purple-bg": "rgba(130, 80, 223, 0.08)",
      "scroll-track": "#eef0f3",
      "scroll-thumb": "#c9ced6",
      "scroll-thumb-hover": "#a9b0ba",
    },
    terminal: {
      background: "#fafbfc",
      foreground: "#1f2328",
      cursor: "#0e7490",
      selectionBackground: "#0891b23d",
      black: "#24292f",
      red: "#cf222e",
      green: "#116329",
      yellow: "#7d4e00",
      blue: "#0550ae",
      magenta: "#8250df",
      cyan: "#0e7490",
      white: "#6e7781",
      brightBlack: "#57606a",
      brightRed: "#a40e26",
      brightGreen: "#1a7f37",
      brightYellow: "#633c01",
      brightBlue: "#0969da",
      brightMagenta: "#a475f9",
      brightCyan: "#0891b2",
      brightWhite: "#8c959f",
    },
  },
] as const satisfies ReadonlyArray<ThemeDefinition>;

export type ThemeId = (typeof THEMES)[number]["id"];

export const DEFAULT_THEME_ID: ThemeId = "kai-dark";

export const THEME_IDS: ReadonlyArray<ThemeId> = THEMES.map((t) => t.id);

const BY_ID = new Map<string, ThemeDefinition>(THEMES.map((t) => [t.id, t]));

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === "string" && BY_ID.has(value);
}

/** The theme for `id`, or the default theme for an unknown id. */
export function getTheme(id: string): ThemeDefinition {
  return BY_ID.get(id) ?? (BY_ID.get(DEFAULT_THEME_ID) as ThemeDefinition);
}

/** Colour behind the panes and window chrome (also the first-paint colour). */
export function canvasColor(theme: ThemeDefinition): string {
  return theme.chrome["bg-canvas"];
}

/** Settings swatch: derived, so a preview can never disagree with the theme. */
export function themePreview(theme: ThemeDefinition): { bg: string; fg: string; accent: string } {
  return {
    bg: theme.terminal.background,
    fg: theme.terminal.foreground,
    accent: theme.chrome["accent-primary"],
  };
}

/**
 * Tab colours. The stored value is still the original preset hex (sessions and
 * workspaces persist it), so the hex is the stable key; what is painted is the
 * current theme's colour of the same name.
 */
export const TAB_COLORS = [
  { key: "#89b4fa", id: "blue", name: "Blue" },
  { key: "#a6e3a1", id: "green", name: "Green" },
  { key: "#f9e2af", id: "yellow", name: "Yellow" },
  { key: "#f38ba8", id: "red", name: "Red" },
  { key: "#cba6f7", id: "purple", name: "Purple" },
  { key: "#94e2d5", id: "teal", name: "Teal" },
  { key: "#fab387", id: "orange", name: "Orange" },
  { key: "#9399b2", id: "gray", name: "Gray" },
] as const;

export type TabColorId = (typeof TAB_COLORS)[number]["id"];

export function tabColors(theme: ThemeDefinition): Record<TabColorId, string> {
  const t = theme.terminal;
  return {
    blue: t.blue,
    green: t.green,
    yellow: t.yellow,
    red: t.red,
    purple: t.magenta,
    teal: t.cyan,
    orange: theme.orange,
    gray: t.brightBlack,
  };
}

/** CSS value for a stored tab colour: the themed token for a preset, else the raw hex. */
export function tabColorValue(stored: string): string {
  const preset = TAB_COLORS.find((c) => c.key === stored.toLowerCase());
  return preset ? `var(--tab-color-${preset.id})` : stored;
}

/** Accessible name of a stored tab colour. */
export function tabColorName(stored: string): string {
  return TAB_COLORS.find((c) => c.key === stored.toLowerCase())?.name ?? "Custom";
}

function parseHex(hex: string): [number, number, number] {
  const h = hex.replace("#", "").slice(0, 6);
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}

/** `a` mixed into `b` by `amount` (0..1), as #rrggbb. */
export function mixHex(a: string, b: string, amount: number): string {
  const [x, y] = [parseHex(a), parseHex(b)];
  return (
    "#" +
    x
      .map((v, i) => Math.round(v * amount + y[i] * (1 - amount)))
      .map((v) => v.toString(16).padStart(2, "0"))
      .join("")
  );
}

/**
 * Search highlight colours for xterm's search addon (it requires #rrggbb).
 * Every match is tinted with the theme's yellow; the current match with its
 * accent, so "where am I" uses the same colour as every other focus cue.
 */
export function searchDecorations(theme: ThemeDefinition) {
  const bg = theme.terminal.background;
  const accent = theme.chrome["accent-primary"];
  return {
    matchBackground: mixHex(theme.terminal.yellow, bg, 0.3),
    matchOverviewRuler: theme.terminal.yellow,
    activeMatchBackground: mixHex(accent, bg, 0.45),
    activeMatchBorder: accent,
    activeMatchColorOverviewRuler: accent,
  };
}
