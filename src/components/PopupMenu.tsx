import {
  CSSProperties,
  FC,
  KeyboardEvent as ReactKeyboardEvent,
  ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

export type MenuEntry =
  | {
      kind?: "item";
      id: string;
      label: string;
      /** Secondary line under the label (e.g. an executable path). */
      detail?: string;
      /** Right-aligned hint, usually a keyboard shortcut. */
      hint?: string;
      icon?: ReactNode;
      /** Inline style for the label only (e.g. preview a font in its own face). */
      labelStyle?: CSSProperties;
      /** Renders a check mark; use for the current choice in a single-select list. */
      checked?: boolean;
      tone?: "warn" | "danger";
      onSelect: () => void;
    }
  | { kind: "heading"; id: string; label: string }
  | { kind: "separator"; id: string };

interface TriggerState {
  open: boolean;
  toggle: () => void;
  /** Spread onto the trigger button. */
  props: {
    "aria-haspopup": "menu";
    "aria-expanded": boolean;
    "aria-controls": string | undefined;
    onKeyDown: (e: ReactKeyboardEvent<HTMLElement>) => void;
  };
}

interface PopupMenuProps {
  /** Accessible name of the menu itself. */
  label: string;
  entries: MenuEntry[];
  trigger: (state: TriggerState) => ReactNode;
  /** Which edge of the trigger the menu lines up with. */
  align?: "start" | "end";
  /** Open below the trigger (default) or above it, for triggers at the bottom of the window. */
  side?: "down" | "up";
  /** Called each time the menu opens (e.g. to refresh a lazily loaded list). */
  onOpen?: () => void;
  className?: string;
  /** Extra class on the open menu itself (width / scrolling overrides). */
  menuClassName?: string;
}

/**
 * Small accessible dropdown: opens under its trigger, closes on Escape,
 * outside click, or after a choice, and gives focus back to the trigger.
 * Arrow keys, Home and End move between items; ArrowDown on the trigger
 * opens it. Used by the new-tab shell picker and the header "more" menu.
 */
export const PopupMenu: FC<PopupMenuProps> = ({
  label,
  entries,
  trigger,
  align = "start",
  side = "down",
  onOpen,
  className,
  menuClassName,
}) => {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  const items = useCallback(
    () => Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? []),
    []
  );

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) {
      wrapRef.current?.querySelector<HTMLElement>("[aria-haspopup]")?.focus();
    }
  }, []);

  const toggle = useCallback(() => {
    setOpen((v) => {
      if (!v) onOpen?.();
      return !v;
    });
  }, [onOpen]);

  useEffect(() => {
    if (!open) return;
    items()[0]?.focus();
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) close(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open, close, items]);

  const onMenuKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const list = items();
    const at = list.indexOf(document.activeElement as HTMLElement);
    let next = -1;
    if (e.key === "ArrowDown") next = (at + 1) % list.length;
    else if (e.key === "ArrowUp") next = (at - 1 + list.length) % list.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = list.length - 1;
    else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close(true);
      return;
    } else if (e.key === "Tab") {
      close(false);
      return;
    }
    if (next >= 0) {
      e.preventDefault();
      list[next]?.focus();
    }
  };

  return (
    <div ref={wrapRef} className={`popup-menu-wrap${className ? ` ${className}` : ""}`}>
      {trigger({
        open,
        toggle,
        props: {
          "aria-haspopup": "menu",
          "aria-expanded": open,
          "aria-controls": open ? menuId : undefined,
          onKeyDown: (e) => {
            if (e.key === "ArrowDown" && !open) {
              e.preventDefault();
              toggle();
            }
          },
        },
      })}
      {open && (
        <div
          ref={menuRef}
          id={menuId}
          className={`popup-menu popup-menu-${align}${side === "up" ? " popup-menu-up" : ""}${
            menuClassName ? ` ${menuClassName}` : ""
          }`}
          role="menu"
          aria-label={label}
          onKeyDown={onMenuKeyDown}
        >
          {entries.map((entry) => {
            if (entry.kind === "separator") {
              return <div key={entry.id} className="popup-menu-sep" role="separator" />;
            }
            if (entry.kind === "heading") {
              return (
                <div key={entry.id} className="popup-menu-heading" role="presentation">
                  {entry.label}
                </div>
              );
            }
            const selectable = entry.checked !== undefined;
            return (
              <button
                key={entry.id}
                type="button"
                role={selectable ? "menuitemradio" : "menuitem"}
                aria-checked={selectable ? entry.checked : undefined}
                className={`popup-menu-item${entry.tone ? ` tone-${entry.tone}` : ""}`}
                title={entry.detail}
                onClick={() => {
                  close(false);
                  entry.onSelect();
                }}
              >
                {selectable && (
                  <span className="popup-menu-check" aria-hidden="true">
                    {entry.checked ? "✓" : ""}
                  </span>
                )}
                {entry.icon && (
                  <span className="popup-menu-icon" aria-hidden="true">
                    {entry.icon}
                  </span>
                )}
                <span className="popup-menu-text">
                  <span className="popup-menu-label" style={entry.labelStyle}>
                    {entry.label}
                  </span>
                  {entry.detail && <span className="popup-menu-detail">{entry.detail}</span>}
                </span>
                {entry.hint && <span className="popup-menu-hint">{entry.hint}</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};
