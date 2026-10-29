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
import { TerminalView, type TerminalViewRef } from "./TerminalView";

interface TabPanesProps {
  tab: TerminalTab;
  /** Whether this tab is the visible one (hidden tabs stay mounted). */
  isActive: boolean;
  selectedShell: ShellProfile | undefined;
  settings: UserSettings;
  /** Global toolbar cwd: last fallback for a pane's working directory. */
  fallbackCwd: string;
  /** Terminal handles keyed by pane id (toolbar actions, refit). */
  terminalRefs: MutableRefObject<Record<string, TerminalViewRef | null>>;
  onFocusPane: (tabId: string, paneId: string) => void;
  /** Code Mode of one pane (project path) or `null` when it ends. */
  onCodeModeChange: (paneId: string, project: string | null) => void;
  onCwdResolved: (tabId: string, paneId: string, cwd: string) => void;
  onExit: (tabId: string, paneId: string, exitCode?: number) => void;
  onStatusChange: (tabId: string, paneId: string, status: SessionStatus, message?: string) => void;
  onResizeSplit: (tabId: string, splitId: string, ratio: number) => void;
}

const FULL_RECT: PaneRect = { paneId: "", x: 0, y: 0, w: 1, h: 1 };

const pct = (fraction: number) => `${fraction * 100}%`;

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
  settings,
  fallbackCwd,
  terminalRefs,
  onFocusPane,
  onCodeModeChange,
  onCwdResolved,
  onExit,
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

  const renderPane = (pane: TerminalPane): ReactNode => {
    const rect = rectByPaneId.get(pane.id) ?? FULL_RECT;
    const focusPane = () => onFocusPane(tab.id, pane.id);
    return (
      <div
        key={pane.id}
        className={`pane-item pane-grid-pane ${pane.id === tab.activePaneId ? "active-pane" : ""}`}
        style={{
          left: pct(rect.x),
          top: pct(rect.y),
          width: pct(rect.w),
          height: pct(rect.h),
        }}
        onClick={focusPane}
        onPointerDown={focusPane}
      >
        <TerminalView
          ref={(el) => {
            terminalRefs.current[pane.id] = el;
          }}
          sessionId={pane.id}
          selectedShell={selectedShell}
          cwd={pane.cwd || tab.cwd || fallbackCwd}
          settings={settings}
          visible={isActive}
          resetKey={pane.resetKey ?? 0}
          onFocus={focusPane}
          onCodeModeChange={(project) => onCodeModeChange(pane.id, project)}
          onCwdResolved={(resolved) => onCwdResolved(tab.id, pane.id, resolved)}
          onExit={(exitCode) => onExit(tab.id, pane.id, exitCode)}
          onSessionStatusChange={(status, message) =>
            onStatusChange(tab.id, pane.id, status, message)
          }
        />
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
