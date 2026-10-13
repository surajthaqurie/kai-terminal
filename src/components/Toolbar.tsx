import { FC, useEffect, useRef, useState } from "react";
import { ShellProfile } from "../types/terminal";
import {
  Copy,
  Clipboard,
  Folder,
  Search,
  Command,
  Settings,
  Bot,
  Activity,
  Columns,
  Rows,
  Code,
  ChevronDown,
  X,
  Plus,
} from "lucide-react";
import { InstalledEditor } from "../services/projectService";

interface ToolbarProps {
  shells: ShellProfile[];
  selectedShellId: string;
  onSelectShell: (shellId: string) => void;
  onNewTab?: () => void;
  onSplitHorizontal?: () => void;
  onSplitVertical?: () => void;
  canClosePane?: boolean;
  onClosePane?: () => void;
  onOpenEditor?: (editorBinary?: string) => void;
  editorPath?: string;
  installedEditors?: InstalledEditor[];
  isLoadingEditors?: boolean;
  onRefreshEditors?: () => void;
  onCopy: () => void;
  onPaste: () => void;
  onSearch: () => void;
  onOpenCommandPalette: () => void;
  onOpenSettings: () => void;
  onOpenWorkspaces?: () => void;
  onOpenAiCli: () => void;
  onOpenDiagnostics: () => void;
}

/**
 * Slim toolbar: shell picker on the left, terminal/editor actions on the right.
 * Working directory is shown directly in the terminal (pwd/prompt) —
 * no duplicated cwd input here.
 *
 * Deliberately NOT duplicated here (single source of truth lives elsewhere):
 * - Git branch + recent projects: bottom status bar footer.
 * - Code Mode badge (display-only; `kai code` / `kai stop code`): bottom status bar footer.
 * - Clear screen: `clear` command / command palette.
 *
 * New tabs CAN be opened from here, the tab bar "+", and the bottom status
 * bar — all three call the same handler, on every OS (Windows / Linux /
 * macOS), via button or Ctrl+T / Cmd+T.
 */
export const Toolbar: FC<ToolbarProps> = ({
  shells,
  selectedShellId,
  onSelectShell,
  onNewTab,
  onSplitHorizontal,
  onSplitVertical,
  canClosePane = false,
  onClosePane,
  onOpenEditor,
  editorPath,
  installedEditors = [],
  isLoadingEditors = false,
  onRefreshEditors,
  onCopy,
  onPaste,
  onSearch,
  onOpenCommandPalette,
  onOpenSettings,
  onOpenWorkspaces,
  onOpenAiCli,
  onOpenDiagnostics,
}) => {
  const [editorMenuOpen, setEditorMenuOpen] = useState(false);
  const editorMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!editorMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (editorMenuRef.current && !editorMenuRef.current.contains(e.target as Node)) {
        setEditorMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setEditorMenuOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [editorMenuOpen]);

  const openWith = (binary?: string) => {
    setEditorMenuOpen(false);
    onOpenEditor?.(binary);
  };
  return (
    <div className="terminal-toolbar">
      <div className="toolbar-group">
        <select
          className="select-input"
          value={selectedShellId || (shells[0]?.id ?? "")}
          onChange={(e) => onSelectShell(e.target.value)}
          title="Select Active Shell Profile"
          aria-label="Select shell profile"
        >
          {shells.length === 0 && <option value="">Loading shell profiles...</option>}
          {shells.map((shell) => (
            <option key={shell.id} value={shell.id}>
              {shell.name}
              {shell.is_wsl ? " (WSL Environment)" : ""}
              {shell.is_default ? " (Default)" : ""}
            </option>
          ))}
        </select>
        {onNewTab && (
          <button
            type="button"
            className="btn btn-primary btn-small toolbar-newtab-btn"
            onClick={onNewTab}
            title="New Tab (Ctrl+T / Cmd+T — works on Windows, Linux and macOS)"
            aria-label="New terminal tab"
          >
            <Plus size={14} aria-hidden="true" />
            <span>New Tab</span>
          </button>
        )}
      </div>

      <div className="toolbar-group">
        {onOpenEditor && (
          <div ref={editorMenuRef} className="editor-picker-wrap">
            <button
              className="btn btn-icon"
              onClick={() => {
                // Single installed editor + no custom override: open directly.
                // Otherwise show the picker so the user sees installed IDEs.
                if (!editorMenuOpen && installedEditors.length === 1 && !editorPath) {
                  openWith(installedEditors[0].path || installedEditors[0].binary);
                } else {
                  setEditorMenuOpen((v) => !v);
                  if (!editorMenuOpen) onRefreshEditors?.();
                }
              }}
              title={
                editorPath
                  ? `Open Project in ${editorPath}`
                  : installedEditors.length > 0
                    ? `Open Project — ${installedEditors.length} editor${installedEditors.length === 1 ? "" : "s"} detected`
                    : "Open Project in Code Editor (no editor detected yet)"
              }
              aria-label="Open in editor"
              aria-haspopup="menu"
              aria-expanded={editorMenuOpen}
            >
              <Code size={15} />
              <ChevronDown size={12} className="btn-chevron" />
            </button>
            {editorMenuOpen && (
              <div className="editor-dropdown-menu" role="menu" aria-label="Choose code editor">
                <div className="editor-dropdown-header">
                  {isLoadingEditors
                    ? "Detecting editors…"
                    : installedEditors.length > 0
                      ? `Installed editors (${installedEditors.length})`
                      : "No editors detected"}
                </div>
                {installedEditors.map((ed) => (
                  <button
                    key={ed.id}
                    type="button"
                    role="menuitem"
                    className="editor-dropdown-item"
                    onClick={() => openWith(ed.path || ed.binary)}
                    title={ed.path}
                  >
                    <span className="editor-dropdown-item-title">{ed.name}</span>
                    <span className="editor-dropdown-item-path">{ed.path}</span>
                  </button>
                ))}
                <button
                  type="button"
                  role="menuitem"
                  className="editor-dropdown-item editor-dropdown-divider-top"
                  onClick={() => openWith(undefined)}
                  title={
                    editorPath
                      ? `Use configured editor: ${editorPath}`
                      : "Auto-detect (first available on PATH)"
                  }
                >
                  <span className="editor-dropdown-item-title">
                    {editorPath ? `Default: ${editorPath}` : "Default (auto-detect)"}
                  </span>
                  <span className="editor-dropdown-item-path">
                    {editorPath
                      ? "Use the editor from Settings"
                      : "Open with the first editor found on PATH"}
                  </span>
                </button>
                {installedEditors.length === 0 && !isLoadingEditors && (
                  <div className="editor-dropdown-empty">
                    Install VS Code / Cursor / Zed, or set a custom editor path in Settings → Shell
                    & Tools.
                  </div>
                )}
              </div>
            )}
          </div>
        )}
        {onSplitVertical && (
          <button
            className="btn btn-icon"
            onClick={onSplitVertical}
            title="Split Pane Vertically (Ctrl+Alt+V)"
            aria-label="Split vertical"
          >
            <Columns size={15} />
          </button>
        )}
        {onSplitHorizontal && (
          <button
            className="btn btn-icon"
            onClick={onSplitHorizontal}
            title="Split Pane Horizontally (Ctrl+Alt+S)"
            aria-label="Split horizontal"
          >
            <Rows size={15} />
          </button>
        )}
        {canClosePane && onClosePane && (
          <button
            className="btn btn-icon danger-hover"
            onClick={onClosePane}
            title="Close Active Split (Ctrl+Shift+W)"
            aria-label="Close active split"
          >
            <X size={15} />
          </button>
        )}
        <button
          className="btn btn-icon"
          onClick={onSearch}
          title="Search Terminal (Ctrl+Shift+F)"
          aria-label="Search terminal"
        >
          <Search size={15} />
        </button>
        <button
          className="btn btn-icon"
          onClick={onCopy}
          title="Copy Selection (Ctrl+Shift+C)"
          aria-label="Copy selection"
        >
          <Copy size={15} />
        </button>
        <button
          className="btn btn-icon"
          onClick={onPaste}
          title="Paste from Clipboard (Ctrl+Shift+V)"
          aria-label="Paste from clipboard"
        >
          <Clipboard size={15} />
        </button>
        {onOpenWorkspaces && (
          <button
            className="btn btn-icon"
            onClick={onOpenWorkspaces}
            title="Named Workspaces & Saved Sessions"
            aria-label="Open workspaces"
          >
            <Folder size={15} />
          </button>
        )}
        <button
          className="btn btn-icon"
          onClick={onOpenAiCli}
          title="AI CLI providers"
          aria-label="Open AI CLI providers"
        >
          <Bot size={15} />
        </button>
        <button
          className="btn btn-icon"
          onClick={onOpenDiagnostics}
          title="Diagnostics"
          aria-label="Open diagnostics"
        >
          <Activity size={15} />
        </button>
        <button
          className="btn btn-icon"
          onClick={onOpenCommandPalette}
          title="Command Palette (Ctrl+Shift+P)"
          aria-label="Open command palette"
        >
          <Command size={15} />
        </button>
        <button
          className="btn btn-icon"
          onClick={onOpenSettings}
          title="Settings (Ctrl+Shift+,)"
          aria-label="Open settings"
        >
          <Settings size={15} />
        </button>
      </div>
    </div>
  );
};
