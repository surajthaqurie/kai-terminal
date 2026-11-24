import { memo, useMemo, useRef, type MutableRefObject, type ReactNode } from "react";
import {
  PaneRect,
  clampPaneFraction,
  computePaneRects,
  computeSplitDividers,
  resolveTabLayout,
} from "../services/paneLayout";
import type {
  PaneSplitDirection,
  SessionStatus,
  ShellProfile,
  TerminalPane,
  TerminalTab,
  UserSettings,
} from "../types/terminal";
import { resolvePaneShell } from "../services/paneShell";
import { TerminalView, type TerminalViewRef } from "./TerminalView";
import { PaneExitBar } from "./PaneExitBar";

interface TabPanesProps {
  tab: TerminalTab;
  /** Whether this tab is the visible one (hidden tabs stay mounted). */
  isActive: boolean;
  /** App-wide shell: used by panes that have no (or an unknown) shell of their own. */
  selectedShell: ShellProfile | undefined;
  /** Detected shells, to turn a pane's saved binary back into a full profile. */
  shells: ShellProfile[];
  /** False while the shell list is still loading (a new pane waits briefly for it). Default true. */
  shellsReady?: boolean;
  skipShellProfile: boolean;
  settings: UserSettings;
  /** Terminal handles keyed by pane id (toolbar actions, refit). */
  terminalRefs: MutableRefObject<Record<string, TerminalViewRef | null>>;
  onFocusPane: (tabId: string, paneId: string) => void;
  /** Code Mode of one pane (project path) or `null` when it ends. */
  onCodeModeChange: (paneId: string, project: string | null) => void;
  onCwdResolved: (tabId: string, paneId: string, cwd: string) => void;
  onExit: (tabId: string, paneId: string, exitCode?: number) => void;
  /** Restart / Close on a pane whose shell exited with a failure (FUNC-09). */
  onRestartPane: (tabId: string, paneId: string) => void;
  onClosePane: (tabId: string, paneId: string) => void;
  onStatusChange: (tabId: string, paneId: string, status: SessionStatus, message?: string) => void;
  onResizeSplit: (tabId: string, splitId: string, ratio: number) => void;
}

const FULL_RECT: PaneRect = { paneId: "", x: 0, y: 0, w: 1, h: 1 };

const pct = (fraction: number) => `${fraction * 100}%`;

/** Last path segment of a working directory ("C:\\src\\kai" -> "kai"). */
export function folderName(dir: string | undefined): string {
  if (!dir) return "";
  const parts = dir.split(/[/\\]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : dir;
}

/**
 * One tab's pane area, rendered as a flat grid (no-remount splits): the
 * layout tree drives GEOMETRY ONLY. Every live pane renders exactly once as
 * a direct, absolutely-positioned child with a stable key, so splitting,
 * closing, or dragging never reparents a live TerminalView. (The previous
 * nested flexbox tree moved the surviving pane under a brand-new split
 * element on every split, unmounting its xterm, closing its backend PTY, and
 * spawning a fresh shell — "opening a split refreshes the older terminal".)
 *
 * Memoized: re-renders only when this tab (or the shared shell / settings)
 * changes, so footer ticks (music progress, git badge) never touch terminals.
 */
export const TabPanes = memo(function TabPanes({
  tab,
  isActive,
  selectedShell,
  shells,
  shellsReady = true,
  skipShellProfile,
  settings,
  terminalRefs,
  onFocusPane,
  onCodeModeChange,
  onCwdResolved,
  onExit,
  onRestartPane,
  onClosePane,
  onStatusChange,
  onResizeSplit,
}: TabPanesProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  // Geometry depends only on panes / layout / direction. `resolveTabLayout`
  // can synthesize a fallback tree (fresh split ids) for stale layouts, so it
  // is memoized to keep dividers — and therefore live terminals — stable.
  const { rectByPaneId, dividers } = useMemo(() => {
    const layout = resolveTabLayout(
      tab.panes.map((p) => p.id),
      tab.layout,
      tab.splitDirection
    );
    return {
      rectByPaneId: new Map(computePaneRects(layout).map((r) => [r.paneId, r])),
      dividers: computeSplitDividers(layout),
    };
  }, [tab.panes, tab.layout, tab.splitDirection]);

  // Drag-to-resize: per-split ratio (0.2–0.8) stored inside the tab's nested
  // layout tree, so every divider drags along its own axis. Each pane keeps
  // its own TerminalView + ResizeObserver, so dragging resizes the correct
  // backend PTY with real cols/rows (backend clamps).
  const beginSplitDrag = (
    splitId: string,
    direction: PaneSplitDirection,
    startPos: number,
    parentSizePx: number,
    baseRatio: number
  ) => {
    const move = (ev: PointerEvent) => {
      if (parentSizePx <= 0) return;
      // Vertical split = side-by-side (row axis -> width/clientX).
      // Horizontal split = stacked (column axis -> height/clientY).
      const pos = direction === "vertical" ? ev.clientX : ev.clientY;
      onResizeSplit(
        tab.id,
        splitId,
        clampPaneFraction(baseRatio + (pos - startPos) / parentSizePx)
      );
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const isSplit = tab.panes.length > 1;

  const renderPane = (pane: TerminalPane): ReactNode => {
    const rect = rectByPaneId.get(pane.id) ?? FULL_RECT;
    const focusPane = () => onFocusPane(tab.id, pane.id);
    const isActivePane = pane.id === tab.activePaneId;
    const dir = pane.cwd || tab.cwd;
    return (
      <div
        key={pane.id}
        className={`pane-item pane-grid-pane ${isActivePane ? "active-pane" : ""}`}
        style={{
          left: pct(rect.x),
          top: pct(rect.y),
          width: pct(rect.w),
          height: pct(rect.h),
        }}
        // No visible heading: the folder lives in the status bar. Screen readers
        // still get which pane this is and which one has the keyboard.
        role={isSplit ? "group" : undefined}
        aria-label={
          isSplit
            ? `${folderName(dir) || "Terminal"}${isActivePane ? " (active pane)" : ""}`
            : undefined
        }
        onClick={focusPane}
        onPointerDown={focusPane}
      >
        <TerminalView
          ref={(el) => {
            terminalRefs.current[pane.id] = el;
          }}
          sessionId={pane.id}
          selectedShell={resolvePaneShell(pane.shellPath, shells, selectedShell, skipShellProfile)}
          shellsReady={shellsReady}
          cwd={pane.cwd || tab.cwd}
          settings={settings}
          visible={isActive}
          resetKey={pane.resetKey ?? 0}
          adopt={pane.adopt}
          onFocus={focusPane}
          onCodeModeChange={(project) => onCodeModeChange(pane.id, project)}
          onCwdResolved={(resolved) => onCwdResolved(tab.id, pane.id, resolved)}
          onExit={(exitCode) => onExit(tab.id, pane.id, exitCode)}
          onSessionStatusChange={(status, message) =>
            onStatusChange(tab.id, pane.id, status, message)
          }
        />
        {pane.exited && (
          <PaneExitBar
            code={pane.exited.code}
            onRestart={() => onRestartPane(tab.id, pane.id)}
            onClose={() => onClosePane(tab.id, pane.id)}
          />
        )}
      </div>
    );
  };

  return (
    <div className="tab-content" style={{ display: isActive ? "block" : "none" }}>
      {/* Flat grid: panes AND dividers are direct children with stable
        keys, so no live terminal ever remounts (see note above).
        Dividers overlay the exact pane seams (1px visual bar, generous
        ::after hit area); drag math is pointer delta over the split's
        parent size. Only the xterm viewport scrolls. */}
      <div
        className="pane-container-none pane-grid"
        data-pane-container={tab.id}
        data-split={isSplit ? "true" : "false"}
        ref={containerRef}
      >
        {tab.panes.map(renderPane)}
        {dividers.map((d) => {
          const vertical = d.direction === "vertical";
          const seam = vertical
            ? d.parent.x + d.parent.w * d.ratio
            : d.parent.y + d.parent.h * d.ratio;
          return (
            <div
              key={d.splitId}
              data-split-id={d.splitId}
              className={`pane-divider pane-divider-abs pane-divider-${d.direction}`}
              role="separator"
              aria-orientation={vertical ? "vertical" : "horizontal"}
              aria-label={`Resize ${d.direction} split`}
              style={
                vertical
                  ? { left: pct(seam), top: pct(d.parent.y), height: pct(d.parent.h) }
                  : { top: pct(seam), left: pct(d.parent.x), width: pct(d.parent.w) }
              }
              onPointerDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
                const rect = containerRef.current?.getBoundingClientRect();
                const parentSizePx = rect
                  ? vertical
                    ? rect.width * d.parent.w
                    : rect.height * d.parent.h
                  : 0;
                beginSplitDrag(
                  d.splitId,
                  d.direction,
                  vertical ? e.clientX : e.clientY,
                  parentSizePx,
                  d.ratio
                );
              }}
            />
          );
        })}
      </div>
    </div>
  );
});
