---
"kai-terminal": minor
---

Friendlier default shortcuts, in the Windows Terminal style, and a clearer Shortcuts screen.

- **New defaults**: panes use `Alt+Shift` (`Alt+Shift+=` splits side by side, `Alt+Shift+-` stacks, `Alt+Shift+W` closes, `Alt+Shift+]` / `[` move between panes), tabs cycle with `Ctrl+Tab` / `Ctrl+Shift+Tab`, Settings is `Ctrl+,`, and Music Time moves to `Ctrl+Shift+M`, `Space`, `.` and `,`. Nothing needs `Ctrl+Alt` any more, because Windows reports it as AltGr and many keyboard layouts use it to type characters.
- **Previous pane**: a new "Previous pane" action (`Alt+Shift+[`), also in the command palette.
- **Upgrading**: shortcuts you never changed move to the new defaults once. A shortcut you set yourself keeps its key, and an old default stays if its new key would clash with one of yours. Rebind the old keys in Settings → Shortcuts if you prefer them.
- **Settings → Shortcuts**: shortcuts are grouped (Tabs, Panes, App, Music Time, Terminal keys), each changed shortcut has its own reset button, a conflict names the other action, macOS shows `Cmd`, and the recorder now captures Tab, Space, Enter and the arrow keys (it could not record the old `Ctrl+Alt+Space` default).
- **Docs and website**: the README, the Guide page's shortcut list and the architecture notes show the new keys.
