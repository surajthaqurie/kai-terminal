import { FC, useRef, useState } from "react";
import {
  GitBranch,
  ArrowUpCircle,
  Folder,
  Code,
  Terminal,
  RefreshCw,
  Pause,
  Play,
  SkipForward,
  Volume2,
  VolumeX,
} from "lucide-react";

export interface MusicFooterState {
  title: string | null;
  playing: boolean;
  muted: boolean;
  progress: number;
}

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
  mode?: string;
  /** Re-probe git for the active pane + re-sync Code Mode (footer refresh button). */
  onRefreshGit?: () => void;
  isRefreshingGit?: boolean;
  /** @deprecated Kept for backwards compat. Code Mode is now entered/cleared
   * via the CLI (`kai code <path>` / `kai stop code`), so the badge is
   * display-only and this callback is unused. */
  onToggleMode?: () => void;
  music?: MusicFooterState | null;
  onToggleMusicPanel?: () => void;
  /** True while the YouTube Music drawer is open (drives aria-expanded/title). */
  musicOpen?: boolean;
  onMusicPlayPause?: () => void;
  onMusicNext?: () => void;
  onMusicMute?: () => void;
}

/**
 * Always-visible bottom status bar: git branch (display-only dirty dot)
 * on the left, app version + update check on the right.
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
  mode = "terminal",
  onRefreshGit,
  isRefreshingGit = false,
  music = null,
  onToggleMusicPanel,
  musicOpen = false,
  onMusicPlayPause,
  onMusicNext,
  onMusicMute,
}) => {
  const [copiedPath, setCopiedPath] = useState(false);

  const repoName = gitRepoRoot
    ? gitRepoRoot.split(/[/\\]/).filter(Boolean).pop() || gitRepoRoot
    : null;

  // Full path is always the source of truth: the button shows as much
  // as fits (CSS ellipsis) while the tooltip + click-to-copy expose the
  // complete value on every OS. No JS middle-truncation, so long Windows
  // paths are never cut to an unreadable fragment.
  const dirDisplay = projectDir || "";

  const handleCopyPath = async () => {
    if (!projectDir) return;
    try {
      await navigator.clipboard.writeText(projectDir);
      setCopiedPath(true);
      setTimeout(() => setCopiedPath(false), 1500);
    } catch {
      // clipboard unavailable: tooltip still shows the full path
    }
  };

  const [dragX, setDragX] = useState<number>(() => {
    try {
      const saved = localStorage.getItem("kai_music_footer_drag_x");
      return saved ? parseFloat(saved) : 0;
    } catch {
      return 0;
    }
  });
  // Mirror of dragX for pointer handlers (avoids stale closures: the
  // persisted value must be the position at pointer-up, not the render's).
  const dragXRef = useRef<number>(dragX);
  const dragStartXRef = useRef<number | null>(null);
  const dragInitialXRef = useRef<number>(0);
  // True once a pointer gesture moved more than 2px — used to swallow the
  // trailing click so dragging never opens the player panel.
  const didDragRef = useRef(false);

  // Drag starts on the pill itself — including the title button, which is
  // the widest surface — while the three control buttons (play/next/mute)
  // stay click-only. A gesture that moves >2px sets didDragRef, and every
  // click path checks it so dragging never opens the player. The cursor is
  // left as the normal default; no grab/grabbing indicator is shown.
  const onMiniPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    // Only the primary button starts a drag.
    if (e.button !== 0) return;
    // The small control buttons are click-only: never start a drag on them.
    if ((e.target as HTMLElement).closest(".status-check-btn")) return;
    didDragRef.current = false;
    dragStartXRef.current = e.clientX;
    dragInitialXRef.current = dragXRef.current;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // No capture: move/up on the pill still work for mouse.
    }
  };

  const onMiniPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (dragStartXRef.current === null) return;
    const delta = e.clientX - dragStartXRef.current;
    if (Math.abs(delta) > 2) didDragRef.current = true;
    const newX = Math.max(-450, Math.min(250, dragInitialXRef.current + delta));
    dragXRef.current = newX;
    setDragX(newX);
  };

  const endMiniDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (dragStartXRef.current === null) return;
    dragStartXRef.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {}
    try {
      localStorage.setItem("kai_music_footer_drag_x", String(dragXRef.current));
    } catch {}
  };

  const handleMusicToggle = () => {
    onToggleMusicPanel?.();
  };

  return (
    <footer className="status-bar" role="status" aria-label="Application status bar">
      <div className="status-left">
        {mode === "code" ? (
          <span
            className="status-mode-pill"
            title="Code Mode — project intelligence active for this folder. Run `kai stop` to clear."
            aria-label="Code Mode active"
          >
            <Code size={12} aria-hidden="true" />
            <span>Code Mode</span>
          </span>
        ) : (
          projectDir && (
            <span
              className="status-mode-pill status-mode-terminal"
              title="Terminal mode — this folder is not in an active Code Mode project. Run `kai <agent>` (e.g. `kai claude`) or `kai graph init` in a project to enter Code Mode."
              aria-label="Terminal mode"
            >
              <Terminal size={12} aria-hidden="true" />
              <span>Terminal</span>
            </span>
          )
        )}
        {gitBranch ? (
          <div className="status-git-wrap">
            <span
              className={`status-git-btn${gitDirty ? " is-dirty" : " is-clean"} is-display`}
              title={
                `Git branch: ${gitBranch}${gitDirty ? " (uncommitted changes)" : " (clean)"}` +
                (gitRepoRoot ? `\nRepo: ${gitRepoRoot}` : "")
              }
              aria-label={`Git branch ${gitBranch}${gitDirty ? ", uncommitted changes" : ", clean"}`}
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
            </span>
            {onRefreshGit && (
              <button
                type="button"
                className="status-check-btn"
                onClick={onRefreshGit}
                disabled={isRefreshingGit}
                title={isRefreshingGit ? "Refreshing git status…" : "Refresh git status"}
                aria-label={isRefreshingGit ? "Refreshing git status" : "Refresh git status"}
              >
                <RefreshCw size={12} aria-hidden="true" className={isRefreshingGit ? "spin" : ""} />
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
            {onRefreshGit && projectDir && (
              <button
                type="button"
                className="status-check-btn"
                onClick={onRefreshGit}
                disabled={isRefreshingGit}
                title={isRefreshingGit ? "Refreshing git status…" : "Refresh git status"}
                aria-label={isRefreshingGit ? "Refreshing git status" : "Refresh git status"}
                style={{ marginLeft: 4 }}
              >
                <RefreshCw size={12} aria-hidden="true" className={isRefreshingGit ? "spin" : ""} />
              </button>
            )}
          </span>
        )}
        {projectDir && (
          <button
            type="button"
            className="status-dir status-dir-btn"
            title={`${projectDir}${copiedPath ? "\nCopied!" : "\nClick to copy full path"}`}
            aria-label={`Current directory: ${projectDir}. Activate to copy the full path.`}
            onClick={handleCopyPath}
          >
            <Folder size={12} aria-hidden="true" />
            <span className="status-dir-text">{dirDisplay}</span>
          </button>
        )}
      </div>

      <div className="status-right">
        {music && (
          <div
            className="music-mini"
            role="group"
            aria-label="YouTube Music player"
            style={dragX ? { transform: `translateX(${dragX}px)` } : undefined}
            title="YouTube Music — click to open player, drag to move it in the footer"
            onPointerDown={onMiniPointerDown}
            onPointerMove={onMiniPointerMove}
            onPointerUp={endMiniDrag}
            onPointerCancel={endMiniDrag}
            onClick={(e) => {
              // A drag must never register as a click (panel would open).
              if (didDragRef.current) {
                didDragRef.current = false;
                return;
              }
              const target = e.target as HTMLElement;
              if (target.closest("button") || target.closest(".status-check-btn")) {
                return;
              }
              handleMusicToggle();
            }}
          >
            <button
              type="button"
              className="music-mini-main"
              onClick={(e) => {
                // A drag that started on this button must not open the player.
                if (didDragRef.current) {
                  didDragRef.current = false;
                  return;
                }
                e.stopPropagation();
                handleMusicToggle();
              }}
              title={music.title ?? (musicOpen ? "Close YouTube Music" : "Open YouTube Music")}
              aria-label={music.title ?? "YouTube Music"}
              aria-expanded={musicOpen}
              aria-controls="kai-music-modal"
            >
              <span className="music-mini-art" aria-hidden="true">
                ♪
              </span>
              <span className="music-mini-title">{music.title ?? "YouTube Music"}</span>
            </button>
            <button
              type="button"
              className="status-check-btn"
              onClick={onMusicPlayPause}
              title="Play / pause"
              aria-label={music.playing ? "Pause music" : "Play music"}
            >
              {music.playing ? (
                <Pause size={12} aria-hidden="true" />
              ) : (
                <Play size={12} aria-hidden="true" />
              )}
            </button>
            <button
              type="button"
              className="status-check-btn"
              onClick={onMusicNext}
              title="Next song"
              aria-label="Next song"
            >
              <SkipForward size={12} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="status-check-btn"
              onClick={onMusicMute}
              title="Mute / unmute"
              aria-label={music.muted ? "Unmute music" : "Mute music"}
              aria-pressed={music.muted}
            >
              {music.muted ? (
                <VolumeX size={12} aria-hidden="true" />
              ) : (
                <Volume2 size={12} aria-hidden="true" />
              )}
            </button>
            <span className="music-mini-progress" aria-hidden="true">
              <i style={{ width: `${Math.max(0, Math.min(100, music.progress))}%` }} />
            </span>
          </div>
        )}
        {updateAvailable && latestVersion ? (
          <button
            type="button"
            className="status-update-available"
            onClick={onViewUpdate}
            title={`Update available: v${appVersion} → v${latestVersion}. Click to update now.`}
            aria-label={`Update available, version ${latestVersion}. Update now.`}
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
