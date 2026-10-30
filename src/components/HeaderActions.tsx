import { FC, ReactNode, useMemo } from "react";
import {
  Activity,
  ArrowUpCircle,
  Bot,
  Code,
  Columns,
  FolderOpen,
  GitCompare,
  MoreHorizontal,
  Music,
  Rows,
  Search,
  Settings,
} from "lucide-react";
import type { InstalledEditor } from "../services/projectService";
import type { CommandAction } from "./CommandPalette";
import { PopupMenu, type MenuEntry } from "./PopupMenu";

interface HeaderActionsProps {
  /** The palette's action list: the "more" menu reuses its handlers and shortcuts. */
  actions: CommandAction[];
  paletteShortcut: string;
  onOpenCommandPalette: () => void;
  onOpenAiCli: () => void;
  onOpenSettings: () => void;
  onOpenEditor?: (editorBinary?: string) => void;
  editorPath?: string;
  installedEditors?: InstalledEditor[];
  isLoadingEditors?: boolean;
  onRefreshEditors?: () => void;
  updateAvailable?: boolean;
  latestVersion?: string | null;
  onViewUpdate?: () => void;
}

/**
 * Right side of the tab row. Only what is used all the time is on screen: the
 * search box that opens the command palette, AI providers and Settings.
 * Everything occasional lives in the "more" menu, and the rest stays reachable
 * through the palette and keyboard shortcuts.
 *
 * Not repeated here (single source of truth lives elsewhere): shell choice
 * (the "+ ▾" menu on the tab strip), git branch / cwd / Code Mode (status bar).
 */
export const HeaderActions: FC<HeaderActionsProps> = ({
  actions,
  paletteShortcut,
  onOpenCommandPalette,
  onOpenAiCli,
  onOpenSettings,
  onOpenEditor,
  editorPath,
  installedEditors = [],
  isLoadingEditors = false,
  onRefreshEditors,
  updateAvailable = false,
  latestVersion,
  onViewUpdate,
}) => {
  const entries = useMemo<MenuEntry[]>(() => {
    const byId = new Map(actions.map((a) => [a.id, a]));
    const act = (id: string, label: string, icon: ReactNode): MenuEntry[] => {
      const a = byId.get(id);
      return a ? [{ id, label, icon, hint: a.shortcut, onSelect: a.perform }] : [];
    };

    const editorEntries: MenuEntry[] = [];
    if (onOpenEditor) {
      if (installedEditors.length > 1) {
        editorEntries.push({ kind: "heading", id: "editor-heading", label: "Open project in" });
        for (const ed of installedEditors) {
          editorEntries.push({
            id: `editor-${ed.id}`,
            label: ed.name,
            detail: ed.path,
            icon: <Code size={14} />,
            onSelect: () => onOpenEditor(ed.path || ed.binary),
          });
        }
        editorEntries.push({
          id: "editor-default",
          label: editorPath ? `Default (${editorPath})` : "Default (auto-detect)",
          icon: <Code size={14} />,
          onSelect: () => onOpenEditor(undefined),
        });
      } else {
        const only = installedEditors[0];
        editorEntries.push({
          id: "editor-default",
          label: only ? `Open project in ${only.name}` : "Open project in editor",
          detail: isLoadingEditors ? "Detecting editors…" : only?.path,
          icon: <Code size={14} />,
          onSelect: () => onOpenEditor(only ? only.path || only.binary : undefined),
        });
      }
    }

    const out: MenuEntry[] = [
      ...act("manage-workspaces", "Workspaces & sessions", <FolderOpen size={14} />),
      ...act("toggle-music", "Music Time", <Music size={14} />),
      { kind: "separator", id: "sep-project" },
      ...editorEntries,
      ...act("review-changes", "Review git changes", <GitCompare size={14} />),
      { kind: "separator", id: "sep-panes" },
      ...act("split-vertical", "Split pane right", <Columns size={14} />),
      ...act("split-horizontal", "Split pane down", <Rows size={14} />),
      { kind: "separator", id: "sep-help" },
      ...act("diagnostics", "Diagnostics & recovery", <Activity size={14} />),
    ];
    if (updateAvailable && onViewUpdate) {
      out.push({
        id: "update-available",
        label: latestVersion ? `Update available — v${latestVersion}` : "Update available",
        icon: <ArrowUpCircle size={14} />,
        tone: "warn",
        onSelect: onViewUpdate,
      });
    } else {
      out.push(...act("check-updates", "Check for updates", <ArrowUpCircle size={14} />));
    }
    return out;
  }, [
    actions,
    onOpenEditor,
    installedEditors,
    isLoadingEditors,
    editorPath,
    updateAvailable,
    latestVersion,
    onViewUpdate,
  ]);

  return (
    <div className="header-actions">
      <button
        type="button"
        className="header-palette"
        onClick={onOpenCommandPalette}
        title={`Search or run a command (${paletteShortcut})`}
        aria-label="Open command palette"
      >
        <Search size={13} aria-hidden="true" />
        <span className="header-palette-text">Search commands…</span>
        <kbd className="header-palette-kbd">{paletteShortcut}</kbd>
      </button>
      <button
        type="button"
        className="header-icon-btn"
        onClick={onOpenAiCli}
        title="AI CLI providers"
        aria-label="Open AI CLI providers"
      >
        <Bot size={15} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="header-icon-btn"
        onClick={onOpenSettings}
        title="Settings"
        aria-label="Open settings"
      >
        <Settings size={15} aria-hidden="true" />
      </button>
      <PopupMenu
        label="More actions"
        align="end"
        entries={entries}
        onOpen={onRefreshEditors}
        trigger={({ open, toggle, props }) => (
          <button
            type="button"
            className={`header-icon-btn${open ? " is-open" : ""}`}
            onClick={toggle}
            title="More"
            aria-label={updateAvailable ? "More actions (update available)" : "More actions"}
            {...props}
          >
            <MoreHorizontal size={16} aria-hidden="true" />
            {updateAvailable && <span className="header-icon-badge" aria-hidden="true" />}
          </button>
        )}
      />
    </div>
  );
};
