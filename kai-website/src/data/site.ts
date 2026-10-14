import { Bot, Cpu, Layers, Monitor, ShieldCheck, Zap, type LucideIcon } from 'lucide-react';

import releaseInfo from './release.json';

export const REPO_URL = 'https://github.com/surajthaqurie/kai-terminal';
export const LATEST_RELEASE_URL = `${REPO_URL}/releases/latest`;
export const FALLBACK_TAG = releaseInfo.tag;
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
  { icon: Cpu, tone: 't-icon--neutral', tag: 'Rust · portable-pty', title: 'Native PTY', body: 'ConPTY on Windows, POSIX pty on macOS/Linux. Sub-millisecond ANSI throughput with zero Electron backend.' },
  { icon: Zap, tone: 't-icon--neutral', tag: 'xterm.js · WebGL', title: 'GPU 60fps Terminal', body: 'Hardware-accelerated WebGL rendering with canvas fallback. High-throughput FIFO output buffer handles 10MB floods without lag.' },
  { icon: Layers, tone: 't-icon--neutral', tag: 'tabs & splits', title: 'Zero-Remount Splits', body: 'Flat grid split panes keep terminal process state intact during resizing and layout changes. Pointer drag-and-drop tab ordering.' },
  { icon: Bot, tone: 't-icon--neutral', tag: 'CLI · MCP · AST', title: 'Project Graph & Auto MCP', body: 'Built-in AST symbol indexing with automatic post-agent sync. Auto-wires MCP for 10 agents (Claude, Cursor, Codex, Gemini, OpenCode, Aider, Windsurf, Cline, Antigravity).' },
  { icon: ShieldCheck, tone: 't-icon--neutral', tag: 'local only', title: 'Privacy & Co-Author Hooks', body: 'Auto-strips AI co-author trailers in commit-msg hooks. Zero telemetry or cloud dependencies. .env files and keys skipped.' },
  { icon: Monitor, tone: 't-icon--neutral', tag: 'Tauri 2', title: 'Small Footprint (~30MB)', body: '~30MB idle RAM with one tab. MIT licensed, builds on GitHub Actions with native installers for macOS, Linux, and Windows.' },
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
  { label: 'Terminal rendering', kai: 'WebGL GPU 60fps', electron: 'Chromium DOM', alacritty: 'OpenGL' },
  { label: 'Tabs & split panes', kai: 'zero-remount grid', electron: 'built in', alacritty: 'tmux only' },
  { label: 'AI Agent integration', kai: 'native (10 agents)', electron: 'via plugins', alacritty: 'none' },
  { label: 'AST graph auto-sync', kai: 'automatic on exit', electron: 'none', alacritty: 'none' },
  { label: 'Co-author hook strip', kai: 'built in (commit-msg)', electron: 'none', alacritty: 'none' },
  { label: 'MCP server & tools', kai: 'built in (7 stdio tools)', electron: 'external', alacritty: 'none' },
  { label: 'Telemetry & privacy', kai: 'zero telemetry, local only', electron: 'varies', alacritty: 'none' },
];
