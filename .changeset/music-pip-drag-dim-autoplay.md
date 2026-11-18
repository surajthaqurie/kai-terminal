---
"kai-terminal": patch
---

Mini music player fixes.

- **Keeps playing**: popping the player out no longer stops the song. The new window had not been clicked yet, so Windows blocked the video from starting with sound.
- **Drag anywhere**: the mini window can be dragged from anywhere on the video, not only its title strip, and it reopens where you last left it (or bottom-right if that spot is no longer on a screen).
- **Dim opacity**: the player's Dim Opacity now applies to the mini window too, and the desktop shows through it (Windows and Linux). It returns to full opacity while the pointer is over it.
- **Smoother**: the mini window's time and progress bar move smoothly between YouTube's updates, and dragging its seek bar no longer jumps back while you drag.
- **Dim preview**: in the docked player, moving the Dim slider now previews the level on the panel right away instead of only after the popover closes.
