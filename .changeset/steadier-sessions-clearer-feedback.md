---
"kai-terminal": patch
---

Steadier terminals and sessions, errors you can see, and a pass over silent failures.

**Terminal**

- **The shell now gets the right size.** A window resize, a font loading late or a split that happened while a shell was starting changed the terminal grid but never reached the shell, which kept its smaller size (a prompt at the top of a tall, mostly blank terminal) until the next resize. The shell is now re-sized as soon as it starts. Window-focus refits no longer re-send an unchanged size (each one made ConPTY repaint the shell), and a font or setting change that alters the grid is sent too. The terminal size cap rose from 500 to 1000 columns and from 300 to 500 rows, so a maximized 4K pane is no longer narrower for the shell than on screen.
- **No lost first prompt, no hidden crash.** A fast shell could print its first prompt, or a broken one could exit, before Kai had its session id, and those events were thrown away: a blank terminal until a keypress, or a dead shell still shown as connected with no "Shell exited right after opening" banner. They are now held and replayed in order.
- **A saved folder that no longer exists no longer locks a terminal out.** A restored tab whose folder is gone (an unplugged drive, a stopped WSL) used to fail on every Retry. The terminal now says so and opens in your home folder.
- **An unknown exit status is a failure, not a clean exit.** It used to count as `0`, which skipped the crash-loop guards and could quit Kai from its last tab.
- **Two shells ending together** (for example `wsl --shutdown`) no longer leave one dead, unclosable tab or pane behind, and closing two tabs quickly closes both.

**Sessions and tabs**

- **New tabs start in your home folder**, as before the footer folder began leaking into them; a pane's own folder is always recorded, so later splits and saved layouts no longer follow whatever the footer shows.
- **Loading the previous session no longer replaces live tabs.** It replaces only the untouched starter tab; otherwise the previous tabs are added next to yours. Opening or closing a tab resumes saving your layout (it used to stay suspended while the offer was ignored), loading a workspace dismisses the offer, and turning on auto-restore later no longer wipes open tabs.
- A single-pane tab saves its own shell and folder after a split collapses, a tab's status reflects all of its panes (one failed split is not hidden by a healthy one), `kai-open-project` focuses the tab actually in that folder, and a click on a pane that was just closed no longer leaves focus on nothing.
- **Crash-loop banner:** it goes away when its tab is closed, replaced, or fixed from the footer shell picker; **Retry** falls back to your default shell when the pane's own shell is no longer installed; and the message now points at what works (the footer shell picker).
- **Workspaces:** saving uses a name field instead of a blocking `prompt()` (which does not work in macOS WebViews), tells you when only the first 10 tabs of a layout were kept or the 20-workspace limit is reached, and reports a failed save instead of claiming success. Deleting your last workspace no longer brings back the live session as a "Restored session" workspace.

**Messages you can see**

- Failures of actions that gave no feedback (opening the editor, git status, update checks and downloads, launch-at-startup, the shell list) now appear as a toast above the status bar. Errors stay until dismissed and have a **Details** button that opens Diagnostics; confirmations fade. A manual **Check for updates** that finds nothing now says "You're up to date".
- A failed background update check no longer erases an update that was already found, and is retried at the next launch instead of 24 hours later.
- **Dialogs** (Settings, AI providers, Workspaces, Diagnostics, Git status, Rename) close on Escape, take keyboard focus (so typing no longer reaches the shell behind the backdrop), keep Tab inside, and return focus to the terminal. Escape cancels shortcut recording first. Closing Settings with its shortcut now restores the saved theme instead of leaving a previewed one applied. The Diagnostics download no longer revokes its file before the WebView starts saving it.

**Settings that did not stick**

- A bare function-key shortcut (such as `F5`) no longer reverts on save, and a malformed one (`Ctrl+`) is no longer accepted.
- A font size of 14 you chose is kept (it was reset to 12 on every start); switching **Default shell** back to *System Default* applies immediately; enabling the music player from the footer or `Ctrl+Alt+M` is now saved; saving any setting no longer desynchronizes the footer mute icon from the audio; the command palette shows your remapped copy, paste and clear keys.
- **AltGr is text, not a shortcut.** On layouts where AltGr is reported as `Ctrl+Alt` (German, Polish and others), typing characters such as `~` or `ś` no longer fires shortcuts like "next pane" or "split". A real `Ctrl+Alt+…` shortcut still works on layouts without an AltGr key.
- **The update sweep keeps your data.** The cache cleanup after an update used to delete the music player's favorites, volume, pin and size, the renderer override and (now) validated AI provider paths. They are kept.

**Music Time**

- The footer play, next and previous buttons and their shortcuts open the player when nothing is loaded instead of doing nothing.
- **A video that cannot be embedded** (YouTube error 101/150, removed, private) now says why and shows "Play" instead of claiming to be playing; pressing Play again explains rather than flipping the icon.
- **Next and auto-advance find different songs for a pasted link or a preset.** The related-song search used the link or id itself, which only returns the song already playing; it now uses the real title once YouTube reports it, ignores results from a song you have already left, and keeps the queue filled.
- Escape undoes one layer at a time (dim popover, then the queue drawer, then the player; a pinned player stays), and the end of a call no longer resumes over a Play or Pause you pressed during it.

**AI providers**

- A custom CLI is checked before it is saved (a typo used to be saved and reappear as a "missing" card forever), custom entries have a **Remove** button, and a path you validated for a built-in provider is remembered instead of reverting at the next re-detect.

**Security and robustness**

- On Windows, probing for tools no longer runs a same-named file from the project folder: a cloned repository containing `gopls.cmd`, `az.bat` or `kai.exe` was executed by language-server detection, Azure CLI sign-in, `kai close` and the desktop-app lookup. Those lookups now ignore the current directory.
- GitHub links opened from Kai go through the same strict character check as YouTube and Azure links (a `&` or `|` in a release tag could have run another command through `cmd /c start`). The updater's repository guard no longer depends on the host's capitalization.
- A Windows version probe that timed out once no longer blocks every new terminal until restart. The `kai` PowerShell and shell shims quote the Node path, so `kai` works from `C:\Program Files\nodejs`.

Verified in a real browser and with a stand-in desktop backend, and by unit and component tests; the new terminal-size, early-event and missing-folder paths have not yet been run against the real Windows desktop app, so please report anything that still looks wrong.
