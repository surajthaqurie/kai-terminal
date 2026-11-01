import { useCallback, useEffect, useRef, useState } from "react";

export type NoticeKind = "error" | "info" | "success";

export interface Notice {
  id: number;
  kind: NoticeKind;
  message: string;
}

/** Most toasts on screen at once; the oldest is dropped when a new one arrives. */
export const MAX_VISIBLE_NOTICES = 3;

/**
 * Info and success confirmations fade on their own. Errors stay until the user
 * dismisses them: a failure that vanishes after a few seconds is as good as
 * silent when the user was looking at the terminal.
 */
export const NOTICE_AUTO_DISMISS_MS = 5000;

const autoDismisses = (kind: NoticeKind) => kind !== "error";

/**
 * Transient user-facing messages (toasts): failures of actions that otherwise
 * give no visible feedback, and short confirmations ("up to date").
 *
 * An identical message that is already on screen is not stacked again, so a
 * retry loop cannot bury the UI in copies of one error.
 */
export function useNotices() {
  const [notices, setNotices] = useState<Notice[]>([]);
  const nextId = useRef(1);

  const notify = useCallback((kind: NoticeKind, message: string) => {
    const text = message.trim();
    if (!text) return;
    setNotices((prev) => {
      if (prev.some((n) => n.kind === kind && n.message === text)) return prev;
      const next = [...prev, { id: nextId.current++, kind, message: text }];
      return next.slice(-MAX_VISIBLE_NOTICES);
    });
  }, []);

  const dismiss = useCallback((id: number) => {
    setNotices((prev) => prev.filter((n) => n.id !== id));
  }, []);

  const clear = useCallback(() => setNotices([]), []);

  // One timer per auto-dismissing notice. The effect re-runs when the list
  // changes, so each id is armed once and timers of removed ids are cleared.
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const live = new Set(notices.map((n) => n.id));
    for (const [id, timer] of timers.current) {
      if (!live.has(id)) {
        clearTimeout(timer);
        timers.current.delete(id);
      }
    }
    for (const n of notices) {
      if (!autoDismisses(n.kind) || timers.current.has(n.id)) continue;
      timers.current.set(
        n.id,
        setTimeout(() => dismiss(n.id), NOTICE_AUTO_DISMISS_MS)
      );
    }
  }, [notices, dismiss]);
  useEffect(
    () => () => {
      for (const timer of timers.current.values()) clearTimeout(timer);
      timers.current.clear();
    },
    []
  );

  return { notices, notify, dismiss, clear };
}
