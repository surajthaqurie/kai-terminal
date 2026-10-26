import { useRef } from "react";

/**
 * Ref that always holds the value from the latest render. Long-lived
 * listeners (Tauri events, timers, pty-exit callbacks) read `.current`
 * instead of closing over a stale snapshot.
 */
export function useLatest<T>(value: T) {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}
