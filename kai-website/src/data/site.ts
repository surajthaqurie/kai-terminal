import { Bot, Cpu, Layers, MessageSquare, Monitor, MousePointerClick, Palette, ShieldCheck, Zap, type LucideIcon } from 'lucide-react';

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
  { icon: Bot, tone: 't-icon--neutral', tag: 'CLI', title: 'Works With AI Tools', body: 'Kai maps out your code (functions, imports, files) and shares it with the AI tool you already use. One command connects Azure DevOps, so your tools can read work items, pull requests and builds, and follow the branch, commit and pull request rules you set.' },
  { icon: ShieldCheck, tone: 't-icon--neutral', tag: 'local first', title: 'Private by Default', body: 'Your code stays on your machine. No accounts, no tracking. Azure DevOps (per folder) and Microsoft Teams (your own account) are opt-in, with tokens kept in your OS secret store and never handed to an AI agent. Secret files like .env are skipped automatically.' },
  { icon: Monitor, tone: 't-icon--neutral', tag: 'Tauri 2', title: 'Small & Open Source', body: '~30MB idle RAM with one tab. MIT licensed, with installers for macOS, Linux, and Windows built on GitHub Actions.' },
  { icon: MessageSquare, tone: 't-icon--neutral', tag: 'kai teams', title: 'Teams Chat in the Terminal', body: 'Read and answer your Microsoft Teams chats and channels without leaving the terminal. Clickable, keyboard-friendly, with inline pictures and file sharing. It is your own account, and AI agents cannot use it.' },
  { icon: MousePointerClick, tone: 't-icon--neutral', tag: 'links & paste', title: 'Open Links, Paste Files', body: 'Ctrl+click (Cmd+click on macOS) opens any web address in the output. Copy files in Explorer or Finder and paste: their paths land at the prompt, quoted when needed, ready for a command or an AI tool.' },
  { icon: Palette, tone: 't-icon--neutral', tag: 'themes', title: 'Nine Themes', body: 'Kai Dark, Gruvbox, Catppuccin, Tokyo Night, Nord, Dracula, Solarized, One Dark and Rosé Pine. The header, tabs and status bar follow the theme, and the window opacity is yours to set.' },
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
  { label: 'Next tab', keys: ['Ctrl', 'Tab'] },
  { label: 'Previous tab', keys: ['Ctrl', 'Shift', 'Tab'] },
  { label: 'Split side by side', keys: ['Alt', 'Shift', '='] },
  { label: 'Split stacked', keys: ['Alt', 'Shift', '-'] },
  { label: 'Close split pane', keys: ['Alt', 'Shift', 'W'] },
  { label: 'Next / previous pane', keys: ['Alt', 'Shift', ']', '['] },
  { label: 'Find in output', keys: ['Ctrl', 'Shift', 'F'] },
  { label: 'Review git changes', keys: ['Ctrl', 'Shift', 'G'] },
  { label: 'Settings', keys: ['Ctrl', ','] },
  { label: 'Show / hide music player', keys: ['Ctrl', 'Shift', 'M'] },
  { label: 'Music play / pause', keys: ['Ctrl', 'Shift', 'Space'] },
  { label: 'Music previous / next song', keys: ['Ctrl', 'Shift', ', / .'] },
  { label: 'Music mute', keys: ['Ctrl', 'Shift', '0'] },
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
