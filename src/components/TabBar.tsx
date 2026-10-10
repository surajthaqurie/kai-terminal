import { FC, useState } from "react";
import { TerminalTab } from "../types/terminal";
import { X, Plus, Terminal as TerminalIcon } from "lucide-react";

interface TabBarProps {
  tabs: TerminalTab[];
  activeTabId: string;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  onNewTab: () => void;
  onRenameTab?: (id: string, title: string) => void;
}

export const TabBar: FC<TabBarProps> = ({
  tabs,
  activeTabId,
  onSelectTab,
  onCloseTab,
  onNewTab,
  onRenameTab,
}) => {
  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");

  const focusTab = (id: string) => {
    // Roving focus follows keyboard selection between tabs.
    document.querySelector<HTMLElement>(`[data-tab-id="${id}"]`)?.focus();
  };

  const handleTabKeyDown = (e: React.KeyboardEvent, index: number) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onSelectTab(tabs[index].id);
    } else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      const dir = e.key === "ArrowRight" ? 1 : -1;
      const next = tabs[(index + dir + tabs.length) % tabs.length];
      onSelectTab(next.id);
      focusTab(next.id);
    } else if (e.key === "Home") {
      e.preventDefault();
      onSelectTab(tabs[0].id);
      focusTab(tabs[0].id);
    } else if (e.key === "End") {
      e.preventDefault();
      onSelectTab(tabs[tabs.length - 1].id);
      focusTab(tabs[tabs.length - 1].id);
    }
  };

  const startEditing = (tab: TerminalTab) => {
    setEditingTabId(tab.id);
    setEditTitle(tab.title);
  };

  const finishEditing = (tabId: string) => {
    if (editingTabId === tabId && editTitle.trim()) {
      onRenameTab?.(tabId, editTitle.trim());
    }
    setEditingTabId(null);
  };

  return (
    <div className="tab-bar">
      <div className="tabs-container" role="tablist" aria-label="Terminal sessions">
        {tabs.map((tab, index) => {
          const isActive = tab.id === activeTabId;
          const isEditing = editingTabId === tab.id;
          return (
            <div
              key={tab.id}
              data-tab-id={tab.id}
              role="tab"
              aria-selected={isActive}
              aria-label={`${tab.title}, ${tab.status}`}
              tabIndex={isActive ? 0 : -1}
              className={`tab-item ${isActive ? "active" : ""} status-${tab.status}`}
              onClick={() => onSelectTab(tab.id)}
              onKeyDown={(e) => handleTabKeyDown(e, index)}
            >
              <TerminalIcon size={14} className="tab-icon" />
              {isEditing ? (
                <input
                  type="text"
                  className="text-input"
                  style={{ height: "20px", fontSize: "11px", padding: "0 4px" }}
                  value={editTitle}
                  autoFocus
                  onChange={(e) => setEditTitle(e.target.value)}
                  onBlur={() => finishEditing(tab.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      finishEditing(tab.id);
                    } else if (e.key === "Escape") {
                      setEditingTabId(null);
                    }
                  }}
                  onClick={(e) => e.stopPropagation()}
                />
              ) : (
                <span
                  className="tab-title"
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    startEditing(tab);
                  }}
                  title="Double click to rename session"
                >
                  {tab.title}
                </span>
              )}
              {tabs.length > 1 && (
                <button
                  className="tab-close-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    onCloseTab(tab.id);
                  }}
                  title="Close Session"
                  aria-label={`Close ${tab.title}`}
                >
                  <X size={12} />
                </button>
              )}
            </div>
          );
        })}
      </div>
      <button
        className="tab-add-btn"
        onClick={onNewTab}
        title="New Tab"
        aria-label="New terminal tab"
      >
        <Plus size={16} />
      </button>
    </div>
  );
};
