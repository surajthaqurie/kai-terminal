import type { PendingClose } from "../hooks/useCloseGuard";
import { Button, Dialog } from "./ui";

/**
 * "This will end a running command" question, shown by `useCloseGuard` before a
 * tab, pane, window or workspace swap closes live work. Escape / the X cancel.
 */
export function CloseConfirmDialog({ pending }: { pending: PendingClose }) {
  return (
    <Dialog open onClose={pending.cancel} title={pending.title} className="dialog-compact">
      <p className="dialog-message">{pending.message}</p>
      <div className="dialog-actions">
        <Button size="sm" onClick={pending.cancel}>
          Cancel
        </Button>
        <Button size="sm" variant="danger" onClick={pending.confirm}>
          {pending.confirmLabel}
        </Button>
      </div>
    </Dialog>
  );
}
