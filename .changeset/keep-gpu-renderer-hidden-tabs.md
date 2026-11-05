---
"kai-terminal": patch
---

Switching back to a tab left for a while is smooth again.

- **No stall or garbled frame on tab switch**: a hidden tab used to drop its GPU renderer after 15 seconds, so switching back rebuilt it on the spot (a brief freeze, sometimes a frame of scrambled text). Hidden tabs now keep it; only when more than six tabs are hidden does the longest-hidden one give its renderer back.
