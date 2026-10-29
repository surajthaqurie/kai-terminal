import { useCallback, useEffect, useState } from "react";
import { ModeDisplay, resolveModeDisplay } from "../services/projectService";
import { useLatest } from "./useLatest";

interface CodeModeOptions {
  /** The pane whose terminal the footer describes. */
  activePaneId: string | undefined;
  /** A second `kai <path>` launch asked this window to show `dir`. */
  onOpenProject: (dir: string) => void;
}

/**
 * Code Mode is a property of one TERMINAL, not of the app: it is on for the
 * pane whose shell is running a `kai <agent>` and nowhere else. The CLI
 * announces start/end on that pane's own output stream (see
 * `core/codeModeSignal`; TerminalView forwards it per pane), so the footer
 * simply shows the active pane's entry — switching tab or split switches the
 * pill, a second tab stays a plain terminal, and nothing is polled or read
 * from disk.
 */
export function useCodeMode({ activePaneId, onOpenProject }: CodeModeOptions) {
  const onOpenProjectRef = useLatest(onOpenProject);
  const [projectByPane, setProjectByPane] = useState<Record<string, string>>({});

  /** Record (`project`) or drop (`null`) one pane's Code Mode. Equality-guarded: no idle re-renders. */
  const setPaneCodeMode = useCallback((paneId: string, project: string | null) => {
    setProjectByPane((prev) => {
      if (project === null) {
        if (!(paneId in prev)) return prev;
        const next = { ...prev };
        delete next[paneId];
        return next;
      }
      return prev[paneId] === project ? prev : { ...prev, [paneId]: project };
    });
  }, []);

  useEffect(() => {
    // Single-instance second launch (all OSes): the Rust backend focuses
    // this window instead of opening a duplicate ("ghost") window and
    // emits `kai-open-project`. When the event carries a path (`kai <path>`
    // while running), surface it: focus a tab already there, or open one —
    // otherwise the request is silently swallowed and the user thinks the
    // launch did nothing.
    let unlistenSingle: (() => void) | undefined;
    let cancelled = false;
    void import("@tauri-apps/api/event")
      .then(({ listen }) => {
        if (cancelled) return;
        void listen("kai-open-project", (event) => {
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
        // Browser/mock mode: there is no second-launch event to hear.
      });
    return () => {
      cancelled = true;
      if (unlistenSingle) unlistenSingle();
    };
  }, [onOpenProjectRef]);

  const codeModeProject = activePaneId ? (projectByPane[activePaneId] ?? null) : null;
  const modeDisplay: ModeDisplay = resolveModeDisplay(codeModeProject);

  /** Footer pill click: leave Code Mode for the active terminal only. */
  const exitCodeMode = useCallback(() => {
    if (activePaneId) setPaneCodeMode(activePaneId, null);
  }, [activePaneId, setPaneCodeMode]);

  return { setPaneCodeMode, modeDisplay, exitCodeMode };
}
