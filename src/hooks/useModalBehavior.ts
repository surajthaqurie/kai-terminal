import { useEffect, useRef } from "react";
import { useLatest } from "./useLatest";

/** Open modals, innermost last: only the top one reacts to Escape and Tab. */
const openModals: symbol[] = [];

/** True while any dialog using {@link useModalBehavior} is open (it owns Escape). */
export const hasOpenModal = (): boolean => openModals.length > 0;

/** A control that is using Escape itself right now (cancel recording, cancel rename). */
export const ESCAPE_OWNER_ATTR = "data-modal-escape-own";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusableIn(dialog: HTMLElement): HTMLElement[] {
  return [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => !el.hidden && el.getAttribute("aria-hidden") !== "true"
  );
}

/**
 * Keyboard behaviour every dialog shares, so none of them is a keyboard trap
 * that leaves typing going to the shell behind the backdrop:
 *
 * - focus moves into the dialog when it opens (unless a control inside already
 *   took it, e.g. an autofocused input) and returns to where it was on close,
 *   normally the terminal, so typing continues without a click;
 * - Escape closes the topmost dialog, unless a control inside is using Escape
 *   itself ({@link ESCAPE_OWNER_ATTR});
 * - Tab stays inside the dialog.
 *
 * The Escape listener runs in the capture phase and stops the event, so one
 * press closes ONE thing: other Escape handlers (the music player) never see it.
 * Attach the returned ref to the dialog panel (it gets `tabIndex={-1}`).
 */
export function useModalBehavior<T extends HTMLElement = HTMLDivElement>(
  isOpen: boolean,
  onClose: () => void
) {
  const dialogRef = useRef<T>(null);
  const onCloseRef = useLatest(onClose);

  useEffect(() => {
    if (!isOpen) return;
    const token = Symbol("modal");
    openModals.push(token);
    const dialog = dialogRef.current;
    const returnFocusTo =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    if (dialog && !dialog.contains(document.activeElement)) {
      dialog.tabIndex = -1;
      dialog.focus({ preventScroll: true });
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (openModals[openModals.length - 1] !== token) return;
      if (e.key === "Escape") {
        if (e.defaultPrevented) return;
        const owner = e.target instanceof Element && e.target.closest(`[${ESCAPE_OWNER_ATTR}]`);
        if (owner) return;
        e.preventDefault();
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key === "Tab" && dialog) {
        const items = focusableIn(dialog);
        if (items.length === 0) {
          e.preventDefault();
          return;
        }
        const first = items[0];
        const last = items[items.length - 1];
        const active = document.activeElement;
        if (e.shiftKey && (active === first || active === dialog)) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        } else if (!dialog.contains(active)) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown, true);

    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      const at = openModals.indexOf(token);
      if (at >= 0) openModals.splice(at, 1);
      if (returnFocusTo?.isConnected) returnFocusTo.focus({ preventScroll: true });
    };
  }, [isOpen, onCloseRef]);

  return dialogRef;
}
