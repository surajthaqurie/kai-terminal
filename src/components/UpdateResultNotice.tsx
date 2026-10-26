import { FC, useEffect } from "react";
import { AlertTriangle, CheckCircle2, X } from "lucide-react";
import type { UpdateOutcome } from "../services/updateService";

interface UpdateResultNoticeProps {
  outcome: UpdateOutcome;
  onDismiss: () => void;
  /** Re-runs the update check so the update banner can offer another try. */
  onRetry: () => void;
}

const SUCCESS_AUTO_DISMISS_MS = 8000;

/** Shown once after the restart an in-app update causes. */
export const UpdateResultNotice: FC<UpdateResultNoticeProps> = ({
  outcome,
  onDismiss,
  onRetry,
}) => {
  const updated = outcome.kind === "updated";

  useEffect(() => {
    if (!updated) return;
    const timer = setTimeout(onDismiss, SUCCESS_AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [updated, onDismiss]);

  return (
    <div
      className={`update-banner ${updated ? "update-banner--success" : "update-banner--failed"}`}
      role="status"
      aria-label="Update result"
    >
      <span className="update-banner-icon" aria-hidden="true">
        {updated ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />}
      </span>
      <span className="update-banner-text">
        {updated ? (
          <>
            <strong>Kai updated</strong>
            <span className="update-banner-hint"> You are now running v{outcome.version}.</span>
          </>
        ) : (
          <>
            <strong>Update didn&apos;t finish</strong>
            <span className="update-banner-hint">
              {" "}
              Kai is still on the previous version. Try again, or download v{outcome.version} from
              the release page.
            </span>
          </>
        )}
      </span>
      <div className="update-banner-actions">
        {!updated && (
          <button type="button" className="btn btn-primary btn-small" onClick={onRetry}>
            <span>Try again</span>
          </button>
        )}
        <button
          type="button"
          className="btn btn-icon btn-small update-banner-close"
          onClick={onDismiss}
          aria-label="Dismiss update result"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
};
