import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import { closeAppWindow } from "../services/appWindow";
import { removePaneById } from "../services/paneLayout";
import { sameShellPath } from "../services/paneShell";
import { createDefaultTab, deriveTabStatus } from "../services/tabFactory";
import { applyTabsUpdate } from "./tabsSync";
import { tabAfterClose } from "../services/tabSelection";
import type { ShellProfile, TerminalTab } from "../types/terminal";

/** Deaths inside this window count toward a crash loop. */
const CRASH_WINDOW_MS = 10_000;
const CRASH_LOOP_THRESHOLD = 3;
/** A failed exit this soon after a tab opens means the shell never really ran. */
const INSTANT_DEATH_MS = 4000;

interface LoopFault {
  tabId: string;
  paneId: string;
  message: string;
}

interface SessionExitOptions {
  tabs: TerminalTab[];
  setTabs: Dispatch<SetStateAction<TerminalTab[]>>;
  setActiveTabId: (id: string) => void;
  tabsRef: MutableRefObject<TerminalTab[]>;
  activeTabIdRef: MutableRefObject<string>;
  shellsRef: MutableRefObject<ShellProfile[]>;
  selectedShellIdRef: MutableRefObject<string>;
  setLastError: (message: string | null) => void;
}

/**
 * Handles shells exiting (user `exit`, crash, kill) and the crash-loop /
 * instant-death guards (all OSes, release included): a shell binary that is
 * missing, not runnable, or exits instantly must never freeze the window in
 * spawn churn, nor silently quit the app a fraction of a second after
 * launch. Rapid exits park the tab in `error` with an actionable banner
 * (Retry / Settings) instead of closing, recycling, or quitting. Timestamps
 * age out, so a healthy shell that stays up never trips the detector.
 */
export function useSessionExit({
  tabs,
  setTabs,
  setActiveTabId,
  tabsRef,
  activeTabIdRef,
  shellsRef,
  selectedShellIdRef,
  setLastError,
}: SessionExitOptions) {
  // Times of recent failed exits of shells that died right after opening. Only those count: a
  // shell that ran for a while and then exited with a failure status (`exit` after a failed
  // command, `wsl --shutdown`) is not a broken shell, however many do it at once (FUNC-09).
  const exitTimesRef = useRef<number[]>([]);
  const tabBornRef = useRef<Record<string, number>>({});
  const [loopFault, setLoopFault] = useState<LoopFault | null>(null);

  // Birth record for every tab (initial, restored, workspace, new) so the
  // last-session exit path can tell "user typed exit" apart from "the
  // shell died 500 ms after launch with a broken binary".
  useEffect(() => {
    const born = tabBornRef.current;
    const now = Date.now();
    for (const t of tabs) {
      if (!(t.id in born)) born[t.id] = now;
    }
  }, [tabs]);

  /**
   * Removes a pane for good: only that pane in a split, the whole tab when it was the tab's last
   * pane, and the window when it was the last pane of the last tab (the browser fallback recycles
   * a fresh tab instead). Reads live refs, so panes created after this callback was memoized are
   * found. Idempotent: an already removed pane is ignored.
   */
  const closePane = useCallback(
    (tabId: string, paneId: string) => {
      const liveTabs = tabsRef.current;
      const targetTab = liveTabs.find((t) => t.id === tabId);
      if (!targetTab || !targetTab.panes.some((p) => p.id === paneId)) return;

      if (targetTab.panes.length > 1) {
        // Single shared removal path (see removePaneById): survivors keep
        // their ids/objects and the tree prunes to exactly the survivors, so
        // the remaining splits stay mounted on every OS: exiting one pane
        // must never refresh (respawn) its neighbors.
        applyTabsUpdate(tabsRef, setTabs, (prev) =>
          prev.map((t) => (t.id === tabId ? { ...t, ...removePaneById(t, paneId) } : t))
        );
        return;
      }

      if (liveTabs.length > 1) {
        // Decide from the live ref and update it in the same step: two shells
        // dying together (`wsl --shutdown`, a mass kill) arrive before React
        // re-renders, and each used to overwrite the other's removal.
        const remainingTabs = liveTabs.filter((t) => t.id !== tabId);
        applyTabsUpdate(tabsRef, setTabs, (prev) => prev.filter((t) => t.id !== tabId));
        if (activeTabIdRef.current === tabId) {
          const nextId = tabAfterClose(liveTabs, tabId) ?? remainingTabs[0].id;
          activeTabIdRef.current = nextId;
          setActiveTabId(nextId);
        }
        return;
      }

      // Last pane of last tab: quit the whole app on desktop (`exit` in the only
      // session closes Kai, like a regular terminal). The browser/mock fallback
      // recycles a fresh tab so the window never ends up empty.
      void closeAppWindow().then((closed) => {
        if (closed) return;
        const selectedShell = shellsRef.current.find((s) => s.id === selectedShellIdRef.current);
        const fresh = createDefaultTab("Terminal 1", selectedShell?.path);
        setTabs([fresh]);
        setActiveTabId(fresh.id);
      });
    },
    [tabsRef, activeTabIdRef, shellsRef, selectedShellIdRef, setTabs, setActiveTabId]
  );

  const handleSessionExit = useCallback(
    (tabId: string, paneId: string, exitCode?: number) => {
      // A clean exit (`exit`, `logout`, Ctrl+D: status 0) closes the pane like a native
      // terminal. A failed one keeps the pane open with its output, the exit code and
      // Restart / Close, so a failure is never invisible (FUNC-09). The backend sends no
      // status (undefined) when it could not read it: that is not a clean exit either.
      // NOTE: reads live refs (not the `tabs` state closure), and repeated `pty-exit`
      // events for an already removed or already exited pane are ignored.
      const liveTabs = tabsRef.current;
      const targetTab = liveTabs.find((t) => t.id === tabId);
      const pane = targetTab?.panes.find((p) => p.id === paneId);
      if (!targetTab || !pane || pane.exited) return;

      // Release-freeze guard (Windows / Linux / macOS): a broken shell
      // binary (missing, not runnable, instantly crashing) fires `pty-exit`
      // immediately after every spawn. 3+ such deaths inside 10 s park the tab
      // in `error` with an actionable banner instead, on every OS.
      const now = Date.now();
      const isCleanExit = exitCode === 0;

      const parkAsFault = (message: string) => {
        exitTimesRef.current = [];
        setLastError(message);
        setLoopFault({ tabId, paneId, message });
        setTabs((prev) =>
          prev.map((t) =>
            t.id === tabId
              ? {
                  ...t,
                  status: "error" as const,
                  errorMessage: message,
                  panes: t.panes.map((p) =>
                    p.id === paneId ? { ...p, status: "error" as const, errorMessage: message } : p
                  ),
                }
              : t
          )
        );
      };

      const bornEarlier = tabBornRef.current[tabId] ?? 0;
      const diedImmediately = bornEarlier > 0 && now - bornEarlier < INSTANT_DEATH_MS;
      if (!isCleanExit && diedImmediately) {
        const recent = exitTimesRef.current.filter((t) => now - t < CRASH_WINDOW_MS);
        recent.push(now);
        exitTimesRef.current = recent;

        if (recent.length >= CRASH_LOOP_THRESHOLD) {
          parkAsFault(
            "Shell keeps exiting immediately (3 times in 10 s). The configured shell binary is " +
              "likely missing or not runnable. Switch this terminal's shell with the shell picker " +
              "in the footer, or press Retry to try it again."
          );
          return;
        }
        // Instant-death exception (all OSes): the only shell of the window died with a
        // failure within 4 s of opening, so it never actually ran (broken binary or bad
        // folder). Keep the window and explain, with Retry and the shell picker.
        if (liveTabs.length === 1 && targetTab.panes.length === 1) {
          parkAsFault(
            "Shell exited right after opening. It likely failed to start (bad shell binary or " +
              "working directory). The window was kept open so you can fix it: switch this " +
              "terminal's shell with the shell picker in the footer, or press Retry to try again."
          );
          return;
        }
      }

      if (!isCleanExit) {
        applyTabsUpdate(tabsRef, setTabs, (prev) =>
          prev.map((t) => {
            if (t.id !== tabId) return t;
            const panes = t.panes.map((p) =>
              p.id === paneId
                ? { ...p, status: "disconnected" as const, exited: { code: exitCode } }
                : p
            );
            return { ...t, panes, ...deriveTabStatus(panes) };
          })
        );
        return;
      }

      closePane(tabId, paneId);
    },
    [tabsRef, setTabs, setLastError, closePane]
  );

  /** Restart on an exited pane: a new shell in the same pane (the split layout is kept). */
  const restartExitedPane = useCallback(
    (tabId: string, paneId: string) => {
      // A restart is a fresh start for the guards: a shell that dies again right away
      // counts as an instant death instead of being judged by the old birth time.
      tabBornRef.current[tabId] = Date.now();
      exitTimesRef.current = [];
      applyTabsUpdate(tabsRef, setTabs, (prev) =>
        prev.map((t) => {
          if (t.id !== tabId) return t;
          const panes = t.panes.map((p) =>
            p.id === paneId && p.exited
              ? {
                  ...p,
                  exited: undefined,
                  status: "connecting" as const,
                  resetKey: (p.resetKey ?? 0) + 1,
                }
              : p
          );
          return { ...t, activePaneId: paneId, panes, ...deriveTabStatus(panes) };
        })
      );
    },
    [tabsRef, setTabs]
  );

  /** Close on an exited pane: removed like any closed pane (its shell has already ended). */
  const closeExitedPane = useCallback(
    (tabId: string, paneId: string) => {
      const pane = tabsRef.current.find((t) => t.id === tabId)?.panes.find((p) => p.id === paneId);
      if (pane?.exited) closePane(tabId, paneId);
    },
    [tabsRef, closePane]
  );

  // Retry after a crash-loop / instant-death fault: re-spawn the same pane
  // in place (resetKey bump keeps the pane id, so split layouts survive).
  // Birth + exit clocks restart so a second instant death parks again
  // instead of quitting or churning.
  const retryFaultedPane = useCallback(() => {
    if (!loopFault) return;
    const { tabId, paneId } = loopFault;
    tabBornRef.current[tabId] = Date.now();
    exitTimesRef.current = [];
    setLastError(null);
    setLoopFault(null);
    // A pane keeps its own recorded shell, so re-spawning "in place" retried the
    // same missing binary forever. When that binary is no longer a detected
    // shell, retry with the current default instead.
    const shells = shellsRef.current;
    const fallbackPath = shells.find((s) => s.id === selectedShellIdRef.current)?.path;
    setTabs((prev) =>
      prev.map((t) => {
        if (t.id !== tabId) return t;
        const panes = t.panes.map((p) => {
          if (p.id !== paneId) return p;
          const missing =
            p.shellPath !== undefined && !shells.some((s) => sameShellPath(s.path, p.shellPath));
          return {
            ...p,
            shellPath: missing && fallbackPath ? fallbackPath : p.shellPath,
            status: "connecting" as const,
            errorMessage: undefined,
            resetKey: (p.resetKey ?? 0) + 1,
          };
        });
        return {
          ...t,
          shellPath: t.panes.length === 1 ? (panes[0].shellPath ?? t.shellPath) : t.shellPath,
          activePaneId: paneId,
          panes,
          ...deriveTabStatus(panes),
        };
      })
    );
  }, [loopFault, setLastError, setTabs, shellsRef, selectedShellIdRef]);

  const dismissFault = useCallback(() => setLoopFault(null), []);

  // The banner describes ONE pane's failure. Drop it once that pane is gone
  // (tab closed, layout replaced by a restore/workspace) or healthy again
  // (shell switched from the footer): otherwise it lingers, and a later Retry
  // press would kill the healthy replacement shell.
  useEffect(() => {
    if (!loopFault) return;
    const pane = tabs
      .find((t) => t.id === loopFault.tabId)
      ?.panes.find((p) => p.id === loopFault.paneId);
    if (!pane || pane.status === "connected") setLoopFault(null);
  }, [tabs, loopFault]);

  /**
   * A terminal was restarted on purpose (shell switch): its birth clock and the
   * crash window start over, so a shell that dies right away parks the tab with
   * the Retry banner instead of silently closing it.
   */
  const markRestarted = useCallback((tabId: string) => {
    tabBornRef.current[tabId] = Date.now();
    exitTimesRef.current = [];
  }, []);

  return {
    loopFault,
    handleSessionExit,
    restartExitedPane,
    closeExitedPane,
    retryFaultedPane,
    dismissFault,
    markRestarted,
  };
}
