import { FC, useEffect, useRef, useState } from "react";
import { TerminalTab } from "../types/terminal";
import { X, Plus, Terminal as TerminalIcon } from "lucide-react";

interface TabBarProps {
  tabs: TerminalTab[];
  activeTabId: string;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  onNewTab: () => void;
  onRenameTab?: (id: string, title: string) => void;
  onMoveTab?: (id: string, dir: -1 | 1) => void;
  onReorderTabs?: (fromId: string, toId: string) => void;
  onSetTabColor?: (id: string, color: string | undefined) => void;
}

export const TAB_COLOR_PRESETS = [
  "#89b4fa",
  "#a6e3a1",
  "#f9e2af",
  "#f38ba8",
  "#cba6f7",
  "#94e2d5",
  "#fab387",
  "#9399b2",
];

interface MenuState {
  tabId: string;
  x: number;
  y: number;
}

export const TabBar: FC<TabBarProps> = ({
  tabs,
  activeTabId,
  onSelectTab,
  onCloseTab,
  onNewTab,
  onRenameTab,
  onMoveTab,
  onReorderTabs,
  onSetTabColor,
}) => {
  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [menu, setMenu] = useState<MenuState | null>(null);
  const dragIdRef = useRef<string | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
    };
    window.addEventListener("click", close);
    window.addEventListener("blur", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  const focusTab = (id: string) => {
    // Roving focus follows keyboard selection between tabs.
    document.querySelector<HTMLElement>(`[data-tab-id="${id}"]`)?.focus();
  };

  const handleTabKeyDown = (e: React.KeyboardEvent, index: number) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onSelectTab(tabs[index].id);
    } else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      // Alt+Arrow reorders the tab; plain arrows just move selection.
      if (e.altKey) {
        e.preventDefault();
        onMoveTab?.(tabs[index].id, e.key === "ArrowRight" ? 1 : -1);
        requestAnimationFrame(() => focusTab(tabs[index].id));
      } else {
        e.preventDefault();
        const dir = e.key === "ArrowRight" ? 1 : -1;
        const next = tabs[(index + dir + tabs.length) % tabs.length];
        onSelectTab(next.id);
        focusTab(next.id);
      }
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

  const openMenu = (e: React.MouseEvent, tab: TerminalTab) => {
    e.preventDefault();
    e.stopPropagation();
    const menuWidth = 210;
    const x = Math.min(e.clientX, window.innerWidth - menuWidth - 8);
    setMenu({ tabId: tab.id, x: Math.max(8, x), y: e.clientY });
  };

  const menuTab = menu ? tabs.find((t) => t.id === menu.tabId) : undefined;
  const menuIndex = menuTab ? tabs.findIndex((t) => t.id === menuTab.id) : -1;

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
              style={tab.color ? { borderTop: `2px solid ${tab.color}` } : undefined}
              draggable={!isEditing}
              onDragStart={(e) => {
                dragIdRef.current = tab.id;
                e.dataTransfer.effectAllowed = "move";
                try {
                  e.dataTransfer.setData("text/plain", tab.id);
                } catch {
                  // some browsers restrict dataTransfer payloads; ref fallback covers it
                }
              }}
              onDragOver={(e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
              }}
              onDrop={(e) => {
                e.preventDefault();
                const fromId = dragIdRef.current || e.dataTransfer.getData("text/plain");
                dragIdRef.current = null;
                if (fromId) onReorderTabs?.(fromId, tab.id);
              }}
              onDragEnd={() => {
                dragIdRef.current = null;
              }}
              onClick={() => onSelectTab(tab.id)}
              onContextMenu={(e) => openMenu(e, tab)}
              onKeyDown={(e) => handleTabKeyDown(e, index)}
            >
              <TerminalIcon size={14} className="tab-icon" />
              {tab.color && (
                <span
                  className="tab-color-dot"
                  style={{ backgroundColor: tab.color }}
                  aria-hidden="true"
                />
              )}
              {isEditing ? (
                <input
                  type="text"
                  className="text-input"
                  style={{ height: "20px", fontSize: "11px", padding: "0 4px" }}
                  value={editTitle}
                  autoFocus
                  maxLength={80}
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
                  aria-label="Tab title"
                />
              ) : (
                <span
                  className="tab-title"
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    startEditing(tab);
                  }}
                  title="Double-click or right-click to rename"
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

      {menu && menuTab && (
        <div
          ref={menuRef}
          className="tab-context-menu"
          role="menu"
          aria-label={`Actions for ${menuTab.title}`}
          style={{ left: menu.x, top: menu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            role="menuitem"
            className="tab-menu-item"
            onClick={() => {
              setMenu(null);
              onSelectTab(menuTab.id);
              startEditing(menuTab);
            }}
          >
            Rename tab
          </button>
          <div className="tab-menu-row" aria-label="Tab color">
            <span className="tab-menu-label">Color</span>
            <div className="tab-color-swatches">
              <button
                type="button"
                className={`tab-color-swatch${!menuTab.color ? " selected" : ""}`}
                title="Default (no color)"
                aria-label="Default tab color"
                onClick={() => {
                  onSetTabColor?.(menuTab.id, undefined);
                  setMenu(null);
                }}
              />
              {TAB_COLOR_PRESETS.map((c) => (
                <button
                  key={c}
                  type="button"
                  className={`tab-color-swatch${menuTab.color === c ? " selected" : ""}`}
                  style={{ backgroundColor: c }}
                  title={c}
                  aria-label={`Tab color ${c}`}
                  onClick={() => {
                    onSetTabColor?.(menuTab.id, c);
                    setMenu(null);
                  }}
                />
              ))}
            </div>
          </div>
          <button
            type="button"
            role="menuitem"
            className="tab-menu-item"
            disabled={menuIndex <= 0}
            onClick={() => {
              onMoveTab?.(menuTab.id, -1);
              setMenu(null);
            }}
          >
            Move left
          </button>
          <button
            type="button"
            role="menuitem"
            className="tab-menu-item"
            disabled={menuIndex < 0 || menuIndex >= tabs.length - 1}
            onClick={() => {
              onMoveTab?.(menuTab.id, 1);
              setMenu(null);
            }}
          >
            Move right
          </button>
          {tabs.length > 1 && (
            <button
              type="button"
              role="menuitem"
              className="tab-menu-item danger"
              onClick={() => {
                setMenu(null);
                onCloseTab(menuTab.id);
              }}
            >
              Close tab
            </button>
          )}
        </div>
      )}
    </div>
  );
};
