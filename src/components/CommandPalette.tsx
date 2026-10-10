import { FC, useState, useEffect, useRef } from "react";
import { Search } from "lucide-react";

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

export const CommandPalette: FC<CommandPaletteProps> = ({ isOpen, onClose, actions }) => {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const filteredActions = actions.filter(
    (action) =>
      action.label.toLowerCase().includes(query.toLowerCase()) ||
      action.category.toLowerCase().includes(query.toLowerCase())
  );

  useEffect(() => {
    if (isOpen) {
      setQuery("");
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  if (!isOpen) return null;

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((prev) => (prev < filteredActions.length - 1 ? prev + 1 : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((prev) => (prev > 0 ? prev - 1 : filteredActions.length - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const selected = filteredActions[selectedIndex];
      if (selected) {
        selected.perform();
        onClose();
      }
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="command-palette-modal"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div className="palette-input-wrapper">
          <Search size={18} className="palette-search-icon" />
          <input
            ref={inputRef}
            type="text"
            className="palette-input"
            placeholder="Type a command or search actions..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        <div className="palette-list">
          {filteredActions.length === 0 ? (
            <div className="palette-empty">No matching actions found</div>
          ) : (
            filteredActions.map((action, idx) => (
              <div
                key={action.id}
                className={`palette-item ${idx === selectedIndex ? "selected" : ""}`}
                onClick={() => {
                  action.perform();
                  onClose();
                }}
                onMouseEnter={() => setSelectedIndex(idx)}
              >
                <div className="palette-item-icon">{action.icon}</div>
                <div className="palette-item-details">
                  <span className="palette-item-label">{action.label}</span>
                  <span className="palette-item-category">{action.category}</span>
                </div>
                {action.shortcut && <kbd className="palette-shortcut">{action.shortcut}</kbd>}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
};
