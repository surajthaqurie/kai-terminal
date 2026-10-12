import { FC, useEffect, useRef, useState } from "react";
import { ShellProfile } from "../types/terminal";
import {
  Plus,
  RefreshCw,
  Trash2,
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
  GitBranch,
  Cpu,
  ChevronDown,
  ArrowUpCircle,
} from "lucide-react";
import { InstalledEditor, ProjectIntelligenceInfo } from "../services/projectService";

interface ToolbarProps {
  shells: ShellProfile[];
  selectedShellId: string;
  onSelectShell: (shellId: string) => void;
  cwd: string;
  onCwdChange: (cwd: string) => void;
  recentProjects: string[];
  onSelectRecent: (dir: string) => void;
  gitBranch?: string | null;
  gitDirty?: boolean;
  projectIntelligence?: ProjectIntelligenceInfo | null;
  onNewTab: () => void;
  onSplitHorizontal?: () => void;
  onSplitVertical?: () => void;
  onOpenEditor?: (editorBinary?: string) => void;
  editorPath?: string;
  installedEditors?: InstalledEditor[];
  isLoadingEditors?: boolean;
  onRefreshEditors?: () => void;
  onGitAction?: (action: "fetch" | "pull" | "status") => void;
  onRestart: () => void;
  onClear: () => void;
  onCopy: () => void;
  onPaste: () => void;
  onSearch: () => void;
  onOpenCommandPalette: () => void;
  onOpenSettings: () => void;
  onOpenWorkspaces?: () => void;
  onOpenAiCli: () => void;
  onOpenDiagnostics: () => void;
  onCheckUpdates?: () => void;
  isCheckingUpdates?: boolean;
  updateAvailable?: boolean;
  latestVersion?: string | null;
  appVersion?: string;
}

export const Toolbar: FC<ToolbarProps> = ({
  shells,
  selectedShellId,
  onSelectShell,
  cwd,
  onCwdChange,
  recentProjects,
  onSelectRecent,
  gitBranch,
  gitDirty,
  projectIntelligence,
  onNewTab,
  onSplitHorizontal,
  onSplitVertical,
  onOpenEditor,
  editorPath,
  installedEditors = [],
  isLoadingEditors = false,
  onRefreshEditors,
  onGitAction,
  onRestart,
  onClear,
  onCopy,
  onPaste,
  onSearch,
  onOpenCommandPalette,
  onOpenSettings,
  onOpenWorkspaces,
  onOpenAiCli,
  onOpenDiagnostics,
  onCheckUpdates,
  isCheckingUpdates = false,
  updateAvailable = false,
  latestVersion = null,
  appVersion = "",
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
        <button
          className="btn btn-primary"
          onClick={onNewTab}
          title="New Terminal Tab (Ctrl+Shift+T)"
          aria-label="New terminal tab"
        >
          <Plus size={16} />
          <span>New Session</span>
        </button>

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

      <div className="toolbar-group cwd-group">
        <Folder size={14} className="icon-muted" />
        <input
          type="text"
          className="text-input cwd-input"
          placeholder="Initial working directory..."
          value={cwd}
          onChange={(e) => onCwdChange(e.target.value)}
          title="Initial Working Directory"
          aria-label="Initial working directory"
          list="recent-projects"
        />
        <datalist id="recent-projects">
          {recentProjects.map((p) => (
            <option key={p} value={p} />
          ))}
        </datalist>
        {recentProjects.length > 0 && (
          <select
            className="select-input"
            value=""
            onChange={(e) => {
              if (e.target.value) onSelectRecent(e.target.value);
            }}
            title="Recent projects"
            aria-label="Recent projects"
          >
            <option value="">Recent…</option>
            {recentProjects.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        )}
        {gitBranch ? (
          <span
            className="git-badge"
            title={
              gitDirty
                ? "Working tree has changes — click to show git status"
                : "Working tree clean — click to show git status"
            }
            onClick={() => onGitAction?.("status")}
            style={{ cursor: "pointer" }}
            role="button"
            aria-label={`Git branch ${gitBranch}${gitDirty ? ", uncommitted changes" : ", clean"}`}
          >
            <GitBranch size={12} style={{ display: "inline", marginRight: "4px" }} />
            {gitBranch}
            {gitDirty ? " ●" : ""}
          </span>
        ) : (
          cwd.trim() && (
            <span
              className="git-badge git-badge-empty"
              title="Current directory is not a git repository"
              aria-label="Not a git repository"
            >
              <GitBranch size={12} style={{ display: "inline", marginRight: "4px" }} />
              No git repo
            </span>
          )
        )}
        {projectIntelligence && projectIntelligence.status !== "unindexed" && (
          <span
            className={`intelligence-badge intel-${projectIntelligence.status}`}
            title={`Kai Project Intelligence\nStatus: ${projectIntelligence.status}\nFiles: ${projectIntelligence.file_count}\nSymbols: ${projectIntelligence.symbol_count}\nEst. Tokens: ~${projectIntelligence.total_tokens_estimated.toLocaleString()}\nLast indexed: ${projectIntelligence.last_indexed_at || "Never"}`}
          >
            <Cpu size={12} style={{ display: "inline", marginRight: "4px" }} />
            <span>~{Math.round(projectIntelligence.total_tokens_estimated / 1000)}k tok</span>
            <span className="intel-status-dot">●</span>
          </span>
        )}
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
        <button
          className="btn btn-icon"
          onClick={onClear}
          title="Clear Terminal"
          aria-label="Clear terminal"
        >
          <Trash2 size={15} />
        </button>
        <button
          className="btn btn-icon"
          onClick={onRestart}
          title="Restart Session (Ctrl+Shift+R)"
          aria-label="Restart session"
        >
          <RefreshCw size={15} />
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
        {onCheckUpdates && (
          <button
            className={`btn btn-icon toolbar-update-btn${updateAvailable ? " has-update" : ""}`}
            onClick={onCheckUpdates}
            disabled={isCheckingUpdates}
            title={
              updateAvailable && latestVersion
                ? `Update available: v${latestVersion} — click to view`
                : appVersion
                  ? `Check for updates (current v${appVersion})`
                  : "Check for updates"
            }
            aria-label={
              updateAvailable ? "Update available. Check for updates" : "Check for updates"
            }
          >
            <ArrowUpCircle size={15} />
            {updateAvailable && <span className="toolbar-update-dot" aria-hidden="true" />}
          </button>
        )}
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
