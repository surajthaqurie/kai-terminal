import { useState } from "react";
import type { TerminalTab } from "../types/terminal";

interface RenameTabDialogProps {
  tab: TerminalTab;
  onRename: (tabId: string, title: string) => void;
  onClose: () => void;
}

/** Small modal that renames one tab; mount it only while renaming. */
export function RenameTabDialog({ tab, onRename, onClose }: RenameTabDialogProps) {
  const [value, setValue] = useState(tab.title);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="command-palette-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Rename session"
        style={{ padding: 16 }}
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (value.trim()) onRename(tab.id, value.trim());
            onClose();
          }}
        >
          <label htmlFor="rename-session-input" className="shortcut-label">
            Rename session
          </label>
          <input
            id="rename-session-input"
            type="text"
            className="text-input modal-input"
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="Session name"
            style={{ marginTop: 8 }}
          />
          <div className="footer-actions" style={{ marginTop: 12, justifyContent: "flex-end" }}>
            <button type="button" className="btn btn-secondary btn-small" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary btn-small">
              Save
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
