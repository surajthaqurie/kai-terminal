import { FC, useEffect, useState } from "react";
import { ChevronUp, Terminal as TerminalIcon } from "lucide-react";
import { sameShellPath } from "../services/paneShell";
import type { ShellProfile } from "../types/terminal";
import { PopupMenu, type MenuEntry } from "./PopupMenu";

interface ShellPickerProps {
  /** Detected shells (the menu lists these). */
  shells: ShellProfile[];
  /** Shell of the focused terminal. */
  current: ShellProfile | undefined;
  /** Restart the focused terminal in this shell. */
  onChange: (shell: ShellProfile) => void;
}

/** Footer label for a shell: its name, minus the marker a custom path adds. */
export function shellLabel(shell: ShellProfile): string {
  return shell.name.replace(/ \(custom\)$/, "") + (shell.is_wsl ? " (WSL)" : "");
}

/**
 * Shell of the focused terminal, first item of the status bar. Opening it lists
 * the detected shells; a shell can't be swapped under a running process, so
 * picking another one asks before restarting that terminal (its folder is kept).
 * Follows the focused pane, so each terminal shows and changes its own shell.
 */
export const ShellPicker: FC<ShellPickerProps> = ({ shells, current, onChange }) => {
  const [pending, setPending] = useState<ShellProfile | null>(null);

  // The focused terminal changed while asking: the question no longer applies.
  const currentPath = current?.path;
  useEffect(() => setPending(null), [currentPath]);

  useEffect(() => {
    if (!pending) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPending(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pending]);

  if (shells.length === 0 && !current) return null;

  const entries: MenuEntry[] = [
    { kind: "heading", id: "shell-heading", label: "Shell for this terminal" },
    ...shells.map((shell): MenuEntry => ({
      id: shell.id,
      label: shellLabel(shell),
      detail: shell.path,
      hint: shell.is_default ? "Default" : undefined,
      checked: sameShellPath(shell.path, current?.path),
      onSelect: () => {
        if (!sameShellPath(shell.path, current?.path)) setPending(shell);
      },
    })),
  ];

  return (
    <div className="shell-picker">
      <PopupMenu
        label="Shell for this terminal"
        side="up"
        entries={entries}
        trigger={({ open, toggle, props }) => (
          <button
            type="button"
            className={`shell-chip${open ? " is-open" : ""}`}
            onClick={toggle}
            title={
              current
                ? `Shell of this terminal: ${current.path}\nClick to run it in another shell`
                : "Choose a shell for this terminal"
            }
            aria-label={`Shell: ${current ? shellLabel(current) : "none"}. Change shell`}
            {...props}
          >
            <TerminalIcon size={12} aria-hidden="true" />
            <span className="shell-chip-name">{current ? shellLabel(current) : "Shell"}</span>
            <ChevronUp size={11} aria-hidden="true" />
          </button>
        )}
      />
      {pending && (
        <div
          className="shell-confirm"
          role="alertdialog"
          aria-labelledby="shell-confirm-title"
          aria-describedby="shell-confirm-body"
        >
          <p id="shell-confirm-title" className="shell-confirm-title">
            Restart this terminal in {shellLabel(pending)}?
          </p>
          <p id="shell-confirm-body" className="shell-confirm-body">
            The current shell and anything running in it will be closed. The folder is kept.
          </p>
          <div className="shell-confirm-actions">
            <button type="button" className="shell-confirm-btn" onClick={() => setPending(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="shell-confirm-btn is-primary"
              autoFocus
              onClick={() => {
                const next = pending;
                setPending(null);
                onChange(next);
              }}
            >
              Restart
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
