import type { ReactNode } from "react";

interface BannerProps {
  role: "status" | "alert";
  label: string;
  text: string;
  danger?: boolean;
  children: ReactNode;
}

function Banner({ role, label, text, danger, children }: BannerProps) {
  return (
    <div
      className="session-restore-banner"
      role={role}
      aria-label={label}
      style={danger ? { borderColor: "var(--color-danger)" } : undefined}
    >
      <span className="session-restore-text">{text}</span>
      <div className="session-restore-actions">{children}</div>
    </div>
  );
}

function BannerButton({
  primary,
  onClick,
  children,
}: {
  primary?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={`btn ${primary ? "btn-primary" : "btn-secondary"} btn-small`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

interface SessionBannersProps {
  /** Number of tabs in a previous session offered for restore (0 = none). */
  pendingRestoreCount: number;
  onRestoreSession: () => void;
  onDismissRestore: () => void;
  paneNotice: string | null;
  onDismissNotice: () => void;
  /** Crash-loop / instant-death fault for a pane, if any. */
  faultMessage: string | null;
  onRetryFault: () => void;
  onOpenSettings: () => void;
  onDismissFault: () => void;
}

/** Banners above the terminals: session restore offer, split refusal, shell fault. */
export function SessionBanners({
  pendingRestoreCount,
  onRestoreSession,
  onDismissRestore,
  paneNotice,
  onDismissNotice,
  faultMessage,
  onRetryFault,
  onOpenSettings,
  onDismissFault,
}: SessionBannersProps) {
  return (
    <>
      {pendingRestoreCount > 0 && (
        <Banner
          role="status"
          label="Restore previous session"
          text={`Previous session found (${pendingRestoreCount} tab${
            pendingRestoreCount === 1 ? "" : "s"
          }). Kai started fresh for a fast launch.`}
        >
          <BannerButton primary onClick={onRestoreSession}>
            Load session
          </BannerButton>
          <BannerButton onClick={onDismissRestore}>Start fresh</BannerButton>
        </Banner>
      )}
      {paneNotice && (
        <Banner role="status" label="Pane split unavailable" text={paneNotice}>
          <BannerButton onClick={onDismissNotice}>Dismiss</BannerButton>
        </Banner>
      )}
      {faultMessage && (
        <Banner role="alert" label="Shell keeps exiting" text={faultMessage} danger>
          <BannerButton primary onClick={onRetryFault}>
            Retry
          </BannerButton>
          <BannerButton onClick={onOpenSettings}>Open Settings</BannerButton>
          <BannerButton onClick={onDismissFault}>Dismiss</BannerButton>
        </Banner>
      )}
    </>
  );
}
