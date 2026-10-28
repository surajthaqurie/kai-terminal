---
"kai-terminal": patch
---

Faster indexing, especially on Windows. The index builder no longer resolves the real path of every file and folder it walks (about two `lstat` calls per path component each, twice per entry); only symbolic links and junctions are resolved and boundary-checked, exactly as before. On this repository (313 indexed files) a rebuild with nothing changed drops from about 500 ms to about 85 ms and a cold build from about 760 ms to about 340 ms.
