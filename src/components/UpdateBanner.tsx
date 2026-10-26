import { FC } from "react";
import { ArrowUpCircle, ExternalLink, X, Clock, Download, Loader2 } from "lucide-react";
import type { UpdateDownloadState } from "../services/updateService";
import { UpdateProgressBar, describeUpdateStep } from "./UpdateProgressBar";

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
  const stepText = describeUpdateStep(downloadState);

  return (
    <div className="update-banner" role="alert" aria-label="Application update available">
      <span className="update-banner-icon" aria-hidden="true">
        <ArrowUpCircle size={16} />
      </span>
      <span className="update-banner-text">
        <strong>{busy ? "Updating Kai" : "Update available"}</strong>
        <span className="update-banner-versions">
          {" "}
          v{currentVersion} → v{latestVersion}
        </span>
        {releaseName && releaseName !== `v${latestVersion}` && (
          <span className="update-banner-release"> — {releaseName}</span>
        )}
        {stepText ? (
          <span className="update-banner-hint" role="status">
            {" "}
            {stepText}
          </span>
        ) : (
          <span className="update-banner-hint">
            {" "}
            A newer version of Kai Terminal is ready{releaseAuthor ? ` by ${releaseAuthor}` : ""}.
            {assetLabel ? ` ${assetLabel} detected for this device.` : ""}
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
      <UpdateProgressBar state={downloadState} />
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
          disabled={busy}
          title="Remind me later"
        >
          <Clock size={12} />
          <span>Later</span>
        </button>
        <button
          type="button"
          className="btn btn-icon btn-small update-banner-close"
          onClick={onDismiss}
          disabled={busy}
          title="Dismiss this version"
          aria-label="Dismiss update notification"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
};
