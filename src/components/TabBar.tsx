import { CSSProperties, FC, ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { ShellProfile, TerminalTab } from "../types/terminal";
import { X, Plus, ChevronDown, Terminal as TerminalIcon } from "lucide-react";
import { PopupMenu, type MenuEntry } from "./PopupMenu";
import { WindowControls } from "./WindowControls";
import { isTauriAvailable } from "../services/ptyService";
import { isMacPlatform } from "../services/shortcuts";

interface TabBarProps {
  tabs: TerminalTab[];
  activeTabId: string;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  onNewTab: () => void;
  onRenameTab?: (id: string, title: string) => void;
  onMoveTab?: (id: string, dir: -1 | 1) => void;
  onReorderTabs?: (fromId: string, toId: string) => void;
  /** Preferred reorder path: move tab to an absolute index. Works on all OSes. */
  onMoveTabToIndex?: (id: string, toIndex: number) => void;
  onSetTabColor?: (id: string, color: string | undefined) => void;
  /** Shell profiles for the "+ ▾" picker; the picker is hidden without them. */
  shells?: ShellProfile[];
  selectedShellId?: string;
  onNewTabWithShell?: (shell: ShellProfile) => void;
  /** Right-hand header content, placed between the drag strip and the window controls. */
  children?: ReactNode;
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

/** Touch/pen fallback: press-and-hold this long picks the tab up. */
const LONG_PRESS_MS = 500;
/** Pointer may wander this far during the hold and still count as a press. */
const HOLD_SLOP_PX = 12;
/** Mouse: a drag past this slop picks the tab up immediately (no hold needed)
 *  — using the standard press-and-drag gesture everyone expects. The slop
 *  keeps a plain click (or a few pixels of wiggle) selecting the tab. */
const MOUSE_DRAG_SLOP_PX = 8;

export const TabBar: FC<TabBarProps> = ({
  tabs,
  activeTabId,
  onSelectTab,
  onCloseTab,
  onNewTab,
  onRenameTab,
  onMoveTab,
  onReorderTabs,
  onMoveTabToIndex,
  onSetTabColor,
  shells = [],
  selectedShellId,
  onNewTabWithShell,
  children,
}) => {
  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const pendingRef = useRef<{
    id: string;
    startX: number;
    startY: number;
    lastX: number;
    lastY: number;
    pointerId: number;
    pointerType: string | null;
  } | null>(null);
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dragIdRef = useRef<string | null>(null);
  const dropIndexRef = useRef<number | null>(null);
  const suppressClickRef = useRef(false);
  // Tabs snapshot for pointer handlers (avoids stale closures on window listeners).
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

  const cancelDrag = useCallback(() => {
    pendingRef.current = null;
    dragIdRef.current = null;
    dropIndexRef.current = null;
    setDragId(null);
    setDropIndex(null);
    document.body.classList.remove("tab-dragging");
    if (holdTimerRef.current) {
      clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
  }, []);

  const computeDropIndex = useCallback((clientX: number): number => {
    const container = containerRef.current;
    const currentTabs = tabsRef.current;
    if (!container) return currentTabs.length;
    const items = Array.from(container.querySelectorAll<HTMLElement>("[data-tab-id]"));
    for (let i = 0; i < currentTabs.length; i++) {
      const el = items.find((n) => n.getAttribute("data-tab-id") === currentTabs[i].id);
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      if (clientX < rect.left + rect.width / 2) return i;
    }
    return currentTabs.length;
  }, []);

  const commitDrag = useCallback(() => {
    const fromId = dragIdRef.current;
    const target = dropIndexRef.current;
    const currentTabs = tabsRef.current;
    if (!fromId || target == null) {
      cancelDrag();
      return;
    }
    const fromIdx = currentTabs.findIndex((t) => t.id === fromId);
    if (fromIdx < 0) {
      cancelDrag();
      return;
    }
    // dropIndex is measured against the pre-drag order (dragged tab still in place).
    let adjusted = target;
    if (fromIdx < target) adjusted = target - 1;
    adjusted = Math.max(0, Math.min(currentTabs.length - 1, adjusted));
    if (adjusted !== fromIdx) {
      if (onMoveTabToIndex) {
        onMoveTabToIndex(fromId, adjusted);
      } else if (onReorderTabs) {
        const toId = currentTabs[adjusted]?.id;
        if (toId && toId !== fromId) onReorderTabs(fromId, toId);
      }
      // A real reorder happened: swallow the click that pointer-up would fire.
      suppressClickRef.current = true;
    }
    cancelDrag();
  }, [cancelDrag, onMoveTabToIndex, onReorderTabs]);

  // Long-press pickup (touch/pen): holding the pointer (nearly) still for
  // LONG_PRESS_MS lifts the tab into drag mode before any movement, so the
  // cursor flips to the move cursor while the button is still held down.
  // Mouse presses bypass the hold entirely — see `onMove` below.
  const armDrag = useCallback((id: string) => {
    if (dragIdRef.current) return;
    dragIdRef.current = id;
    setDragId(id);
    document.body.classList.add("tab-dragging");
  }, []);

  const armDragFromHold = useCallback(
    (id: string) => {
      const pending = pendingRef.current;
      if (!pending || pending.id !== id || dragIdRef.current) return;
      if (Math.hypot(pending.lastX - pending.startX, pending.lastY - pending.startY) > HOLD_SLOP_PX)
        return;
      // Don't arm while renaming.
      const tabEl = containerRef.current?.querySelector(`[data-tab-id="${pending.id}"] input`);
      if (tabEl) {
        pendingRef.current = null;
        return;
      }
      armDrag(pending.id);
    },
    [armDrag]
  );
  // Window-level pointer tracking: started on tab pointer-down, so dragging
  // keeps working even when the cursor leaves the tab bar. This is what makes
  // reordering reliable on Windows (WebView2), macOS (WKWebView) and Linux
  // (WebKitGTK), where native HTML5 drag-and-drop is flaky and shows a
  // "not-allowed" cursor.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onMove = (e: PointerEvent) => {
      const pending = pendingRef.current;
      if (!pending) return;
      if (e.pointerId !== pending.pointerId && e.pointerType !== "touch") return;
      pending.lastX = e.clientX;
      pending.lastY = e.clientY;
      const dx = e.clientX - pending.startX;
      const dy = e.clientY - pending.startY;
      if (!dragIdRef.current) {
        // Mouse picks the tab up as soon as the press moves past a small
        // slop — the standard press-and-drag gesture. Touch/pen keeps the
        // hold-to-lift path below so a swipe/scroll can't reorder by accident.
        if (pending.pointerType === "mouse") {
          if (Math.hypot(dx, dy) > MOUSE_DRAG_SLOP_PX) {
            if (holdTimerRef.current) {
              clearTimeout(holdTimerRef.current);
              holdTimerRef.current = null;
            }
            armDrag(pending.id);
          }
          return;
        }
        // Long-press only: moving before the hold completes is NOT a drag
        // (a plain swipe/click-and-wiggle must never reorder). Once the
        // pointer leaves the press slop, drop the pending hold so the tab
        // can't lift later from a press the user already moved away from.
        if (Math.hypot(dx, dy) > HOLD_SLOP_PX) {
          if (holdTimerRef.current) {
            clearTimeout(holdTimerRef.current);
            holdTimerRef.current = null;
          }
          pendingRef.current = null;
        }
        return;
      }
      const idx = computeDropIndex(e.clientX);
      dropIndexRef.current = idx;
      setDropIndex(idx);
      // Auto-scroll the strip when hovering near its edges.
      const container = containerRef.current;
      if (container) {
        const rect = container.getBoundingClientRect();
        const EDGE = 28;
        const SPEED = 12;
        if (e.clientX < rect.left + EDGE) container.scrollLeft -= SPEED;
        else if (e.clientX > rect.right - EDGE) container.scrollLeft += SPEED;
      }
    };
    const onUp = (e: PointerEvent) => {
      if (holdTimerRef.current) {
        clearTimeout(holdTimerRef.current);
        holdTimerRef.current = null;
      }
      const pending = pendingRef.current;
      if (!pending) return;
      if (e.pointerId !== pending.pointerId && e.type !== "pointercancel") return;
      if (dragIdRef.current) {
        // Refresh the target from the release point before committing.
        dropIndexRef.current = computeDropIndex(e.clientX);
        commitDrag();
      } else {
        pendingRef.current = null;
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") cancelDrag();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      window.removeEventListener("keydown", onKey);
    };
  }, [armDrag, cancelDrag, commitDrag, computeDropIndex]);

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

  // Clear drag state if tabs unmount mid-drag.
  useEffect(() => cancelDrag, [cancelDrag]);

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
    cancelDrag();
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
    cancelDrag();
    const menuWidth = 210;
    const x = Math.min(e.clientX, window.innerWidth - menuWidth - 8);
    setMenu({ tabId: tab.id, x: Math.max(8, x), y: e.clientY });
  };

  const beginPotentialDrag = (e: React.PointerEvent, tab: TerminalTab) => {
    // Only the primary button starts a drag. Right/middle clicks, the close
    // button, and the rename input must never start one.
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if (editingTabId === tab.id) return;
    const target = e.target as HTMLElement | null;
    if (target?.closest?.(".tab-close-btn, input, button")) {
      // Close/add buttons handle their own clicks; still allow drag when the
      // press starts on the tab body itself.
      if (target.closest(".tab-close-btn")) return;
    }
    pendingRef.current = {
      id: tab.id,
      startX: e.clientX,
      startY: e.clientY,
      lastX: e.clientX,
      lastY: e.clientY,
      pointerId: e.pointerId,
      pointerType: e.pointerType ?? "mouse",
    };
    // Hold-to-pick-up (touch/pen): a press held (nearly) still lifts the tab
    // and flips the cursor to the move cursor before any movement — reachable
    // without moving the mouse at all. A mouse press arms on first movement
    // instead (see onMove), so a plain click stays a plain click.
    if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
    holdTimerRef.current = setTimeout(() => {
      holdTimerRef.current = null;
      armDragFromHold(tab.id);
    }, LONG_PRESS_MS);
  };

  const handleTabClick = (tabId: string) => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    if (dragIdRef.current) return;
    onSelectTab(tabId);
  };

  const shellEntries: MenuEntry[] = [
    { kind: "heading", id: "shell-heading", label: "New tab with…" },
    ...shells.map((shell): MenuEntry => ({
      id: shell.id,
      label: shell.name + (shell.is_wsl ? " (WSL)" : ""),
      detail: shell.path,
      hint: shell.is_default ? "Default" : undefined,
      checked: shell.id === selectedShellId,
      onSelect: () => onNewTabWithShell?.(shell),
    })),
  ];

  const menuTab = menu ? tabs.find((t) => t.id === menu.tabId) : undefined;
  const menuIndex = menuTab ? tabs.findIndex((t) => t.id === menuTab.id) : -1;

  return (
    <div className={`tab-bar${isTauriAvailable() && isMacPlatform() ? " has-traffic-lights" : ""}`}>
      <div
        ref={containerRef}
        className={`tabs-container${dragId ? " dragging" : ""}`}
        role="tablist"
        aria-label="Terminal sessions"
      >
        {tabs.map((tab, index) => {
          const isActive = tab.id === activeTabId;
          const isEditing = editingTabId === tab.id;
          const isDragging = dragId === tab.id;
          return (
            <div key={tab.id} style={{ display: "contents" }}>
              {dragId && dropIndex === index && (
                <div className="tab-drop-indicator" aria-hidden="true" />
              )}
              <div
                data-tab-id={tab.id}
                role="tab"
                aria-selected={isActive}
                aria-label={`${tab.title}, ${tab.status}`}
                tabIndex={isActive ? 0 : -1}
                className={`tab-item ${isActive ? "active" : ""} status-${tab.status}${
                  tab.color ? " has-color" : ""
                }${isDragging ? " dragging" : ""}`}
                style={tab.color ? ({ "--tab-color": tab.color } as CSSProperties) : undefined}
                onPointerDown={(e) => beginPotentialDrag(e, tab)}
                onContextMenu={(e) => openMenu(e, tab)}
                onClick={() => handleTabClick(tab.id)}
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
                      // The tab's own handler treats Space/arrows/Home/End as
                      // tab navigation and preventDefault()s them, which would
                      // block typing spaces and moving the caret in this field.
                      e.stopPropagation();
                      if (e.key === "Enter") {
                        finishEditing(tab.id);
                      } else if (e.key === "Escape") {
                        setEditingTabId(null);
                      }
                    }}
                    onClick={(e) => e.stopPropagation()}
                    onPointerDown={(e) => e.stopPropagation()}
                    aria-label="Tab title"
                  />
                ) : (
                  <span
                    className="tab-title"
                    onDoubleClick={(e) => {
                      e.stopPropagation();
                      startEditing(tab);
                    }}
                    title="Drag to reorder — double-click or right-click to rename"
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
                    onPointerDown={(e) => e.stopPropagation()}
                    title="Close Session"
                    aria-label={`Close ${tab.title}`}
                  >
                    <X size={12} />
                  </button>
                )}
              </div>
            </div>
          );
        })}
        {dragId && dropIndex === tabs.length && (
          <div className="tab-drop-indicator" aria-hidden="true" />
        )}
      </div>

      {/* Outside the scrolling tab list so the shell menu is never clipped. */}
      <div className="tab-add-group">
        <button
          type="button"
          className="tab-add-btn"
          onClick={onNewTab}
          title="New Tab (Ctrl+T / Cmd+T — works on Windows, Linux and macOS)"
          aria-label="New terminal tab"
        >
          <Plus size={16} />
        </button>
        {onNewTabWithShell && shells.length > 0 && (
          <PopupMenu
            label="New tab with shell"
            entries={shellEntries}
            trigger={({ toggle, props }) => (
              <button
                type="button"
                className="tab-add-btn tab-add-chevron"
                onClick={toggle}
                title="Choose a shell for the new tab"
                aria-label="Choose shell for new tab"
                {...props}
              >
                <ChevronDown size={12} />
              </button>
            )}
          />
        )}
      </div>

      {/* Empty strip that moves the window (and maximizes on double-click). */}
      <div className="tab-bar-drag" data-tauri-drag-region />
      {children}
      <WindowControls />

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
            Rename session
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
