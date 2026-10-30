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
import { createDefaultTab } from "../services/tabFactory";
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
  cwdRef: MutableRefObject<string>;
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
  cwdRef,
  setLastError,
}: SessionExitOptions) {
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

  const handleSessionExit = useCallback(
    (tabId: string, paneId: string, exitCode?: number) => {
      // Any shell exit (`exit`, `logout`, Ctrl+D, kill) closes the pane/tab.
      // Previous behavior only closed on exit code 0, which made `exit`
      // appear broken whenever the shell reported a non-zero status.
      // Multi-pane: only the exited pane closes. Multi-tab: only the exited
      // tab closes. Last pane of last tab quits the whole app on desktop
      // (browser fallback recycles a fresh tab).
      // NOTE: reads live refs (not the `tabs` state closure) so exits from
      // tabs/panes created after this callback was memoized still close the
      // correct pane. Idempotent: repeated `pty-exit` events for an already
      // removed pane are ignored, so the Close-pane fallback button in
      // TerminalView can safely re-fire this.
      const liveTabs = tabsRef.current;
      const targetTab = liveTabs.find((t) => t.id === tabId);
      if (!targetTab) return;
      if (targetTab.panes.some((p) => p.id === paneId) === false) return;

      // Release-freeze guard (Windows / Linux / macOS): a broken shell
      // binary (missing, not runnable, instantly crashing) fires `pty-exit`
      // immediately after every spawn. Without this, the app churns through
      // close/recycle/quit in a tight loop and the window looks frozen
      // ("trying to reopen"). 3+ deaths inside 10 s parks the tab in `error`
      // with an actionable banner instead — on every OS.
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

      if (!isCleanExit) {
        const recent = exitTimesRef.current.filter((t) => now - t < CRASH_WINDOW_MS);
        recent.push(now);
        exitTimesRef.current = recent;

        if (recent.length >= CRASH_LOOP_THRESHOLD) {
          parkAsFault(
            "Shell keeps exiting immediately (3 times in 10 s). The configured shell binary is " +
              "likely missing or not runnable. Pick another shell in Settings, then press Retry."
          );
          return;
        }
      }

      if (targetTab.panes.length > 1) {
        // Single shared removal path (see removePaneById): survivors keep
        // their ids/objects and the tree prunes to exactly the survivors, so
        // the remaining splits stay mounted on every OS — exiting one pane
        // must never refresh (respawn) its neighbors.
        setTabs((prev) =>
          prev.map((t) => (t.id === tabId ? { ...t, ...removePaneById(t, paneId) } : t))
        );
        return;
      }

      if (liveTabs.length > 1) {
        const remainingTabs = liveTabs.filter((t) => t.id !== tabId);
        setTabs(remainingTabs);
        if (activeTabIdRef.current === tabId) {
          const targetIdx = liveTabs.findIndex((t) => t.id === tabId);
          const nextIdx = Math.max(0, targetIdx - 1);
          setActiveTabId(remainingTabs[nextIdx]?.id || remainingTabs[0].id);
        }
        return;
      }

      // Last pane of last tab exited: quit the whole app on desktop
      // (`exit` in the only session closes Kai, like a regular terminal).
      // Browser/mock fallback recycles a fresh tab so the window never ends
      // up empty/disconnected.
      // Instant-death exception (all OSes): when the session died with a failure
      // within 4 s of the tab's creation the shell never actually ran (broken binary or
      // bad cwd) — quitting here would make a release launch vanish with no
      // explanation. Clean exits (exitCode === 0) indicate intentional `exit`.
      const bornAt = tabBornRef.current[tabId] ?? 0;
      if (!isCleanExit && bornAt > 0 && now - bornAt < INSTANT_DEATH_MS) {
        parkAsFault(
          "Shell exited right after opening — it likely failed to start (bad shell binary or " +
            "working directory). The window was kept open so you can fix it: pick another shell " +
            "in Settings, then press Retry."
        );
        return;
      }
      void closeAppWindow().then((closed) => {
        if (closed) return;
        const selectedShell = shellsRef.current.find((s) => s.id === selectedShellIdRef.current);
        const fresh = createDefaultTab(
          "Terminal 1",
          selectedShell?.path,
          cwdRef.current.trim() || undefined
        );
        setTabs([fresh]);
        setActiveTabId(fresh.id);
      });
    },
    [
      tabsRef,
      activeTabIdRef,
      shellsRef,
      selectedShellIdRef,
      cwdRef,
      setTabs,
      setActiveTabId,
      setLastError,
    ]
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
    setTabs((prev) =>
      prev.map((t) =>
        t.id === tabId
          ? {
              ...t,
              status: "connecting" as const,
              errorMessage: undefined,
              activePaneId: paneId,
              panes: t.panes.map((p) =>
                p.id === paneId
                  ? {
                      ...p,
                      status: "connecting" as const,
                      errorMessage: undefined,
                      resetKey: (p.resetKey ?? 0) + 1,
                    }
                  : p
              ),
            }
          : t
      )
    );
  }, [loopFault, setLastError, setTabs]);

  const dismissFault = useCallback(() => setLoopFault(null), []);

  /**
   * A terminal was restarted on purpose (shell switch): its birth clock and the
   * crash window start over, so a shell that dies right away parks the tab with
   * the Retry banner instead of silently closing it.
   */
  const markRestarted = useCallback((tabId: string) => {
    tabBornRef.current[tabId] = Date.now();
    exitTimesRef.current = [];
  }, []);

  return { loopFault, handleSessionExit, retryFaultedPane, dismissFault, markRestarted };
}
