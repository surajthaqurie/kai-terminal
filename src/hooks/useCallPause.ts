import { useEffect, useRef } from "react";
import { isTauriAvailable } from "../services/ptyService";

/** Event the Rust call watcher emits when a call starts or ends. */
export const CALL_STATE_EVENT = "kai-call-state";

/**
 * Pauses playback while the OS reports a call (another app recording from
 * the microphone) and resumes it afterwards. No setting gates this: it is
 * automatic whenever the player is actually playing — and only this hook's
 * own pause is undone on call end, so music the user had already paused
 * stays paused.
 */
export function useCallPause({
  playing,
  pause,
  resume,
}: {
  playing: boolean;
  pause: () => void;
  resume: () => void;
}) {
  const playingRef = useRef(playing);
  playingRef.current = playing;
  const actionsRef = useRef({ pause, resume });
  actionsRef.current = { pause, resume };
  const pausedByCallRef = useRef(false);

  useEffect(() => {
    if (!isTauriAvailable()) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;

    const onCallState = (active: boolean) => {
      if (active) {
        if (!playingRef.current || pausedByCallRef.current) return;
        pausedByCallRef.current = true;
        actionsRef.current.pause();
      } else if (pausedByCallRef.current) {
        pausedByCallRef.current = false;
        actionsRef.current.resume();
      }
    };

    void import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen<{ active?: boolean }>(CALL_STATE_EVENT, (event) =>
          onCallState(Boolean(event.payload?.active))
        )
      )
      .then((u) => {
        if (cancelled) u();
        else unlisten = u;
      })
      .catch(() => {});

    // A call already running when the player mounts would never fire an event.
    void import("@tauri-apps/api/core")
      .then(({ invoke }) => invoke<boolean>("is_call_active_cmd"))
      .then((active) => {
        if (!cancelled && active) onCallState(true);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);
}
