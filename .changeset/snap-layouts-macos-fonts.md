---
"kai-terminal": patch
---

Windows 11 snap layouts on the maximize button, and the real font list on macOS.

- **Snap layouts (Windows 11)**: hovering the maximize button now opens the snap-layouts popup, as on a normal Windows window, and the button keeps its hover and pressed look. A click still maximizes or restores. Windows 10, macOS and Linux are unchanged. The popup and a quick click were checked on Windows 11 (build 26300); the first click while the popup is already open was not reliable in that test, so please report it if it does not maximize.
- **macOS font list**: Settings → Font & Display now asks macOS for the real font family names, so names such as SF Mono are no longer left out. The font folders are still read as a fallback if the lookup fails. This has not been run on a Mac.
