---
"kai-terminal": patch
---

Music player at small sizes: the controls no longer get cut off.

- **Controls**: at the narrowest width the previous-track button and the volume slider were clipped. The controls now wrap, so the volume sits on a second row when the player is narrow, and everything stays visible.
- **Height**: the smallest height is now 360px (was 320px) so the wrapped row fits. A height you saved below that is raised to it, not reset.
- **Search box**: the placeholder is shorter ("Paste a link or search a song") so it is no longer cut mid-word.
