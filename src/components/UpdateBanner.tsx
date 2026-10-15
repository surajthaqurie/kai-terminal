import { FC } from "react";
import { ArrowUpCircle, ExternalLink, X, Clock, Download, Loader2 } from "lucide-react";
import type { UpdateDownloadState } from "../services/updateService";

interface UpdateBannerProps {
  currentVersion: string;
  latestVersion: string;
  releaseUrl: string;
  releaseName?: string | null;
  releaseAuthor?: string | null;
  /** Label for the auto-picked installer, e.g. "Windows installer (.exe)". Null = no direct asset. */
  assetLabel?: string | null;
  downloadState: UpdateDownloadState;
  onDownloadAndInstall: () => void;
  onViewRelease: () => void;
  onDismiss: () => void;
  onLater: () => void;
}

/**
 * Dismissible alert shown when a newer app release exists.
 * `role="alert"` so screen readers announce it immediately.
 */
export const UpdateBanner: FC<UpdateBannerProps> = ({
  currentVersion,
  latestVersion,
  releaseName,
  releaseAuthor,
  assetLabel,
  downloadState,
  onDownloadAndInstall,
  onViewRelease,
  onDismiss,
  onLater,
}) => {
  const busy = downloadState.status === "downloading" || downloadState.status === "installing";
  const progress =
    downloadState.status === "downloading" && downloadState.progress != null
      ? Math.max(0, Math.min(100, downloadState.progress))
      : null;

  return (
    <div className="update-banner" role="alert" aria-label="Application update available">
      <span className="update-banner-icon" aria-hidden="true">
        <ArrowUpCircle size={16} />
      </span>
      <span className="update-banner-text">
        <strong>Update available</strong>
        <span className="update-banner-versions">
          {" "}
          v{currentVersion} → v{latestVersion}
        </span>
        {releaseName && releaseName !== `v${latestVersion}` && (
          <span className="update-banner-release"> — {releaseName}</span>
        )}
        <span className="update-banner-hint">
          {" "}
          A newer version of Kai Terminal is ready{releaseAuthor ? ` by ${releaseAuthor}` : ""}.
          {assetLabel ? ` ${assetLabel} detected for this device.` : ""}
        </span>
        {downloadState.status === "downloading" && (
          <span className="update-banner-hint" role="status">
            {" "}
            Downloading{progress != null ? ` ${Math.round(progress)}%` : "…"} — keep Kai open.
          </span>
        )}
        {downloadState.status === "installing" && (
          <span className="update-banner-hint" role="status">
            {" "}
            Launching installer…
          </span>
        )}
        {downloadState.status === "installed" && downloadState.message && (
          <span className="update-banner-hint" role="status">
            {" "}
            {downloadState.message}
          </span>
        )}
        {downloadState.status === "error" && downloadState.message && (
          <span className="update-banner-hint" role="alert">
            {" "}
            {downloadState.message}
          </span>
        )}
      </span>
      {progress != null && (
        <span
          className="update-download-progress"
          role="progressbar"
          aria-valuenow={Math.round(progress)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Update download progress"
        >
          <span className="update-download-progress-fill" style={{ width: `${progress}%` }} />
        </span>
      )}
      <div className="update-banner-actions">
        {assetLabel ? (
          <button
            type="button"
            className="btn btn-primary btn-small"
            onClick={onDownloadAndInstall}
            disabled={busy}
            title={`Download ${assetLabel} and install automatically`}
          >
            {busy ? <Loader2 size={12} className="spin" /> : <Download size={12} />}
            <span>
              {downloadState.status === "downloading"
                ? "Downloading…"
                : downloadState.status === "installing"
                  ? "Installing…"
                  : downloadState.status === "ready"
                    ? "Install now"
                    : `Update to v${latestVersion}`}
            </span>
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-primary btn-small"
            onClick={onViewRelease}
            title="Open the release page to download manually"
          >
            <ExternalLink size={12} />
            <span>View release</span>
          </button>
        )}
        {assetLabel && (
          <button
            type="button"
            className="btn btn-secondary btn-small"
            onClick={onViewRelease}
            title="Open the release page instead"
          >
            <ExternalLink size={12} />
            <span>Release notes</span>
          </button>
        )}
        <button
          type="button"
          className="btn btn-secondary btn-small"
          onClick={onLater}
          title="Remind me later"
        >
          <Clock size={12} />
          <span>Later</span>
        </button>
        <button
          type="button"
          className="btn btn-icon btn-small update-banner-close"
          onClick={onDismiss}
          title="Dismiss this version"
          aria-label="Dismiss update notification"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
};
