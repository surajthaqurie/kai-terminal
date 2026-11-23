---
"kai-terminal": minor
---

Several windows, and tabs that can be dragged out into their own window.

- **New window** (`Ctrl+Shift+N`, the `⋯` menu, the command palette, or launching Kai again) opens another independent Kai window in the same app. Closing one window ends only its shells; the app quits when the last window closes. Only the first window saves the layout, plays music and checks for updates.
- **Drag a tab out of the tab bar** and release to move it into a new window with its shell still running: the scrollback and any running command come along, and nothing printed during the move is lost. **Move tab to new window** in the tab's right-click menu and the palette does the same without dragging. If the window cannot open, the tab stays where it was.
- The Windows snap-layouts popup stays with the first window; extra windows use the normal maximize button.
- A split pane no longer shows a folder heading ("kai-terminal") at its top, and the app icon at the far left of the header is gone (the tab icons stay).
