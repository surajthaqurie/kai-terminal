---
"kai-terminal": patch
---

Fix exiting one split refreshing the other split's terminal. The exit path duplicated pane-collapse logic inline beside the close-button path, and both rebuilt layout state in ways that could drop survivor identity. Pane removal now goes through a single tested `removePaneById` helper (used by shell-exit, the close-split button, and `closePane`): survivors keep their ids and object identity, the tree prunes to exactly the survivors, and focus moves to the neighbor only when the focused pane exits. Per-tab split geometry is also memoized so divider keys stay stable across renders. Audited all React keys project-wide (panes, tabs, dividers, modal lists) — all stable ids, no render-phase id generation — so no live terminal remounts on split, close, exit, reorder, rename, or resize on any OS.
