import { useId, type ReactNode } from "react";
import { X } from "lucide-react";
import { useModalBehavior } from "../../hooks/useModalBehavior";
import { IconButton } from "./IconButton";

interface DialogProps {
  open: boolean;
  onClose: () => void;
  /** Visible heading; also the dialog's accessible name. */
  title: ReactNode;
  children: ReactNode;
  /** Footer actions (right-aligned). */
  footer?: ReactNode;
  /** Panel class for size variants (e.g. `settings-modal`). */
  className?: string;
}

/**
 * Modal dialog: backdrop, `role="dialog"` + `aria-modal`, labelled by its
 * title, with the shared keyboard behaviour (focus in, Tab trap, Escape,
 * focus return) from `useModalBehavior`. Renders nothing while closed.
 */
export function Dialog({ open, onClose, title, children, footer, className }: DialogProps) {
  const dialogRef = useModalBehavior<HTMLDivElement>(open, onClose);
  const titleId = useId();
  if (!open) return null;
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        ref={dialogRef}
        className={className ? `dialog ${className}` : "dialog"}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h2 id={titleId} className="dialog-title">
            {title}
          </h2>
          <IconButton label="Close" icon={<X size={16} />} onClick={onClose} />
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  );
}
