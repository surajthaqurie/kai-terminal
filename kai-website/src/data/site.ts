import { Bot, Cpu, Layers, Monitor, ShieldCheck, Zap, type LucideIcon } from 'lucide-react';

export const REPO_URL = 'https://github.com/surajthaqurie/kai-terminal';
export const LATEST_RELEASE_URL = `${REPO_URL}/releases/latest`;
export const FALLBACK_TAG = 'v0.1.0';
// Single source of truth for the production URL.
// Static files (index.html, robots.txt, sitemap.xml) must match this by hand.
export const SITE_URL = 'https://kai-terminal.vercel.app';

export type Feature = {
  icon: LucideIcon;
  tone: string;
  tag: string;
  title: string;
  body: string;
};

export const FEATURES: Feature[] = [
  { icon: Cpu, tone: 't-icon--neutral', tag: 'Rust · portable-pty', title: 'Native PTY', body: 'ConPTY on Windows, POSIX pty on macOS/Linux. No Electron backend in the path.' },
  { icon: Zap, tone: 't-icon--neutral', tag: 'xterm.js', title: 'Terminal rendering', body: 'Canvas viewport with search and selection. Handles large output without freezing the UI.' },
  { icon: Layers, tone: 't-icon--neutral', tag: 'tabs', title: 'Isolated tabs', body: 'Each tab keeps its own cwd and process. A crash in one tab does not take the others down.' },
  { icon: Bot, tone: 't-icon--neutral', tag: 'CLI · MCP', title: 'Local project index + MCP', body: 'kai code indexes a folder to ~/.kai/. kai mcp serves 7 read-only tools for Claude, Cursor, Codex, Gemini, Copilot, Windsurf, Cline.' },
  { icon: ShieldCheck, tone: 't-icon--neutral', tag: 'local only', title: 'No account, local files', body: '.env files, keys and binaries are skipped. Nothing is uploaded by the app itself.' },
  { icon: Monitor, tone: 't-icon--neutral', tag: 'Tauri 2', title: 'Small install', body: '~30MB idle on the maintainer machine with one tab. MIT licensed, builds on GitHub Actions.' },
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
  { label: 'Idle memory (1 tab)', kai: '~30 MB', electron: '300 MB+', alacritty: 'low' },
  { label: 'Tabs + splits', kai: 'built in', electron: 'built in', alacritty: 'via tmux' },
  { label: 'Local index + MCP', kai: 'built in', electron: 'via plugins', alacritty: 'none' },
  { label: 'Query path', kai: 'local, budgeted', electron: 'varies', alacritty: 'manual' },
  { label: 'Index location', kai: '~/.kai/', electron: 'varies', alacritty: 'n/a' },
  { label: 'Telemetry in app', kai: 'none', electron: 'varies', alacritty: 'none' },
];
