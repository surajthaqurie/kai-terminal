---
"kai-terminal": patch
---

Switching tabs no longer shows scrambled glyph fragments in the terminal.

- **No more garbled text on switch**: the GPU glyph atlas is now rebuilt every time a tab is shown again, not only after it sat idle for several seconds, so even a quick flip between tabs paints clean text.
