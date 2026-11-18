---
"kai-terminal": patch
---

Four limits removed.

- **No Node.js to install**: release installers now carry their own Node.js for the bundled `kai` CLI, so the Integrations tab and the `kai` launcher work on a machine without Node.
- **`az` found from the Dock or a menu**: on macOS and Linux the app reads your login shell's PATH at startup, so Azure CLI sign-in works when the app is not started from a terminal.
- **Mini player dim on macOS**: Dim Opacity now shows the desktop through the mini window on macOS too.
- **Autoplay note corrected**: macOS and Linux webviews already allow the mini window's video to start without a click.
