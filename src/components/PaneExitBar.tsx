/**
 * Shown on a pane whose shell ended with a failure status (FUNC-09). The pane and its output stay
 * so the reason for the failure can still be read; the user decides what happens next.
 */

/** "code 1", or "code 3221225786 (0xC000013A)" for a Windows status too large to read as decimal. */
export function describeExitCode(code: number | undefined): string {
  if (code === undefined) return "an unknown status";
  if (code > 0xffff || code < -0xffff) {
    const hex = (code >>> 0).toString(16).toUpperCase().padStart(8, "0");
    return `code ${code} (0x${hex})`;
  }
  return `code ${code}`;
}

interface PaneExitBarProps {
  code: number | undefined;
  onRestart: () => void;
  onClose: () => void;
}

export function PaneExitBar({ code, onRestart, onClose }: PaneExitBarProps) {
  const label = `Shell exited with ${describeExitCode(code)}`;
  return (
    <div className="pane-exit-bar" role="status" aria-label={label}>
      <span className="pane-exit-bar-text">{label}</span>
      <div className="pane-exit-bar-actions">
        <button type="button" className="btn btn-primary btn-small" onClick={onRestart}>
          Restart
        </button>
        <button type="button" className="btn btn-secondary btn-small" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}
