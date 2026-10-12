import { FC, useEffect, useRef, useState } from "react";
import {
  GitBranch,
  Folder,
  RefreshCw,
  ArrowUpCircle,
  Check,
  Copy,
  ArrowDownToLine,
  ArrowUpFromLine,
  ListOrdered,
} from "lucide-react";

interface StatusBarProps {
  gitBranch: string | null;
  gitDirty: boolean;
  gitRepoRoot?: string | null;
  projectDir: string;
  appVersion: string;
  updateAvailable: boolean;
  latestVersion?: string | null;
  isCheckingUpdates: boolean;
  onCheckUpdates: () => void;
  onViewUpdate: () => void;
  onGitAction: (action: "fetch" | "pull" | "status") => void;
}

/**
 * Always-visible bottom status bar: git branch (with dirty dot + quick
 * actions) on the left, project directory in the middle, app version +
 * update check on the right. The branch is clickable so it is easy to
 * handle, and it degrades to "No git repo" instead of disappearing.
 */
export const StatusBar: FC<StatusBarProps> = ({
  gitBranch,
  gitDirty,
  gitRepoRoot,
  projectDir,
  appVersion,
  updateAvailable,
  latestVersion,
  isCheckingUpdates,
  onCheckUpdates,
  onViewUpdate,
  onGitAction,
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
      </div>

      <div className="status-center">
        {projectDir ? (
          <span className="status-dir" title={projectDir}>
            <Folder size={12} aria-hidden="true" />
            <span className="status-dir-text">{projectDir}</span>
          </span>
        ) : (
          <span className="status-dir status-dir-empty">No directory selected</span>
        )}
      </div>

      <div className="status-right">
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
          disabled={isCheckingUpdates}
          title={isCheckingUpdates ? "Checking for updates…" : "Check for updates"}
          aria-label={isCheckingUpdates ? "Checking for updates" : "Check for updates"}
        >
          <RefreshCw
            size={12}
            className={isCheckingUpdates ? "spin" : undefined}
            aria-hidden="true"
          />
          <span>{isCheckingUpdates ? "Checking…" : "Check for updates"}</span>
        </button>
      </div>
    </footer>
  );
};
