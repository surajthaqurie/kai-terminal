---
"kai-terminal": patch
---

Two small limits removed.

- **Pastes of any size**: a keyboard paste is no longer cut off at 32 MB. The app reads the clipboard once and hands it to the terminal in 4 MB pieces, so a very large paste never travels as one huge message.
- **Mini player resume**: a paused song moved between the docked player and the mini window now resumes at its exact position (not the last whole second) and stays paused. While the video reloads, the mini window shows buffering instead of a running progress bar.
