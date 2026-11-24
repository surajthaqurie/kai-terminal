import { useEffect, useRef, useState } from "react";
import { isTauriAvailable } from "../services/ptyService";

/** Event the Rust call watcher emits when a call starts or ends. */
export const CALL_STATE_EVENT = "kai-call-state";

/**
 * Pauses playback while the OS reports a call (another app recording from
 * the microphone) and resumes it afterwards. No setting gates this: it is
 * automatic whenever the player is actually playing — and only this hook's
 * own pause is undone on call end, so music the user had already paused
 * stays paused.
 *
 * The backend polls the OS for calls (a process every few seconds) ONLY while this
 * hook needs it: while the player is playing, or while it is paused by a call and
 * waiting for that call to end. Otherwise nothing is polled.
 */
// One import shared by every call below (three effects ask for it on mount).
let corePromise: Promise<typeof import("@tauri-apps/api/core")> | null = null;
const loadCore = () => (corePromise ??= import("@tauri-apps/api/core"));

export function shouldWatchCalls(playing: boolean, pausedByCall: boolean): boolean {
  return playing || pausedByCall;
}

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
  const [pausedByCall, setPausedByCall] = useState(false);

  // The user took over during the call (pressed Play): the call no longer owns
  // the player's state, so its end must not "resume" over what they chose.
  useEffect(() => {
    if (playing) {
      pausedByCallRef.current = false;
      setPausedByCall(false);
    }
  }, [playing]);

  // Tell the backend whether it has to look for calls right now.
  const watch = shouldWatchCalls(playing, pausedByCall);
  useEffect(() => {
    if (!isTauriAvailable()) return;
    void loadCore()
      .then(({ invoke }) => invoke("call_watch_set_enabled", { enabled: watch }))
      .catch(() => {});
  }, [watch]);
  // Never leave it polling after the player is gone.
  useEffect(() => {
    if (!isTauriAvailable()) return;
    return () => {
      void loadCore()
        .then(({ invoke }) => invoke("call_watch_set_enabled", { enabled: false }))
        .catch(() => {});
    };
  }, []);

  useEffect(() => {
    if (!isTauriAvailable()) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;

    const onCallState = (active: boolean) => {
      if (active) {
        if (!playingRef.current || pausedByCallRef.current) return;
        pausedByCallRef.current = true;
        setPausedByCall(true);
        actionsRef.current.pause();
      } else if (pausedByCallRef.current) {
        pausedByCallRef.current = false;
        setPausedByCall(false);
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
    void loadCore()
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
