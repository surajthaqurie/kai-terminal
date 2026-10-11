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
  { icon: Bot, tone: 't-icon--neutral', tag: 'mcp · stdio json-rpc', title: 'Project Intelligence & MCP', body: 'Local symbol graph, AST parsing, deterministic retrieval, and standard MCP server for Claude Code, Cursor, and Codex.' },
  { icon: ShieldCheck, tone: 't-icon--neutral', tag: 'read-only · zero leak', title: 'Audited security & privacy', body: 'Strict workspace boundary enforcement, symlink escape protection, automatic secret scrubbing, and zero prompt logging.' },
  { icon: Monitor, tone: 't-icon--neutral', tag: '~30MB idle · sub-10ms query', title: 'Tauri 2, not Electron', body: '10× lighter than Electron terminals. Fast cold start, sub-10ms context retrieval, ~70% token savings, MIT licensed.' },
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
  { label: 'Project Intelligence & MCP', kai: 'built in (stdio MCP)', electron: 'via plugins', alacritty: 'none' },
  { label: 'Context retrieval latency', kai: '< 10 ms (local)', electron: 'cloud/slow', alacritty: 'manual' },
  { label: 'Token reduction vs full dump', kai: '~70% savings', electron: 'unbounded', alacritty: 'n/a' },
  { label: 'Telemetry & Prompt Logging', kai: 'zero', electron: 'varies', alacritty: 'zero' },
];
