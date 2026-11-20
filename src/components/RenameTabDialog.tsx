import { useEffect, useRef, useState } from "react";
import type { TerminalTab } from "../types/terminal";
import { Button, Dialog } from "./ui";

interface RenameTabDialogProps {
  tab: TerminalTab;
  onRename: (tabId: string, title: string) => void;
  onClose: () => void;
}

/** Small modal that renames one tab; mount it only while renaming. */
export function RenameTabDialog({ tab, onRename, onClose }: RenameTabDialogProps) {
  const [value, setValue] = useState(tab.title);
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus the field after the dialog has recorded where focus came from (not
  // `autoFocus`, which ran first and left focus nowhere when the dialog closed).
  useEffect(() => {
    const t = setTimeout(() => inputRef.current?.select(), 0);
    return () => clearTimeout(t);
  }, []);

  return (
    <Dialog open onClose={onClose} title="Rename session" className="dialog-compact">
      <form
        className="dialog-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (value.trim()) onRename(tab.id, value.trim());
          onClose();
        }}
      >
        <input
          ref={inputRef}
          id="rename-session-input"
          type="text"
          className="text-input modal-input"
          aria-label="Session name"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Session name"
        />
        <div className="dialog-actions">
          <Button size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" variant="primary" type="submit">
            Save
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
