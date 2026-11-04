---
"kai-terminal": minor
---

Microsoft Teams: send files larger than 4 MB.

- **Bigger files**: `kai teams` now uploads a file up to 250 MB to your OneDrive in chunks through an upload session, shows the progress while it goes, and carries on from where it stopped if a chunk fails. Files up to 4 MB are sent as before.
- **Pictures**: a picture over 4 MB, which cannot ride inside a message, is uploaded and sent as a link instead of being refused.
- **Limits**: up to 4 items per message and 250 MB in total, because what is attached is held in memory while it is sent.
