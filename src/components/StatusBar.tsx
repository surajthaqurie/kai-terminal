import { FC, useEffect, useRef, useState } from "react";
import {
  GitBranch,
  ArrowUpCircle,
  Check,
  Copy,
  Folder,
  ArrowDownToLine,
  ArrowUpFromLine,
  ListOrdered,
  Code,
  Terminal,
  RefreshCw,
  GitCompare,
  Plus,
} from "lucide-react";

interface StatusBarProps {
  gitBranch: string | null;
  gitDirty: boolean;
  gitRepoRoot?: string | null;
  projectDir: string;
  appVersion: string;
  updateAvailable: boolean;
  latestVersion?: string | null;
  isCheckingUpdates?: boolean;
  onCheckUpdates?: () => void;
  onViewUpdate: () => void;
  onGitAction: (action: "fetch" | "pull" | "status") => void;
  onNewTab?: () => void;
  mode?: string;
  /** @deprecated Kept for backwards compat. Code Mode is now entered/cleared
   * via the CLI (`kai code <path>` / `kai stop code`), so the badge is
   * display-only and this callback is unused. */
  onToggleMode?: () => void;
}

/**
 * Always-visible bottom status bar: git branch (with dirty dot + quick
 * actions) on the left, app version + update check on the right.
 */
export const StatusBar: FC<StatusBarProps> = ({
  gitBranch,
  gitDirty,
  gitRepoRoot,
  projectDir,
  appVersion,
  updateAvailable,
  latestVersion,
  isCheckingUpdates = false,
  onCheckUpdates,
  onViewUpdate,
  onGitAction,
  onNewTab,
  mode = "terminal",
}) => {
  const [gitMenuOpen, setGitMenuOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!gitMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setGitMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setGitMenuOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [gitMenuOpen]);

  const repoName = gitRepoRoot
    ? gitRepoRoot.split(/[/\\]/).filter(Boolean).pop() || gitRepoRoot
    : null;

  const handleCopyBranch = async () => {
    if (!gitBranch) return;
    try {
      await navigator.clipboard.writeText(gitBranch);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable: keep menu open, no crash
    }
  };

  const runAction = (action: "fetch" | "pull" | "status") => {
    setGitMenuOpen(false);
    onGitAction(action);
  };

  return (
    <footer className="status-bar" role="status" aria-label="Application status bar">
      <div className="status-left">
        {mode === "code" ? (
          <span
            className="status-mode-pill"
            title="Code Mode — project intelligence active. Run `kai stop code` to clear."
            aria-label="Code Mode active"
          >
            <Code size={12} aria-hidden="true" />
            <span>Code Mode</span>
          </span>
        ) : (
          projectDir && (
            <span
              className="status-mode-pill status-mode-terminal"
              title="Terminal mode — run `kai code <path>` to enter Code Mode."
              aria-label="Terminal mode"
            >
              <Terminal size={12} aria-hidden="true" />
              <span>Terminal</span>
            </span>
          )
        )}
        {gitBranch ? (
          <div ref={menuRef} className="status-git-wrap">
            <button
              type="button"
              className={`status-git-btn${gitDirty ? " is-dirty" : " is-clean"}`}
              onClick={() => setGitMenuOpen((v) => !v)}
              title={
                `Git branch: ${gitBranch}${gitDirty ? " (uncommitted changes)" : " (clean)"}` +
                (gitRepoRoot ? `\nRepo: ${gitRepoRoot}` : "") +
                "\nClick for git actions"
              }
              aria-label={`Git branch ${gitBranch}${gitDirty ? ", uncommitted changes" : ", clean"}. Open git actions`}
              aria-haspopup="menu"
              aria-expanded={gitMenuOpen}
            >
              <GitBranch size={13} aria-hidden="true" />
              <span className="status-git-branch">{gitBranch}</span>
              <span
                className={`status-git-dot${gitDirty ? " dirty" : ""}`}
                title={gitDirty ? "Uncommitted changes" : "Clean"}
                aria-hidden="true"
              >
                ●
              </span>
              {repoName && <span className="status-git-repo">({repoName})</span>}
            </button>
            {gitMenuOpen && (
              <div className="status-git-menu" role="menu" aria-label="Git actions">
                <button type="button" role="menuitem" onClick={() => runAction("status")}>
                  <GitCompare size={13} />
                  <span>Review Changes (Diff)</span>
                </button>
                <button type="button" role="menuitem" onClick={() => runAction("status")}>
                  <ListOrdered size={13} />
                  <span>Show status</span>
                </button>
                <button type="button" role="menuitem" onClick={() => runAction("fetch")}>
                  <ArrowDownToLine size={13} />
                  <span>Fetch updates</span>
                </button>
                <button type="button" role="menuitem" onClick={() => runAction("pull")}>
                  <ArrowUpFromLine size={13} />
                  <span>Fast-forward pull</span>
                </button>
                <button type="button" role="menuitem" onClick={handleCopyBranch}>
                  {copied ? <Check size={13} /> : <Copy size={13} />}
                  <span>{copied ? "Copied!" : `Copy branch name`}</span>
                </button>
              </div>
            )}
            {gitDirty && (
              <button
                type="button"
                className="status-changes-pill"
                onClick={() => onGitAction("status")}
                title="Uncommitted changes detected. Click to review changes and diffs (like VS Code)."
                aria-label="Review uncommitted changes and diffs"
              >
                <GitCompare size={11} aria-hidden="true" />
                <span>Changes ●</span>
              </button>
            )}
          </div>
        ) : (
          <span
            className="status-git-empty"
            title={
              projectDir
                ? "Current directory is not a git repository"
                : "Open a project directory to see git status"
            }
          >
            <GitBranch size={13} aria-hidden="true" />
            <span>{projectDir ? "No git repo" : "No project open"}</span>
          </span>
        )}
        {projectDir && (
          <span
            className="status-dir"
            title={projectDir}
            aria-label={`Current directory: ${projectDir}`}
          >
            <Folder size={12} aria-hidden="true" />
            <span className="status-dir-text">{projectDir}</span>
          </span>
        )}
      </div>

      <div className="status-right">
        {onNewTab && (
          <button
            type="button"
            className="status-newtab-btn"
            onClick={onNewTab}
            title="New Tab (Ctrl+T / Cmd+T — works on Windows, Linux and macOS)"
            aria-label="New terminal tab"
          >
            <Plus size={12} aria-hidden="true" />
            <span>New Tab</span>
          </button>
        )}
        {updateAvailable && latestVersion ? (
          <button
            type="button"
            className="status-update-available"
            onClick={onViewUpdate}
            title={`Update available: v${appVersion} → v${latestVersion}. Click to view release.`}
            aria-label={`Update available, version ${latestVersion}. View release.`}
          >
            <ArrowUpCircle size={13} aria-hidden="true" />
            <span>
              v{appVersion} → v{latestVersion}
            </span>
          </button>
        ) : (
          <span className="status-version" title={`Kai Terminal v${appVersion}`}>
            v{appVersion}
          </span>
        )}
        <button
          type="button"
          className="status-check-btn"
          onClick={onCheckUpdates}
          disabled={isCheckingUpdates || !onCheckUpdates}
          title={isCheckingUpdates ? "Checking for updates…" : "Check for updates"}
          aria-label={isCheckingUpdates ? "Checking for updates" : "Check for updates"}
        >
          <RefreshCw size={12} aria-hidden="true" className={isCheckingUpdates ? "spin" : ""} />
        </button>
      </div>
    </footer>
  );
};
