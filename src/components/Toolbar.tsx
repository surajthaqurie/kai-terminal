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
} from "lucide-react";
import { InstalledEditor } from "../services/projectService";

interface ToolbarProps {
  shells: ShellProfile[];
  selectedShellId: string;
  onSelectShell: (shellId: string) => void;
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
 * - New tabs: TabBar "+" / Ctrl+Shift+T / command palette.
 * - Git branch + recent projects: bottom status bar footer.
 * - Code Mode badge (display-only; `kai code` / `kai stop code`): bottom status bar footer.
 * - Clear screen: `clear` command / command palette.
 */
export const Toolbar: FC<ToolbarProps> = ({
  shells,
  selectedShellId,
  onSelectShell,
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
      </div>

      <div className="toolbar-group">
        {onOpenEditor && (
          <div ref={editorMenuRef} style={{ position: "relative" }}>
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
              <ChevronDown size={12} style={{ marginLeft: -2 }} />
            </button>
            {editorMenuOpen && (
              <div
                role="menu"
                aria-label="Choose code editor"
                style={{
                  position: "absolute",
                  top: "calc(100% + 6px)",
                  left: 0,
                  minWidth: 260,
                  maxWidth: 340,
                  background: "#0a1e3c",
                  border: "1px solid #1e3a5f",
                  borderRadius: 8,
                  boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
                  zIndex: 50,
                  padding: 4,
                }}
              >
                <div
                  style={{
                    padding: "6px 10px",
                    fontSize: 11,
                    color: "#8b9bb4",
                    textTransform: "uppercase",
                    letterSpacing: 0.5,
                  }}
                >
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
                    onClick={() => openWith(ed.path || ed.binary)}
                    title={ed.path}
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "flex-start",
                      gap: 1,
                      width: "100%",
                      textAlign: "left",
                      padding: "8px 10px",
                      borderRadius: 6,
                      border: "none",
                      background: "transparent",
                      color: "#e8eef7",
                      cursor: "pointer",
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = "#1e3a5f";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = "transparent";
                    }}
                  >
                    <span style={{ fontSize: 13, fontWeight: 600 }}>{ed.name}</span>
                    <span
                      style={{
                        fontSize: 11,
                        color: "#8b9bb4",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        maxWidth: "100%",
                      }}
                    >
                      {ed.path}
                    </span>
                  </button>
                ))}
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => openWith(undefined)}
                  title={
                    editorPath
                      ? `Use configured editor: ${editorPath}`
                      : "Auto-detect (first available on PATH)"
                  }
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "flex-start",
                    gap: 1,
                    width: "100%",
                    textAlign: "left",
                    padding: "8px 10px",
                    borderRadius: 6,
                    border: "none",
                    borderTop: "1px solid #1e3a5f",
                    marginTop: 4,
                    background: "transparent",
                    color: "#e8eef7",
                    cursor: "pointer",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = "#1e3a5f";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = "transparent";
                  }}
                >
                  <span style={{ fontSize: 13, fontWeight: 600 }}>
                    {editorPath ? `Default: ${editorPath}` : "Default (auto-detect)"}
                  </span>
                  <span style={{ fontSize: 11, color: "#8b9bb4" }}>
                    {editorPath
                      ? "Use the editor from Settings"
                      : "Open with the first editor found on PATH"}
                  </span>
                </button>
                {installedEditors.length === 0 && !isLoadingEditors && (
                  <div style={{ padding: "6px 10px", fontSize: 11, color: "#8b9bb4" }}>
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
