import { FC } from "react";
import type { UpdateDownloadState } from "../services/updateService";

interface UpdateProgressBarProps {
  state: Pick<UpdateDownloadState, "status" | "progress">;
}

/**
 * The only place an update's progress is shown: the installer itself runs
 * hidden in the background. Determinate while downloading (step 1 of 2),
 * indeterminate while installing (step 2 of 2). Renders nothing otherwise.
 */
export const UpdateProgressBar: FC<UpdateProgressBarProps> = ({ state }) => {
  if (state.status !== "downloading" && state.status !== "installing") return null;
  const downloading = state.status === "downloading";
  const percent =
    downloading && state.progress != null ? Math.max(0, Math.min(100, state.progress)) : null;
  return (
    <span
      className={`update-download-progress${percent == null ? " indeterminate" : ""}`}
      role="progressbar"
      aria-label={downloading ? "Update download progress" : "Update installation progress"}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent != null ? Math.round(percent) : undefined}
      aria-valuetext={percent == null ? "Working" : undefined}
    >
      <span
        className="update-download-progress-fill"
        style={percent != null ? { width: `${percent}%` } : undefined}
      />
    </span>
  );
};

/** One-line status for the current step ("Step 1 of 2 · Downloading 42%"). */
export function describeUpdateStep(
  state: Pick<UpdateDownloadState, "status" | "progress" | "message">
): string | null {
  if (state.status === "downloading") {
    const pct = state.progress != null ? ` ${Math.round(state.progress)}%` : "…";
    return `Step 1 of 2 · Downloading${pct} — you can keep working`;
  }
  if (state.status === "installing") {
    return `Step 2 of 2 · ${state.message ?? "Installing in the background"}`;
  }
  return null;
}
