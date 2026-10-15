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
  { icon: Cpu, tone: 't-icon--neutral', tag: 'Rust · portable-pty', title: 'Native PTY', body: 'Real system terminals underneath — ConPTY on Windows, POSIX pty on macOS and Linux. No Electron in the path.' },
  { icon: Zap, tone: 't-icon--neutral', tag: 'xterm.js · WebGL', title: 'Smooth Rendering', body: 'GPU rendering with a canvas fallback, so big outputs like npm install stay readable instead of freezing.' },
  { icon: Layers, tone: 't-icon--neutral', tag: 'tabs & splits', title: 'Tabs & Split Panes', body: 'Split panes keep your running programs intact while you resize. Drag tabs to reorder them.' },
  { icon: Bot, tone: 't-icon--neutral', tag: 'CLI', title: 'Works With AI Tools', body: 'Kai maps out your code (functions, imports, files) and shares it with the AI tool you already use.' },
  { icon: ShieldCheck, tone: 't-icon--neutral', tag: 'local only', title: 'Private by Default', body: 'Everything stays on your machine. No accounts, no tracking, no cloud. Secret files like .env are skipped automatically.' },
  { icon: Monitor, tone: 't-icon--neutral', tag: 'Tauri 2', title: 'Small & Open Source', body: '~30MB idle RAM with one tab. MIT licensed, with installers for macOS, Linux, and Windows built on GitHub Actions.' },
];

export type Shortcut = { label: string; keys: string[] };

export const SHORTCUTS: Shortcut[] = [
  { label: 'Command palette', keys: ['Ctrl', 'Shift', 'P'] },
  { label: 'Copy selection', keys: ['Ctrl', 'Shift', 'C'] },
  { label: 'Paste', keys: ['Ctrl', 'Shift', 'V'] },
  { label: 'Select all output', keys: ['Ctrl', 'Shift', 'A'] },
  { label: 'Clear terminal', keys: ['Ctrl', 'Shift', 'K'] },
  { label: 'Scroll to top / bottom', keys: ['Ctrl', 'Shift', 'Home / End'] },
  { label: 'Zoom in / out / reset', keys: ['Ctrl', '= / - / 0'] },
  { label: 'Jump to tab 1–8 / last', keys: ['Ctrl', '1–8 / 9'] },
  { label: 'New tab', keys: ['Ctrl', 'Shift', 'T'] },
  { label: 'Close tab', keys: ['Ctrl', 'Shift', 'W'] },
  { label: 'Split horizontal', keys: ['Ctrl', 'Alt', 'S'] },
  { label: 'Split vertical', keys: ['Ctrl', 'Alt', 'V'] },
  { label: 'Close split pane', keys: ['Ctrl', 'Alt', 'W'] },
  { label: 'Find in output', keys: ['Ctrl', 'Shift', 'F'] },
  { label: 'Next / prev tab', keys: ['Ctrl', 'Shift', ']', '['] },
  { label: 'Settings', keys: ['Ctrl', 'Shift', ','] },
];

export type CompareRow = { label: string; kai: string; electron: string; alacritty: string };

export const COMPARE_ROWS: CompareRow[] = [
  { label: 'Memory with one tab', kai: '~30 MB', electron: '300 MB+', alacritty: 'Low' },
  { label: 'Tabs & split panes', kai: 'Built in', electron: 'Built in', alacritty: 'Needs tmux' },
  { label: 'Fast scrolling', kai: 'Yes — GPU', electron: 'Yes', alacritty: 'Yes' },
  { label: 'AI coding tools', kai: '10 built in', electron: 'Plugins', alacritty: 'None' },
  { label: 'Code map auto-sync', kai: 'Automatic', electron: 'None', alacritty: 'None' },
  { label: 'Private, no tracking', kai: 'Yes', electron: 'Varies', alacritty: 'Yes' },
];
