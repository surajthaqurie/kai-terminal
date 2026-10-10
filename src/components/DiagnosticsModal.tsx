import { FC, useEffect, useState } from "react";
import { X, Copy } from "lucide-react";
import { getDiagnostics, DiagnosticsReport } from "../services/diagnosticsService";

interface DiagnosticsModalProps {
  isOpen: boolean;
  onClose: () => void;
  lastError?: string | null;
}

export const DiagnosticsModal: FC<DiagnosticsModalProps> = ({ isOpen, onClose, lastError }) => {
  const [report, setReport] = useState<DiagnosticsReport | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (isOpen) {
      getDiagnostics()
        .then(setReport)
        .catch(() => setReport(null));
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const exportText = JSON.stringify(
    {
      report,
      lastError: lastError || null,
      note: "Terminal content, env values, and credentials are never included.",
    },
    null,
    2
  );

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(exportText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable
    }
  };

  const handleDownload = () => {
    const blob = new Blob([exportText], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `terminal-diagnostics-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div
      className="modal-backdrop"
      onClick={onClose}
      role="dialog"
      aria-label="Diagnostics and recovery"
    >
      <div className="settings-modal" onClick={(e) => e.stopPropagation()} role="document">
        <div className="modal-header">
          <h3>Diagnostics &amp; Recovery</h3>
          <button
            className="btn-close"
            onClick={onClose}
            title="Close"
            aria-label="Close diagnostics"
          >
            <X size={18} />
          </button>
        </div>
        <div className="modal-body">
          {lastError && (
            <div className="setting-field">
              <label>Last session error</label>
              <p className="error-text" role="alert">
                {lastError}
              </p>
            </div>
          )}
          <div className="setting-field">
            <label>Safe diagnostic export (no terminal content or secrets)</label>
            <pre
              className="muted-text"
              style={{
                whiteSpace: "pre-wrap",
                maxHeight: "240px",
                overflowY: "auto",
              }}
            >
              {exportText}
            </pre>
          </div>
          <p className="muted-text">
            Shells run with your OS user permissions (no sandbox). If a shell is missing, pick
            another profile or install it. If the PTY fails to start, the error above shows the
            cause without exposing secrets.
          </p>
        </div>
        <div className="modal-footer">
          <div className="footer-actions">
            <button className="btn btn-secondary" onClick={handleCopy}>
              <Copy size={14} />
              <span>{copied ? "Copied" : "Copy details"}</span>
            </button>
            <button className="btn btn-secondary" onClick={handleDownload}>
              Download (.json)
            </button>
          </div>
          <button className="btn btn-primary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
