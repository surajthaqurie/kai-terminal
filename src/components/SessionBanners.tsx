import { Banner, Button } from "./ui";

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
          tone="info"
          label="Restore previous session"
          actions={
            <>
              <Button size="sm" variant="primary" onClick={onRestoreSession}>
                Load session
              </Button>
              <Button size="sm" onClick={onDismissRestore}>
                Start fresh
              </Button>
            </>
          }
        >
          {`Previous session found (${pendingRestoreCount} tab${
            pendingRestoreCount === 1 ? "" : "s"
          }). Kai started fresh for a fast launch.`}
        </Banner>
      )}
      {paneNotice && (
        // Informational: the split was refused, nothing broke.
        <Banner
          tone="info"
          label="Pane split unavailable"
          actions={
            <Button size="sm" onClick={onDismissNotice}>
              Dismiss
            </Button>
          }
        >
          {paneNotice}
        </Banner>
      )}
      {faultMessage && (
        <Banner
          tone="danger"
          label="Shell keeps exiting"
          actions={
            <>
              <Button size="sm" variant="primary" onClick={onRetryFault}>
                Retry
              </Button>
              <Button size="sm" onClick={onOpenSettings}>
                Open Settings
              </Button>
              <Button size="sm" onClick={onDismissFault}>
                Dismiss
              </Button>
            </>
          }
        >
          {faultMessage}
        </Banner>
      )}
    </>
  );
}
