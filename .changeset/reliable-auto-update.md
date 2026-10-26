---
"kai-terminal": patch
---

Reliable in-app updates on every OS. Fix "Update installer not found" on Windows (the downloaded installer was rejected by a trailing-separator path check). Updates now install unattended: Kai closes itself, a detached helper installs the update (Windows `.exe`/`.msi`, macOS `.app` swap from the `.dmg`, Linux `.deb` via polkit or in-place AppImage replace), deletes the downloaded installer once it has finished, and reopens the new version automatically. When no unattended path exists (read-only install location, no `pkexec`) the installer is opened for you as before. Kai also updates through the package type it was installed with (AppImage stays an AppImage, MSI stays MSI).

The install itself is invisible: no installer windows, and the only progress you see is Kai's own two-step bar ("Downloading 42%", then "Installing in the background"). After the restart Kai tells you whether the update worked ("Kai updated — you are now running vX", or "Update didn't finish" with a Try again button).
