import { FC, useEffect, useId, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";
import { useModalBehavior } from "../hooks/useModalBehavior";
import { Kbd } from "./ui/Kbd";
import {
  loadRecentCommands,
  rankActions,
  recordRecentCommand,
  withRecentsFirst,
} from "./commandRanking";

export interface CommandAction {
  id: string;
  label: string;
  category: string;
  shortcut?: string;
  icon: React.ReactNode;
  perform: () => void;
}

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
  actions: CommandAction[];
}

/**
 * Command palette: a modal dialog holding an ARIA combobox (the input) that
 * controls a listbox (the results). Focus stays in the input; the highlighted
 * option is exposed with `aria-activedescendant` and scrolled into view.
 * Escape, Tab trapping and focus return come from `useModalBehavior`.
 */
export const CommandPalette: FC<CommandPaletteProps> = ({ isOpen, onClose, actions }) => {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [recentIds, setRecentIds] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const dialogRef = useModalBehavior(isOpen, onClose);
  const listId = useId();
  const optionId = (index: number) => `${listId}-option-${index}`;

  const { items, recentCount } = useMemo(
    () =>
      query.trim()
        ? { items: rankActions(actions, query), recentCount: 0 }
        : withRecentsFirst(actions, recentIds),
    [actions, query, recentIds]
  );

  useEffect(() => {
    if (!isOpen) return;
    setQuery("");
    setSelectedIndex(0);
    setRecentIds(loadRecentCommands());
    // After useModalBehavior has recorded where focus was (the terminal), so
    // closing the palette returns focus there.
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [isOpen]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${selectedIndex}"]`)
      ?.scrollIntoView?.({ block: "nearest" });
  }, [selectedIndex, items]);

  if (!isOpen) return null;

  const run = (action: CommandAction) => {
    recordRecentCommand(action.id);
    action.perform();
    onClose();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((prev) => (prev < items.length - 1 ? prev + 1 : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((prev) => (prev > 0 ? prev - 1 : items.length - 1));
    } else if (e.key === "Home" && e.ctrlKey) {
      e.preventDefault();
      setSelectedIndex(0);
    } else if (e.key === "End" && e.ctrlKey) {
      e.preventDefault();
      setSelectedIndex(Math.max(0, items.length - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const selected = items[selectedIndex];
      if (selected) run(selected);
    }
  };

  const hasResults = items.length > 0;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        ref={dialogRef}
        className="command-palette-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div className="palette-input-wrapper">
          <Search size={18} className="palette-search-icon" aria-hidden="true" />
          <input
            ref={inputRef}
            type="text"
            className="palette-input"
            placeholder="Type a command or search actions..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            role="combobox"
            aria-label="Search commands"
            aria-expanded={hasResults}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={hasResults ? optionId(selectedIndex) : undefined}
            autoComplete="off"
            spellCheck={false}
          />
        </div>

        <div
          className="palette-list"
          id={listId}
          role="listbox"
          ref={listRef}
          aria-label="Commands"
        >
          {!hasResults ? (
            <div className="palette-empty" role="status">
              No matching commands
            </div>
          ) : (
            items.map((action, idx) => (
              <div
                key={action.id}
                id={optionId(idx)}
                data-index={idx}
                role="option"
                aria-selected={idx === selectedIndex}
                className={`palette-item ${idx === selectedIndex ? "selected" : ""}${
                  idx === recentCount - 1 ? " palette-item-last-recent" : ""
                }`}
                onClick={() => run(action)}
                onMouseMove={() => idx !== selectedIndex && setSelectedIndex(idx)}
              >
                <div className="palette-item-icon" aria-hidden="true">
                  {action.icon}
                </div>
                <div className="palette-item-details">
                  <span className="palette-item-label">{action.label}</span>
                  <span className="palette-item-category">
                    {idx < recentCount ? "Recent" : action.category}
                  </span>
                </div>
                {action.shortcut && <Kbd className="palette-shortcut">{action.shortcut}</Kbd>}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
};
