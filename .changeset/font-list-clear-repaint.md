---
"kai-terminal": patch
---

Themed header, footer and font list, plus a repaint after `clear`.

- **Header and footer follow the theme**: the tab strip and status bar now use each theme's own terminal colour instead of a separate near-black, so the whole window reads as one themed piece (inactive and hovered tabs use the theme's darker and lighter surfaces; the see-through window picks it up too).
- **Font list**: Settings → Font & Display now has a themed, scrolling list instead of the OS-drawn dropdown. It shows the bundled JetBrains Mono, the clean monospace fonts installed on your PC (Cascadia Code, Cascadia Mono, Consolas and Ubuntu Sans Mono first; each shown in its own typeface), the OS default and a custom field. Icon and symbol fonts, CJK fonts and Courier are left out. The installed list comes from the OS on Windows (font registry), Linux (`fontconfig`, then the font folders) and macOS (the font folders); the browser build and any failed lookup fall back to the built-in presets.
- **`clear` / `cls` / Clear-Host**: after output that wipes the screen the terminal now repaints every row and scrolls to the bottom, so the prompt that follows is no longer left unpainted. This was not reproduced on a running desktop app, so please report it if a prompt still goes missing after `clear` (and say which shell).
