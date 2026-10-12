import { FC } from "react";
import { GitBranch, Bot, FolderOpen, ListOrdered, GitCompare, X } from "lucide-react";
import type { GitInfo } from "../services/projectService";

interface PaneHeaderProps {
  paneId: string;
  cwd: string;
  isActive: boolean;
  gitInfo: GitInfo | null;
  showClose: boolean;
  onFocus: () => void;
  onGitStatus: () => void;
  onOpenChanges?: () => void;
  onOpenAi: () => void;
  onOpenEditor: () => void;
  onClosePane: () => void;
}

function shortName(dir: string): string {
  if (!dir) return "no dir";
  const parts = dir.split(/[/\\]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : dir;
}

/**
 * Compact, clean per-split header. Code Mode is handled globally in the
 * footer for the active terminal. The active split has a simple, subtle indicator.
 */
export const PaneHeader: FC<PaneHeaderProps> = ({
  cwd,
  isActive,
  gitInfo,
  showClose,
  onFocus,
  onGitStatus,
  onOpenChanges,
  onOpenAi,
  onOpenEditor,
  onClosePane,
}) => {
  const branch = gitInfo?.branch ?? null;
  const dirty = gitInfo?.dirty ?? false;

  return (
    <div
      className={`pane-header${isActive ? " is-active" : ""}`}
      onClick={onFocus}
      role="toolbar"
      aria-label={`Terminal split ${shortName(cwd)}`}
    >
      {/* Small subtle active dot */}
      <span
        className={`pane-active-dot${isActive ? " on" : ""}`}
        title={isActive ? "Active split" : "Click to focus"}
        aria-hidden="true"
      />

      {/* Directory name */}
      <span className="pane-cwd" title={cwd || "No working directory"}>
        {shortName(cwd)}
      </span>

      {/* Git branch badge */}
      {branch ? (
        <button
          type="button"
          className="pane-git-btn"
          onClick={(e) => {
            e.stopPropagation();
            if (onOpenChanges) onOpenChanges();
            else onGitStatus();
          }}
          title={`${branch}${dirty ? " (uncommitted changes) — click to review changes" : " (clean)"}`}
          aria-label={`Git branch ${branch}`}
        >
          <GitBranch size={10} aria-hidden="true" />
          <span className="pane-git-branch">{branch}</span>
          <span className={`pane-git-dot${dirty ? " dirty" : ""}`} aria-hidden="true">
            ●
          </span>
        </button>
      ) : null}

      {/* Changes button if dirty */}
      {branch && dirty && (
        <button
          type="button"
          className="pane-changes-btn"
          onClick={(e) => {
            e.stopPropagation();
            if (onOpenChanges) onOpenChanges();
            else onGitStatus();
          }}
          title="Review uncommitted changes and diffs"
          aria-label="Review git changes and diffs"
        >
          <GitCompare size={10} aria-hidden="true" />
          <span>Changes</span>
        </button>
      )}

      <span className="pane-header-spacer" />

      {/* Git status quick button */}
      <button
        type="button"
        className="pane-icon-btn"
        onClick={(e) => {
          e.stopPropagation();
          onGitStatus();
        }}
        title={`Git status for ${cwd || "this pane"}`}
        aria-label="Show git status for this pane"
      >
        <ListOrdered size={11} aria-hidden="true" />
      </button>

      {/* AI CLI launcher scoped to this split */}
      <button
        type="button"
        className="pane-icon-btn"
        onClick={(e) => {
          e.stopPropagation();
          onOpenAi();
        }}
        title={`AI providers scoped to ${cwd || "this pane"}`}
        aria-label="Open AI providers for this pane"
      >
        <Bot size={11} aria-hidden="true" />
      </button>

      {/* Open in Editor scoped to this split */}
      <button
        type="button"
        className="pane-icon-btn"
        onClick={(e) => {
          e.stopPropagation();
          onOpenEditor();
        }}
        title={`Open in editor`}
        aria-label="Open this pane in editor"
      >
        <FolderOpen size={11} aria-hidden="true" />
      </button>

      {/* Close pane button */}
      {showClose && (
        <button
          type="button"
          className="pane-icon-btn danger"
          onClick={(e) => {
            e.stopPropagation();
            onClosePane();
          }}
          title="Close split"
          aria-label="Close split"
        >
          <X size={11} aria-hidden="true" />
        </button>
      )}
    </div>
  );
};
