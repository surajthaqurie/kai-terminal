import { MAX_PANES_PER_TAB } from "./paneLayout";
import {
  PersistedTabV2,
  nodeToPersistedLayout,
  persistedLayoutToNode,
  sanitizeTab,
} from "./workspaces";
import type {
  PaneLayoutNode,
  PaneSplitDirection,
  TerminalPane,
  TerminalTab,
} from "../types/terminal";

export const LAYOUT_KEY = "terminal_tab_layout_v1";

/** Most tabs ever written to / read from the saved layout. */
const MAX_PERSISTED_TABS = 10;

let tabSeq = 0;

/** Collision-safe tab id (frontend-only; distinct from backend PTY UUIDs). */
export function newTabId(): string {
  tabSeq += 1;
  let rand = "";
  try {
    rand =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID().slice(0, 8)
        : Math.floor(Math.random() * 0xffffffff).toString(16);
  } catch {
    rand = Math.floor(Math.random() * 0xffffffff).toString(16);
  }
  return `session-${Date.now()}-${tabSeq}-${rand}`;
}

export interface PersistedTab {
  title: string;
  color?: string;
  shellPath?: string;
  cwd?: string;
  splitDirection?: PersistedTabV2["splitDirection"];
  panes?: Array<{ shellPath?: string; cwd?: string }>;
  layout?: PersistedTabV2["layout"];
}

export function loadPersistedLayout(): PersistedTab[] | null {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    // Only restore titles/cwd/shellPath/pane structure — never command history.
    // Tolerant: accepts v1 tabs and v2 tabs with panes (see workspaces.ts).
    return parsed
      .filter((t) => typeof t === "object" && t !== null)
      .slice(0, MAX_PERSISTED_TABS)
      .map((t) => sanitizeTab(t))
      .filter((t): t is PersistedTabV2 => t !== null)
      .map((t) => ({
        title: t.title,
        color: t.color,
        shellPath: t.shellPath,
        cwd: t.cwd,
        splitDirection: t.splitDirection,
        panes: t.panes,
        layout: t.layout,
      }));
  } catch {
    return null;
  }
}

/** Safe UI layout only (titles, color, cwd, pane structure) — never history. */
export function savePersistedLayout(tabs: TerminalTab[]): void {
  try {
    const safe: PersistedTab[] = tabs.slice(0, MAX_PERSISTED_TABS).map((t) => {
      const paneIds = t.panes.map((p) => p.id);
      return {
        title: t.title,
        color: t.color,
        shellPath: t.shellPath,
        cwd: t.cwd,
        splitDirection: t.splitDirection,
        panes:
          t.panes.length > 1
            ? t.panes.map((p) => ({ shellPath: p.shellPath, cwd: p.cwd }))
            : undefined,
        layout:
          t.layout && t.panes.length > 1 ? nodeToPersistedLayout(t.layout, paneIds) : undefined,
      };
    });
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(safe));
  } catch {
    // ignore quota errors
  }
}

export function createDefaultTab(
  title: string,
  shellPath?: string,
  cwd?: string,
  persisted?: PersistedTab
): TerminalTab {
  const tabId = newTabId();
  const panes: TerminalPane[] =
    persisted?.panes && persisted.panes.length > 1
      ? persisted.panes.slice(0, MAX_PANES_PER_TAB).map((p, i) => ({
          id: `${tabId}-p${i + 1}`,
          shellPath: p.shellPath ?? shellPath,
          cwd: p.cwd ?? cwd,
          status: "connecting" as const,
        }))
      : [
          {
            id: `${tabId}-p1`,
            shellPath,
            cwd,
            status: "connecting" as const,
          },
        ];
  const splitDirection = panes.length > 1 ? (persisted?.splitDirection ?? "vertical") : "none";
  const paneIds = panes.map((p) => p.id);
  // Restore the nested split tree when refs are valid; otherwise fall back
  // to the legacy flat chain so old sessions still render.
  const restoredLayout = persisted?.layout
    ? persistedLayoutToNode(persisted.layout, paneIds)
    : undefined;
  let fullLayout: PaneLayoutNode | undefined = restoredLayout;
  if (!fullLayout) {
    if (paneIds.length <= 1) {
      fullLayout = { kind: "pane", paneId: paneIds[0] };
    } else {
      const axis = (
        splitDirection === "horizontal" ? "horizontal" : "vertical"
      ) as PaneSplitDirection;
      let node: PaneLayoutNode = { kind: "pane", paneId: paneIds[0] };
      for (const id of paneIds.slice(1)) {
        node = {
          kind: "split",
          id: `restored-${tabId}-${id}`,
          direction: axis,
          ratio: 0.5,
          first: node,
          second: { kind: "pane", paneId: id },
        };
      }
      fullLayout = node;
    }
  }
  return {
    id: tabId,
    title,
    color: persisted?.color,
    shellPath,
    cwd,
    status: "connecting",
    panes,
    activePaneId: panes[0].id,
    splitDirection,
    layout: fullLayout,
  };
}
