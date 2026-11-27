/**
 * Moving a tab, with its running shells, into a new window.
 *
 * The shells are not restarted. Each one stays a session in the backend; the new
 * window attaches to it and redraws the screen from a snapshot the old window took.
 * The order matters so no output is lost or shown twice:
 *
 *  1. `begin`   the backend starts holding the sessions' output;
 *  2. `settle`  output already on its way to this window arrives;
 *  3. `capture` each terminal is flushed and serialized (its screen is now complete);
 *  4. `open`    the new window is created with the snapshots;
 *  5. `release` this window lets go of the sessions (it must not close them).
 *
 * The new window then collects what was held (`finish`) and carries on live. If
 * step 4 fails, `finish` hands the held output back here and nothing is lost.
 */
import type { TerminalPane, TerminalTab } from "../types/terminal";
import { newTabId } from "./tabFactory";
import {
  handoffBegin,
  handoffFinish,
  openTerminalWindow,
  sendTabToWindow,
  type HandoffRelease,
  type PaneSeed,
  type TabSeed,
} from "./terminalWindows";

/** A terminal's screen as it is handed over. */
export interface PaneCapture {
  ptyId: string;
  snapshot: string;
  cols: number;
  rows: number;
}

/** What the old window needs from a terminal to move it (`TerminalViewRef` has all of it). */
export interface HandoffTerminal {
  /** Backend session id of the running shell, or null when there is none. */
  handoffSessionId(): string | null;
  /** Flushes pending output and serializes the screen; null if it cannot. */
  handoffCapture(): Promise<PaneCapture | null>;
  /** Lets go of the session without closing it. */
  handoffRelease(): void;
  /** Writes output that was held during a move that did not happen. */
  handoffResume(released: HandoffRelease): void;
}

export interface HandoffDeps {
  begin(ids: string[]): Promise<void>;
  finish(id: string): Promise<HandoffRelease>;
  open(seed: TabSeed, adopt: string[], at?: { x: number; y: number }): Promise<string>;
  /** Hands the tab to a window that is already open (merging it back). */
  send?: (target: string, seed: TabSeed, adopt: string[]) => Promise<void>;
  /** Waits for output the backend already emitted to reach this window. */
  settle(): Promise<void>;
}

/** Time for events emitted just before `begin` to be delivered (they travel separately from replies). */
const SETTLE_MS = 60;

const defaultDeps: HandoffDeps = {
  begin: handoffBegin,
  finish: handoffFinish,
  open: (seed, adopt, at) => openTerminalWindow({ seed, adopt, at }),
  send: sendTabToWindow,
  settle: () => new Promise((resolve) => setTimeout(resolve, SETTLE_MS)),
};

export type DetachResult = { ok: true; windowLabel: string } | { ok: false; reason: string };

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** The seed a new window needs to rebuild `tab`; panes with a capture keep their running shell. */
export function buildTabSeed(tab: TerminalTab, captures: Map<string, PaneCapture>): TabSeed {
  const panes: PaneSeed[] = tab.panes.map((pane) => {
    const capture = captures.get(pane.id);
    return {
      id: pane.id,
      shellPath: pane.shellPath ?? tab.shellPath,
      cwd: pane.cwd ?? tab.cwd,
      adopt: capture ? { ...capture } : undefined,
    };
  });
  return {
    title: tab.title,
    color: tab.color,
    shellPath: tab.shellPath,
    cwd: tab.cwd,
    splitDirection: tab.splitDirection,
    layout: tab.layout,
    activePaneId: tab.activePaneId,
    panes,
  };
}

/** Rebuilds the tab in the new window. Panes without a running shell start a fresh one. */
export function tabFromSeed(seed: TabSeed): TerminalTab {
  const panes: TerminalPane[] = seed.panes.map((p) => ({
    id: p.id,
    shellPath: p.shellPath,
    cwd: p.cwd,
    status: "connecting",
    adopt: p.adopt,
  }));
  const active = panes.some((p) => p.id === seed.activePaneId)
    ? seed.activePaneId
    : (panes[0]?.id ?? "");
  return {
    id: newTabId(),
    title: seed.title,
    color: seed.color,
    shellPath: seed.shellPath,
    cwd: seed.cwd,
    status: "connecting",
    panes,
    activePaneId: active,
    splitDirection: seed.splitDirection,
    layout: seed.layout,
  };
}

/**
 * Moves `tab` to a new window, shells and all. On failure the tab is left exactly
 * as it was (output that was held is written back into its terminals).
 */
export async function detachTab(
  tab: TerminalTab,
  terminals: Record<string, HandoffTerminal | null | undefined>,
  at?: { x: number; y: number },
  deps: HandoffDeps = defaultDeps
): Promise<DetachResult> {
  return handOver(
    tab,
    terminals,
    deps,
    (seed, adopt) => deps.open(seed, adopt, at),
    "Could not open a new window"
  );
}

/**
 * Moves `tab` into another window that is already open (merging windows back
 * together), shells and all. On failure the tab is left exactly as it was.
 */
export async function moveTabToWindow(
  tab: TerminalTab,
  terminals: Record<string, HandoffTerminal | null | undefined>,
  target: string,
  deps: HandoffDeps = defaultDeps
): Promise<DetachResult> {
  const send = deps.send;
  if (!send) return { ok: false, reason: "Moving tabs between windows is not available." };
  return handOver(
    tab,
    terminals,
    deps,
    async (seed, adopt) => {
      await send(target, seed, adopt);
      return target;
    },
    "Could not move the tab to that window"
  );
}

/** The shared hand-over: hold output, snapshot, deliver, then let go (or roll back). */
async function handOver(
  tab: TerminalTab,
  terminals: Record<string, HandoffTerminal | null | undefined>,
  deps: HandoffDeps,
  deliver: (seed: TabSeed, adopt: string[]) => Promise<string>,
  failure: string
): Promise<DetachResult> {
  // Panes whose shell is running right now; the others simply start fresh over there.
  const live = tab.panes.flatMap((pane) => {
    const term = terminals[pane.id];
    const id = term?.handoffSessionId() ?? null;
    return term && id ? [{ pane, term, id }] : [];
  });

  const held: typeof live = [];
  const captures = new Map<string, PaneCapture>();
  /** Gives back what was held so far to the terminals that keep running here. */
  const resumeHere = async (items: typeof live) => {
    for (const { term, id } of items) {
      try {
        term.handoffResume(await deps.finish(id));
      } catch {
        // The session is gone; nothing to resume.
      }
    }
  };

  if (live.length > 0) {
    try {
      await deps.begin(live.map((l) => l.id));
    } catch (err) {
      return { ok: false, reason: `Could not move the tab: ${message(err)}` };
    }
    held.push(...live);
    await deps.settle();
    for (const item of live) {
      const capture = await item.term.handoffCapture().catch(() => null);
      if (capture) {
        captures.set(item.pane.id, capture);
      } else {
        // Ended in the meantime: free it and let the pane restart over there.
        await resumeHere([item]);
        held.splice(held.indexOf(item), 1);
      }
    }
  }

  try {
    const windowLabel = await deliver(
      buildTabSeed(tab, captures),
      held.map((h) => h.id)
    );
    // The other window owns the shells now: this one must not close them.
    for (const { term } of held) term.handoffRelease();
    return { ok: true, windowLabel };
  } catch (err) {
    await resumeHere(held);
    return { ok: false, reason: `${failure}: ${message(err)}` };
  }
}
