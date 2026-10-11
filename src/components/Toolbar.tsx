import { FC } from "react";
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
} from "lucide-react";
import { ProjectIntelligenceInfo } from "../services/projectService";

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
  onOpenEditor?: () => void;
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
}) => {
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
          value={selectedShellId}
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
        {gitBranch && (
          <span
            className="git-badge"
            title={gitDirty ? "Working tree has changes" : "Working tree clean"}
            onClick={() => onGitAction?.("status")}
            style={{ cursor: "pointer" }}
          >
            <GitBranch size={12} style={{ display: "inline", marginRight: "4px" }} />
            {gitBranch}
            {gitDirty ? " ●" : ""}
          </span>
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
          <button
            className="btn btn-icon"
            onClick={onOpenEditor}
            title="Open Project in Code Editor"
            aria-label="Open in editor"
          >
            <Code size={15} />
          </button>
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
