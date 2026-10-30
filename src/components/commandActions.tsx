import {
  Activity,
  ArrowLeft,
  ArrowRight,
  Bot,
  ClipboardPaste,
  Code,
  Columns,
  Copy,
  Edit3,
  FolderOpen,
  GitCompare,
  Plus,
  Rows,
  Search,
  Settings,
  Trash2,
  XCircle,
} from "lucide-react";
import { REVIEW_CHANGES_BINDING, platformLabel } from "../services/shortcuts";
import type { KeybindingsConfig, SplitDirection } from "../types/terminal";
import type { CommandAction } from "./CommandPalette";

/** Everything the command palette can trigger, supplied by the App shell. */
export interface CommandActionContext {
  keybindings: KeybindingsConfig;
  isMac: boolean;
  newTab: () => void;
  cycleTab: (step: 1 | -1) => void;
  focusNextPane: () => void;
  openWorkspaces: () => void;
  splitPane: (direction: SplitDirection) => void;
  closeActivePane: () => void;
  toggleMusic: () => void;
  renameActiveTab: () => void;
  openEditor: () => void;
  showGitStatus: () => void;
  reviewChanges: () => void;
  checkUpdates: () => void;
  closeActiveTab: () => void;
  toggleSearch: () => void;
  copySelection: () => void;
  pasteClipboard: () => void;
  clearTerminal: () => void;
  openAiCli: () => void;
  openDiagnostics: () => void;
  openSettings: () => void;
}

/** Fixed terminal clipboard chords (not remappable; see Settings → Shortcuts). */
const COPY_BINDING = "Ctrl+Shift+C";
const PASTE_BINDING = "Ctrl+Shift+V";

export function buildCommandActions(ctx: CommandActionContext): CommandAction[] {
  const key = (binding: string) => platformLabel(binding, ctx.isMac);
  const kb = ctx.keybindings;
  return [
    {
      id: "new-tab",
      label: "New Terminal Session",
      category: "Terminal",
      shortcut: key(kb.newTab),
      icon: <Plus size={16} />,
      perform: ctx.newTab,
    },
    {
      id: "next-tab",
      label: "Next Terminal Tab",
      category: "Navigation",
      shortcut: key(kb.nextTab),
      icon: <ArrowRight size={16} />,
      perform: () => ctx.cycleTab(1),
    },
    {
      id: "prev-tab",
      label: "Previous Terminal Tab",
      category: "Navigation",
      shortcut: key(kb.prevTab),
      icon: <ArrowLeft size={16} />,
      perform: () => ctx.cycleTab(-1),
    },
    {
      id: "next-pane",
      label: "Focus Next Active Pane",
      category: "Navigation",
      shortcut: key(kb.nextPane),
      icon: <Columns size={16} />,
      perform: ctx.focusNextPane,
    },
    {
      id: "manage-workspaces",
      label: "Manage Named Workspaces & Sessions",
      category: "Workspaces",
      icon: <FolderOpen size={16} />,
      perform: ctx.openWorkspaces,
    },
    {
      id: "split-horizontal",
      label: "Split Pane Horizontally",
      category: "Workspaces",
      shortcut: key(kb.splitHorizontal),
      icon: <Rows size={16} />,
      perform: () => ctx.splitPane("horizontal"),
    },
    {
      id: "split-vertical",
      label: "Split Pane Vertically",
      category: "Workspaces",
      shortcut: key(kb.splitVertical),
      icon: <Columns size={16} />,
      perform: () => ctx.splitPane("vertical"),
    },
    {
      id: "close-pane",
      label: "Close Active Pane",
      category: "Workspaces",
      shortcut: key(kb.closePane),
      icon: <XCircle size={16} />,
      perform: ctx.closeActivePane,
    },
    {
      id: "toggle-music",
      label: "Toggle Music Time",
      category: "Music",
      shortcut: key(kb.toggleMusic),
      icon: <Activity size={16} />,
      perform: ctx.toggleMusic,
    },
    {
      id: "rename-session",
      label: "Rename Active Session / Tab",
      category: "Terminal",
      icon: <Edit3 size={16} />,
      perform: ctx.renameActiveTab,
    },
    {
      id: "open-editor",
      label: "Open Project in Code Editor",
      category: "Project",
      icon: <Code size={16} />,
      perform: ctx.openEditor,
    },
    {
      id: "git-status",
      label: "Git: Show Status List",
      category: "Git",
      icon: <Activity size={16} />,
      perform: ctx.showGitStatus,
    },
    {
      id: "review-changes",
      label: "Git: Review Changes & Diff",
      category: "Git",
      shortcut: key(REVIEW_CHANGES_BINDING),
      icon: <GitCompare size={16} />,
      perform: ctx.reviewChanges,
    },
    {
      id: "check-updates",
      label: "Check for Application Updates",
      category: "Help",
      icon: <Activity size={16} />,
      perform: ctx.checkUpdates,
    },
    {
      id: "close-tab",
      label: "Close Active Terminal Session",
      category: "Terminal",
      shortcut: key(kb.closeTab),
      icon: <XCircle size={16} />,
      perform: ctx.closeActiveTab,
    },
    {
      id: "search-terminal",
      label: "Search Terminal Output",
      category: "View",
      shortcut: key(kb.search),
      icon: <Search size={16} />,
      perform: ctx.toggleSearch,
    },
    {
      id: "copy-selection",
      label: "Copy Selection",
      category: "Edit",
      shortcut: key(COPY_BINDING),
      icon: <Copy size={16} />,
      perform: ctx.copySelection,
    },
    {
      id: "paste-clipboard",
      label: "Paste from Clipboard",
      category: "Edit",
      shortcut: key(PASTE_BINDING),
      icon: <ClipboardPaste size={16} />,
      perform: ctx.pasteClipboard,
    },
    {
      id: "clear-terminal",
      label: "Clear Active Terminal Screen",
      category: "Terminal",
      icon: <Trash2 size={16} />,
      perform: ctx.clearTerminal,
    },
    {
      id: "ai-cli",
      label: "Open AI CLI Providers",
      category: "AI",
      icon: <Bot size={16} />,
      perform: ctx.openAiCli,
    },
    {
      id: "diagnostics",
      label: "Open Diagnostics & Recovery",
      category: "Help",
      icon: <Activity size={16} />,
      perform: ctx.openDiagnostics,
    },
    {
      id: "open-settings",
      label: "Open Terminal Preferences",
      category: "Preferences",
      shortcut: key(kb.settings),
      icon: <Settings size={16} />,
      perform: ctx.openSettings,
    },
  ];
}
