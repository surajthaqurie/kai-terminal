---
"kai-terminal": minor
---

UI refresh: new theme set, a working background-opacity slider, a cleaner header and a per-terminal shell picker.

- **Themes**: Kai Dark (new default), GitHub Dark / Light, Gruvbox Dark and Monokai are new; Kali is retired (saved settings move to Kai Dark). Dim text (autosuggestions, comments) is readable in every theme — Solarized Dark's was invisible. Window chrome is tuned per theme and contrast-tested.
- **Opacity**: the slider now makes the whole window see-through on Windows and Linux (header, tabs, footer and terminal), not just the terminal background. macOS keeps the terminal-only fade.
- **Header**: the app icon and name sit at the far left; "Open project in editor" is an icon right after the search box (the caret lists installed editors); Music Time and the editor list are gone from the More menu.
- **Shell per terminal**: the footer starts with a shell picker for the focused terminal. Switching restarts that terminal in the new shell after a confirmation and keeps its folder; splits open in their parent's shell, and each terminal's shell is saved with the session.
