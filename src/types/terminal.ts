/**
 * Shell profile definition detected on host OS or configured by user.
 */
export interface ShellProfile {
  id: string;
  name: string;
  path: string;
  args?: string[];
  env?: Record<string, string>;
  is_default: boolean;
  is_wsl?: boolean;
}

/**
 * Options for spawning a new PTY session.
 */
export interface PtyCreateOptions {
  shell_path?: string;
  args?: string[];
  cwd?: string;
  cols: number;
  rows: number;
  env?: Record<string, string>;
}

/**
 * Active PTY session metadata returned from backend.
 */
export interface PtySessionInfo {
  id: string;
  pid?: number;
  shell_path: string;
  cwd: string;
  cols: number;
  rows: number;
}

/**
 * Terminal session lifecycle status.
 */
export type SessionStatus = "connecting" | "connected" | "disconnected" | "error";

/**
 * Complete state representation of a terminal session in frontend.
 */
export interface TerminalSessionState {
  id: string;
  profile?: ShellProfile;
  pid?: number;
  cwd?: string;
  dimensions: {
    cols: number;
    rows: number;
  };
  status: SessionStatus;
  errorMessage?: string;
  createdAt: number;
}

/**
 * Payload emitted when PTY outputs standard text/ANSI escape codes.
 */
export interface PtyOutputPayload {
  id: string;
  data: string;
}

/**
 * Payload emitted when PTY process exits.
 */
export interface PtyExitPayload {
  id: string;
  exit_code?: number;
}

/**
 * Payload emitted on PTY operational errors.
 */
export interface PtyErrorPayload {
  id: string;
  error: string;
}

/**
 * Individual terminal pane state within a tab for split pane layouts.
 */
export interface TerminalPane {
  id: string;
  shellPath?: string;
  cwd?: string;
  status: SessionStatus;
  errorMessage?: string;
}

/**
 * Split layout arrangement options.
 */
export type SplitDirection = "none" | "horizontal" | "vertical";

/**
 * Represents a tab component state for multi-tab UI layout.
 */
export interface TerminalTab {
  id: string;
  title: string;
  /** Optional accent color (hex `#rgb`/`#rrggbb`) shown as a tab dot. */
  color?: string;
  shellPath?: string;
  cwd?: string;
  status: SessionStatus;
  errorMessage?: string;
  panes: TerminalPane[];
  activePaneId: string;
  splitDirection: SplitDirection;
}

/** Minimal git badge data shared with the toolbar (no repo scanning here). */
export interface GitInfoLike {
  branch: string | null;
  dirty: boolean;
}

/**
 * Available color theme names.
 */
export type ThemeName =
  | "kali"
  | "catppuccin-mocha"
  | "one-dark"
  | "dracula"
  | "solarized-dark"
  | "solarized-light"
  | "nord"
  | "tokyo-night";

/**
 * Terminal cursor appearance styles.
 */
export type CursorStyle = "block" | "underline" | "bar";

/**
 * Configurable keyboard shortcuts map.
 */
export interface KeybindingsConfig {
  newTab: string;
  closeTab: string;
  splitHorizontal: string;
  splitVertical: string;
  closePane: string;
  search: string;
  commandPalette: string;
  settings: string;
  restart: string;
  nextTab: string;
  prevTab: string;
  nextPane: string;
}

/**
 * Persistent user settings for terminal UI & rendering options.
 */
export interface UserSettings {
  theme: ThemeName;
  fontFamily: string;
  fontSize: number;
  scrollback: number;
  cursorBlink: boolean;
  cursorStyle?: CursorStyle;
  opacity?: number;
  defaultShellId?: string;
  /** Optional user-supplied shell executable path; validated by the backend. */
  customShellPath?: string;
  /** Optional user-supplied code editor executable path (e.g. code, cursor). */
  editorPath?: string;
  /** Launch Kai Terminal automatically at OS login (Windows/macOS/Linux). */
  launchAtStartup?: boolean;
  /** Restore the previous session's tabs automatically instead of asking. */
  autoRestoreSession?: boolean;
  /** Customizable keyboard shortcut map. */
  keybindings: KeybindingsConfig;
}

/**
 * Project-specific workspace settings stored locally per directory.
 */
export interface ProjectWorkspaceSettings {
  projectDir: string;
  defaultShellId?: string;
  customShellPath?: string;
  editorPath?: string;
}

/**
 * User-defined custom AI CLI tool configuration.
 */
export interface CustomAiCliConfig {
  id: string;
  name: string;
  path: string;
  install_guidance?: string;
}

/**
 * Event unsubscribe function signature.
 */
export type UnlistenFn = () => void;
