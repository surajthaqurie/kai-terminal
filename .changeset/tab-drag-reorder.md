---
"kai-terminal": patch
---

Fix tab drag-reorder on all OSes with pointer-based dragging. The previous HTML5 drag-and-drop reorder was unreliable across platforms (missed drops, stale drop targets, click-after-drag activating the wrong tab). Tabs now reorder via pointer capture with a 6px drag threshold, live drop-index computed from tab midpoints, a drop-indicator line, auto-scroll at the strip edges, Escape-to-cancel, and a click suppressor so dropping a tab does not accidentally activate its neighbor. Reorder commits through a new `onMoveTabToIndex` absolute-index path (clamped, no-op when unchanged) alongside the existing relative/keyboard move handlers, so mouse, context-menu, and keyboard reorder stay consistent without remounting terminals.
