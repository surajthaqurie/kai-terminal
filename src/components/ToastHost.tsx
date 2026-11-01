import { AlertCircle, CheckCircle2, Info, X } from "lucide-react";
import type { Notice, NoticeKind } from "../hooks/useNotices";

interface ToastHostProps {
  notices: Notice[];
  onDismiss: (id: number) => void;
  /** Opens the diagnostics view; offered on errors only. */
  onDetails?: () => void;
}

const ICONS: Record<NoticeKind, typeof Info> = {
  error: AlertCircle,
  success: CheckCircle2,
  info: Info,
};

/**
 * Toast stack above the footer. Errors are announced assertively (role=alert);
 * confirmations politely (role=status). The host itself ignores the pointer so
 * it never blocks the terminal behind the gaps between toasts.
 */
export function ToastHost({ notices, onDismiss, onDetails }: ToastHostProps) {
  if (notices.length === 0) return null;
  return (
    <div className="toast-host" aria-label="Notifications">
      {notices.map((n) => {
        const Icon = ICONS[n.kind];
        return (
          <div
            key={n.id}
            className={`toast toast-${n.kind}`}
            role={n.kind === "error" ? "alert" : "status"}
          >
            <Icon size={16} className="toast-icon" aria-hidden="true" />
            <span className="toast-message">{n.message}</span>
            {n.kind === "error" && onDetails && (
              <button type="button" className="toast-action" onClick={onDetails}>
                Details
              </button>
            )}
            <button
              type="button"
              className="toast-close"
              onClick={() => onDismiss(n.id)}
              aria-label="Dismiss notification"
              title="Dismiss"
            >
              <X size={14} aria-hidden="true" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
