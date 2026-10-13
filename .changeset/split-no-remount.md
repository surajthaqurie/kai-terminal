---
"kai-terminal": patch
---

Fix opening a split refreshing (respawning) the older terminal. The nested flexbox renderer reparented the surviving pane under a brand-new split element on every split/close, so React unmounted its TerminalView — disposing xterm, closing the backend PTY, and spawning a fresh shell with lost scrollback and session state. Panes now render as a flat list of absolutely-positioned siblings with stable keys; the layout tree drives geometry only (new `computePaneRects`/`computeSplitDividers`/`resolveTabLayout` helpers), so splits, closes, and divider drags never remount a live terminal. Divider visuals, ARIA roles, and drag math are unchanged, and corrupt/stale layout trees fall back to an even tiling instead of dropping panes.
