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
  { icon: Cpu, tone: 't-icon--neutral', tag: 'Fast and light', title: 'Fast native core', body: 'Kai talks directly to your system. No heavy background apps. It opens fast and stays fast.' },
  { icon: Zap, tone: 't-icon--neutral', tag: 'Smooth display', title: 'Smooth rendering', body: 'Clear text that scrolls smoothly, even with large outputs. Easy search and selection.' },
  { icon: Layers, tone: 't-icon--neutral', tag: 'Tabs', title: 'Safe separate tabs', body: 'Each tab runs on its own. If one tab stops, your other tabs keep working.' },
  { icon: Bot, tone: 't-icon--neutral', tag: 'AI help', title: 'Help for your AI assistant', body: 'Kai reads your project on your computer and gives your AI assistant the right context. Works with Claude, Cursor, Codex, Gemini, Copilot, Windsurf and Cline.' },
  { icon: ShieldCheck, tone: 't-icon--neutral', tag: 'Private', title: 'Private and safe', body: 'Everything stays on your computer. No tracking, no uploads. Passwords and keys are never saved.' },
  { icon: Monitor, tone: 't-icon--neutral', tag: 'Light app', title: 'Light, not heavy', body: 'Uses about 30MB of memory. Starts in seconds. Free for personal and work use.' },
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
  { label: 'Memory use when idle', kai: '~30 MB', electron: '300 MB+', alacritty: 'low' },
  { label: 'Tabs and split screens', kai: 'built in', electron: 'built in', alacritty: 'needs extra tool' },
  { label: 'AI project help', kai: 'built in', electron: 'needs plugins', alacritty: 'none' },
  { label: 'Speed of answers', kai: 'under 10 ms', electron: 'slower', alacritty: 'manual' },
  { label: 'Saves AI costs', kai: '~70% less', electron: 'no limit', alacritty: 'n/a' },
  { label: 'Tracking', kai: 'none', electron: 'depends', alacritty: 'none' },
];
