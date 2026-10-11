import { Bot, Cpu, Layers, Monitor, ShieldCheck, Zap, type LucideIcon } from 'lucide-react';

export const REPO_URL = 'https://github.com/surajthaqurie/kai-terminal';
export const LATEST_RELEASE_URL = `${REPO_URL}/releases/latest`;
export const FALLBACK_TAG = 'v0.1.0';

export type Feature = {
  icon: LucideIcon;
  tone: string;
  tag: string;
  title: string;
  body: string;
};

export const FEATURES: Feature[] = [
  { icon: Cpu, tone: 't-icon--neutral', tag: 'rust · portable-pty', title: 'Native PTY core', body: 'Direct OS pty streams. No Node backend, no Electron. ConPTY on Windows, POSIX elsewhere.' },
  { icon: Zap, tone: 't-icon--neutral', tag: 'xterm.js · 60fps', title: 'GPU rendering', body: 'Canvas viewport, fast select + search, grid fit. Stays smooth on huge output.' },
  { icon: Layers, tone: 't-icon--neutral', tag: 'tabs · isolation', title: 'Isolated tabs', body: 'Per-tab cwd + process tree + pty channel. One tab dies, the rest live.' },
  { icon: Bot, tone: 't-icon--neutral', tag: 'codex · claude · gemini', title: 'Local AI CLIs', body: 'Detects tools already on your PATH. Zero bundled binaries, zero lock-in.' },
  { icon: ShieldCheck, tone: 't-icon--neutral', tag: 'zero telemetry', title: 'Private by default', body: 'No tracking, no keystroke logging, strict CSP. Everything stays local.' },
  { icon: Monitor, tone: 't-icon--neutral', tag: '~30MB idle', title: 'Tauri 2, not Electron', body: '10× lighter than Electron terminals. Fast cold start, MIT licensed.' },
];

export type Shortcut = { label: string; keys: string[] };

export const SHORTCUTS: Shortcut[] = [
  { label: 'Command palette', keys: ['Ctrl', 'Shift', 'P'] },
  { label: 'New tab', keys: ['Ctrl', 'Shift', 'T'] },
  { label: 'Split horizontal', keys: ['Ctrl', 'Alt', 'S'] },
  { label: 'Split vertical', keys: ['Ctrl', 'Alt', 'V'] },
  { label: 'Find in output', keys: ['Ctrl', 'Shift', 'F'] },
  { label: 'Next / prev tab', keys: ['Ctrl', 'Shift', ']', '['] },
  { label: 'Restart session', keys: ['Ctrl', 'Shift', 'R'] },
  { label: 'Settings', keys: ['Ctrl', 'Shift', ','] },
];

export type CompareRow = { label: string; kai: string; electron: string; alacritty: string };

export const COMPARE_ROWS: CompareRow[] = [
  { label: 'Idle RAM', kai: '~30 MB', electron: '300 MB+', alacritty: 'low' },
  { label: 'Tabs + split panes', kai: 'built in', electron: 'built in', alacritty: 'via tmux' },
  { label: 'AI CLI detection', kai: 'built in', electron: 'plugins', alacritty: 'manual' },
  { label: 'Telemetry', kai: 'zero', electron: 'varies', alacritty: 'zero' },
];
