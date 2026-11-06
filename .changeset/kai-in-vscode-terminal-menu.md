---
"kai-terminal": patch
---

Kai Terminal now lists itself in the terminal dropdown of VS Code, Cursor, VSCodium and Windsurf, next to PowerShell and bash, and splitting a pane moves keyboard focus into the new pane.

- **Automatic, no extension**: on launch Kai adds a "Kai Terminal" profile to each installed editor's user settings. It opens your usual shell with `KAI_TERMINAL=1`, so `kai <agent>` and the other in-Kai commands work there. Reload the editor window to see it.
- **Respectful of your settings**: each editor is offered it once, so deleting the entry sticks. Comments and other settings are kept, the original file is saved once as `settings.json.kai-backup`, and a settings file that does not parse is left alone. Set `KAI_NO_EDITOR_PROFILE=1` to turn it off.
- **Split focus**: a new split (shortcut or command palette) used to leave the cursor in the old terminal, so typing went to the wrong shell.
