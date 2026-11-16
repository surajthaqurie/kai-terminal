---
"kai-terminal": patch
---

A terminal tab left idle no longer comes back blank or full of random symbols.

- **No more garbled glyphs**: a tab hidden for more than a few seconds now rebuilds its GPU glyph atlas before it is painted again, so rows no longer draw as random symbols. Quick flips between tabs skip this and stay instant.
- **No more blank pane**: if the WebView drops a hidden tab's GPU context, the pane repaints immediately instead of staying empty until the next switch, and a tab that was idle gets one extra re-fit and repaint a frame after it is shown.
