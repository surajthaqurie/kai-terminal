import { useCallback, useEffect, useState } from "react";
import {
  ModeDisplay,
  clearActiveProject,
  getActiveProject,
  getActiveProjectState,
  resolveModeDisplay,
} from "../services/projectService";
import { useLatest } from "./useLatest";

/** Visible-only poll for external `kai code .` runs while Kai stays on screen. */
const CODE_MODE_POLL_MS = 4000;

interface CodeModeOptions {
  /** A second `kai <path>` launch asked this window to show `dir`. */
  onOpenProject: (dir: string) => void;
}

/**
 * Code Mode footer state: driven ONLY by the persisted active project
 * (`kai code <path>` sets it, `kai stop code` clears it). The backend reads
 * `~/.kai/active_project.json` only (never the launch env, which cannot be
 * cleared), so dev and release builds agree. Recent folders / new tabs never activate Code Mode.
 *
 * The footer pill is STICKY (see resolveModeDisplay): it shows "Code Mode"
 * while a persisted project exists and "Terminal" the moment it is cleared
 * — pane directory reports never flip it on their own.
 */
export function useCodeMode({ onOpenProject }: CodeModeOptions) {
  const onOpenProjectRef = useLatest(onOpenProject);
  const [codeModeProject, setCodeModeProject] = useState<string | null>(() => {
    try {
      return getActiveProject();
    } catch {
      return null;
    }
  });

  // Cheap file-read IPC (no spawns), safe to call from focus, visibility,
  // footer-refresh, and every submitted command line. The command hook is
  // what picks up `kai code .` / `kai stop code` typed into Kai's OWN tab —
  // no focus change happens then, so focus polling alone leaves the badge
  // stale. Still skips while hidden so background polls never compete with
  // the foreground app.
  const syncCodeModeState = useCallback(() => {
    if (typeof document !== "undefined" && document.hidden) return;
    // Authoritative async state (backend state file, then explicit
    // localStorage). Never resolves recent history to code. Equality-guarded
    // so idle syncs never re-render the footer (flicker fix).
    void getActiveProjectState().then((s) => {
      const next = s.mode === "code" ? s.path : null;
      setCodeModeProject((prev) => (prev === next ? prev : next));
    });
  }, []);

  useEffect(() => {
    syncCodeModeState();
    // No background interval: polling every 2 s kept IPC + backend file
    // reads awake while Kai sat behind other apps. Focus + visibility +
    // per-command hooks cover every transition that matters (external
    // `kai code` runs, minimize/restore, in-tab CLI runs).
    const onVisible = () => {
      if (!document.hidden) syncCodeModeState();
    };
    window.addEventListener("focus", syncCodeModeState);
    document.addEventListener("visibilitychange", onVisible);
    // Single-instance second launch (all OSes): the Rust backend focuses
    // this window instead of opening a duplicate ("ghost") window and
    // emits `kai-open-project`. Re-sync immediately — window focus alone
    // may not fire when this window was already focused. When the event
    // carries a path (`kai <path>` while running), surface it: focus a tab
    // already there, or open one — otherwise the request is silently
    // swallowed and the user thinks the launch did nothing.
    let unlistenSingle: (() => void) | undefined;
    let cancelled = false;
    void import("@tauri-apps/api/event")
      .then(({ listen }) => {
        if (cancelled) return;
        void listen("kai-open-project", (event) => {
          syncCodeModeState();
          const rawPath =
            event && typeof event === "object" && "payload" in event
              ? (event as { payload?: unknown }).payload
              : null;
          const candidate =
            rawPath && typeof rawPath === "object" && rawPath !== null
              ? (rawPath as Record<string, unknown>).path
              : null;
          if (typeof candidate === "string" && candidate.trim()) {
            onOpenProjectRef.current(candidate.trim());
          }
        }).then((u) => {
          if (cancelled) {
            u();
          } else {
            unlistenSingle = u;
          }
        });
      })
      .catch(() => {
        // Browser/mock mode: focus + visibility listeners above suffice.
      });
    return () => {
      cancelled = true;
      window.removeEventListener("focus", syncCodeModeState);
      document.removeEventListener("visibilitychange", onVisible);
      if (unlistenSingle) unlistenSingle();
    };
  }, [syncCodeModeState, onOpenProjectRef]);

  // Real-time Code Mode for EXTERNAL `kai code .` runs while Kai stays
  // visible (side-by-side terminal, no focus change to observe). Skipped
  // while hidden so background polls never compete with the foreground app.
  useEffect(() => {
    const timer = setInterval(syncCodeModeState, CODE_MODE_POLL_MS);
    return () => clearInterval(timer);
  }, [syncCodeModeState]);

  // Sticky footer pill: "Code Mode" while a persisted project exists,
  // "terminal" the moment it is cleared. No per-pane input — directory
  // reports and still-resolving cwds never flip the badge (flicker fix).
  const [modeDisplay, setModeDisplay] = useState<ModeDisplay>(() =>
    codeModeProject ? "code" : "terminal"
  );
  useEffect(() => {
    setModeDisplay((prev) => {
      const next = resolveModeDisplay(codeModeProject);
      return prev === next ? prev : next;
    });
  }, [codeModeProject]);

  const exitCodeMode = useCallback(() => {
    clearActiveProject();
    setCodeModeProject(null);
    setModeDisplay("terminal");
  }, []);

  return { syncCodeModeState, modeDisplay, exitCodeMode };
}
