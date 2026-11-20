import { FC, ReactNode, useMemo } from "react";
import {
  Activity,
  ArrowUpCircle,
  Bot,
  Columns,
  FolderOpen,
  GitCompare,
  MoreHorizontal,
  Rows,
  Search,
  Settings,
} from "lucide-react";
import type { CommandAction } from "./CommandPalette";
import { PopupMenu, type MenuEntry } from "./PopupMenu";
import { useShortcutTitle } from "../hooks/useShortcutHints";
import { useSharingStatus } from "../hooks/useSharingStatus";

interface HeaderActionsProps {
  /** The palette's action list: the "more" menu reuses its handlers and shortcuts. */
  actions: CommandAction[];
  paletteShortcut: string;
  onOpenCommandPalette: () => void;
  onOpenAiCli: () => void;
  onOpenSettings: () => void;
  updateAvailable?: boolean;
  latestVersion?: string | null;
  onViewUpdate?: () => void;
}

/**
 * Right side of the tab row. Only what is used all the time is on screen: the
 * search box that opens the command palette, AI providers (with a green dot
 * while this PC shares its agents) and Settings. Everything occasional lives in
 * the "more" menu, and the rest stays reachable through the palette and keyboard
 * shortcuts (Music Time, for one, via Settings and its shortcut).
 *
 * Not repeated here (single source of truth lives elsewhere): new tab in a
 * given shell (the "+ ▾" menu on the tab strip), the shell of the focused
 * terminal, git branch / cwd / Code Mode and "open project in editor" (the
 * status bar's mode pill).
 */
export const HeaderActions: FC<HeaderActionsProps> = ({
  actions,
  paletteShortcut,
  onOpenCommandPalette,
  onOpenAiCli,
  onOpenSettings,
  updateAvailable = false,
  latestVersion,
  onViewUpdate,
}) => {
  const shortcutTitle = useShortcutTitle();
  const sharing = useSharingStatus();
  const aiCliTitle = sharing.on
    ? `AI CLI providers · Sharing your agents · ${sharing.connected} PC${
        sharing.connected === 1 ? "" : "s"
      } connected${sharing.internet ? " · internet on" : ""}`
    : "AI CLI providers";

  const entries = useMemo<MenuEntry[]>(() => {
    const byId = new Map(actions.map((a) => [a.id, a]));
    const act = (id: string, label: string, icon: ReactNode): MenuEntry[] => {
      const a = byId.get(id);
      return a ? [{ id, label, icon, hint: a.shortcut, onSelect: a.perform }] : [];
    };

    const out: MenuEntry[] = [
      ...act("manage-workspaces", "Workspaces & sessions", <FolderOpen size={14} />),
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
  }, [actions, updateAvailable, latestVersion, onViewUpdate]);

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
        title={aiCliTitle}
        aria-label="Open AI CLI providers"
      >
        <Bot size={15} aria-hidden="true" />
        {sharing.on && (
          <span className="header-status-dot" role="status" aria-label="Sharing your agents" />
        )}
      </button>
      <button
        type="button"
        className="header-icon-btn"
        onClick={onOpenSettings}
        title={shortcutTitle("Settings", "settings")}
        aria-label="Open settings"
      >
        <Settings size={15} aria-hidden="true" />
      </button>
      <PopupMenu
        label="More actions"
        align="end"
        entries={entries}
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
