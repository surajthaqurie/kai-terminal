import { FC, useState } from "react";
import { X, Copy, Check, GitBranch } from "lucide-react";

interface GitStatusModalProps {
  dir: string;
  output: string;
  onClose: () => void;
}

/**
 * Proper centered in-app dialog replacing the native browser `alert()`
 * for `git status`. Rendered in `.modal-backdrop` (flex-centered) so it
 * always appears in the middle of the window with copy/close actions.
 */
export const GitStatusModal: FC<GitStatusModalProps> = ({ dir, output, onClose }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(output);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable — leave dialog open
    }
  };

  return (
    <div
      className="modal-backdrop"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`Git status for ${dir}`}
    >
      <div
        className="git-status-modal"
        onClick={(e) => e.stopPropagation()}
        role="document"
      >
        <div className="modal-header">
          <h3>
            <GitBranch size={15} aria-hidden="true" style={{ verticalAlign: "-2px", marginRight: 6 }} />
            Git Status
          </h3>
          <button
            className="btn-close"
            onClick={onClose}
            title="Close"
            aria-label="Close git status"
            autoFocus
          >
            <X size={18} />
          </button>
        </div>
        <div className="modal-body">
          <p className="muted-text git-status-dir" title={dir}>
            {dir}
          </p>
          <pre className="git-status-output" tabIndex={0} aria-label="Git status output">
            {output || "(clean — no output)"}
          </pre>
        </div>
        <div className="modal-footer">
          <div className="footer-actions">
            <button type="button" className="btn btn-secondary btn-small" onClick={handleCopy}>
              {copied ? <Check size={13} /> : <Copy size={13} />}
              <span>{copied ? "Copied!" : "Copy"}</span>
            </button>
          </div>
          <div className="footer-actions">
            <button type="button" className="btn btn-primary btn-small" onClick={onClose}>
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
