import { FC } from "react";
import { ArrowUpCircle, ExternalLink, X, Clock } from "lucide-react";

interface UpdateBannerProps {
  currentVersion: string;
  latestVersion: string;
  releaseUrl: string;
  releaseName?: string | null;
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
  onViewRelease,
  onDismiss,
  onLater,
}) => {
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
        <span className="update-banner-hint"> A newer version of Kai Terminal is ready.</span>
      </span>
      <div className="update-banner-actions">
        <button type="button" className="btn btn-primary btn-small" onClick={onViewRelease}>
          <ExternalLink size={12} />
          <span>View release</span>
        </button>
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
