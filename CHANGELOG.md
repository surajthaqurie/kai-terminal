# Changelog

## 0.2.2

### Patch Changes

- Website and README refresh: real screenshots of the app (the window, `kai teams`, the Azure DevOps rules), a "See it in action" gallery on the home page, new feature cards for Teams chat, links and file paste and the nine themes, a Teams FAQ, and a 0.2.2 hero image. `SECURITY.md` and `KNOWN_LIMITATIONS.md` now cover Microsoft Teams.

- e60d0ef: Azure DevOps projects can now set a merge branch and a branch naming pattern that agents use for every work item.

  - A **Merge branch** list behind **More** on the Azure DevOps card, filled from the repository's real branches. A branch the repository does not have is refused when you save (offline, it is accepted as typed). Only a change from the default is stored, and it survives switching project.
  - A **Branch naming (regex)** field next to it: an optional regular expression new branch names should match. It is checked as you type and when you save, with a plain reason for each problem (a broken pattern, slashes or flags around it, surrounding spaces, more than 200 characters, a nested repeat like `(a+)+`, a pattern that matches an empty name). A pattern without `^` and `$` only gets a tip.
  - Both have a **Remove** button. Removing the merge branch goes back to the repository default; removing the naming pattern lets agents choose their own names. Nothing is stored for a cleared field.
  - New `kai_workflow_rules` MCP tool. It returns the merge branch, or the repository's default branch when none is set, plus the naming pattern when one is set, so new branches start there, follow the pattern, and pull requests target the merge branch.
  - It is guidance: nothing is validated or blocked when an agent commits or pushes.

- Azure DevOps sign-in no longer dead-ends when this build has no browser sign-in set up.

  - `kai integration azure` now says "Browser sign-in is not set up in this build of Kai" and signs in with the Azure CLI or an access token instead, rather than stopping. Choosing `--az`, `--pat-stdin` or `--server-url` is unchanged.
  - In the desktop app, **Connect** shows the same explanation plus what to do: run `kai integration azure` in a terminal.

- 465f239: The footer **Code Mode** pill is now display-only. Clicking it used to flip the footer to "Terminal" while the agent was still running in Code Mode, so the footer disagreed with the terminal. Code Mode now ends only when `kai <agent>` exits or `kai stop` runs.
- 05b721a: Friendlier terminal defaults, and every shortcut is easier to find on every OS.

  - **Font size 14 and a blinking cursor are the defaults** on Windows, macOS and Linux. If you never changed them (a saved size of 12 with a steady cursor, which is what earlier versions saved), they move once. A size or cursor you chose yourself, including a different size, is kept, and so is a 12 or a steady cursor you pick from now on.
  - **Every button with a shortcut shows its key**: New tab, Close tab, Close split and Settings now say, for example, "New tab (Ctrl+Shift+T)", and follow your own keys if you changed them. The New tab tooltip no longer carries a long "Ctrl+T / Cmd+T" note.
  - **macOS wording**: shortcuts show `Cmd` and `Option` there (the Alt key is Option), everywhere they appear: tooltips, the command palette and Settings.
  - **Keyboard Shortcuts in the command palette**: `Ctrl+Shift+P`, then "Keyboard Shortcuts" opens Settings straight on the Shortcuts tab, where you can search and change any of them.

- 0940037: Themed header, footer and font list, plus a repaint after `clear`.

  - **Header and footer follow the theme**: the tab strip and status bar now use each theme's own terminal colour instead of a separate near-black, so the whole window reads as one themed piece (inactive and hovered tabs use the theme's darker and lighter surfaces; the see-through window picks it up too).
  - **Font list**: Settings → Font & Display now has a themed, scrolling list instead of the OS-drawn dropdown. It shows the bundled JetBrains Mono, the clean monospace fonts installed on your PC (Cascadia Code, Cascadia Mono, Consolas and Ubuntu Sans Mono first; each shown in its own typeface), the OS default and a custom field. Icon and symbol fonts, CJK fonts and Courier are left out. The installed list comes from the OS on Windows (font registry), Linux (`fontconfig`, then the font folders) and macOS (the font folders); the browser build and any failed lookup fall back to the built-in presets.
  - **`clear` / `cls` / Clear-Host**: after output that wipes the screen the terminal now repaints every row and scrolls to the bottom, so the prompt that follows is no longer left unpainted. This was not reproduced on a running desktop app, so please report it if a prompt still goes missing after `clear` (and say which shell).

- 5de9f9e: Integrations tools appear in a running agent, and `kai` works in WSL.

  - **Live tool list**: the MCP server now announces `tools: { listChanged: true }` and sends `notifications/tools/list_changed` (within about two seconds, once the client has sent `initialized`) after `kai integration azure` or `kai azure remove`. An agent that honors it refreshes its tools without a restart; one that does not still needs one. `KAI_MCP_TOOLS_POLL_MS` sets the check interval and `0` turns it off.
  - **WSL**: a `wsl.exe` terminal now lists `KAI_TERMINAL` in `WSLENV`, keeping your own entries, so `kai <agent>` can run inside WSL instead of refusing to start.
  - **Tests**: the directory-link tests skip, with a reason, on a Windows build that creates a junction but will not follow it, instead of failing or passing without checking anything.

- Microsoft Teams chat in the terminal: `kai integration teams` and `kai teams`.

  - **`kai integration teams`** signs you in with your Microsoft account in the browser (nothing to type) and checks that your teams and chats can be read. It is your own account, shared by every terminal, not tied to a folder. The token goes to the OS secret store. `kai integration teams remove` signs out. Reading what others write in channels needs an administrator's approval in most organizations, so it is a separate step (`--channels`); chats and sending to channels work without it. Setup guide for maintainers: `docs/teams-sign-in.md`.
  - **`kai teams`** opens the chat in the tab you run it in: teams, channels and chats on the left, the conversation on the right, a message box below. Everything is clickable and everything works from the keyboard. It takes no options.
  - **It keeps itself up to date**: the open conversation refreshes every few seconds (slower while the window is not focused, and at once when you return), the chat list refreshes on its own with the newest chats first and a dot on every conversation with unseen messages (channels and chats you opened this session included), a new message elsewhere shows a notice and rings the bell when the window is not focused, and edits and deletions show up. The header shows `synced 09:41`, `offline, retry ...` (it backs off and recovers on its own) or `sign-in expired`.
  - **Older messages** load when you scroll to the top. **Sending is instant**: your message shows at once as `sending...`, and if Teams refuses it the text and attachments come back. Each conversation keeps its own draft.
  - **Pictures show in the conversation**: inline where the terminal draws them (iTerm2, WezTerm, mintty and Kai Terminal), otherwise as a line you click to open in your image viewer. Kai Terminal now draws inline images (iTerm2 protocol and Sixel). A link to another site names the site before you click.
  - **Send images and files**: Ctrl+V, the Attach button, or a pasted path (Kai Terminal pastes copied files as paths). Images go inline in the message; other files are uploaded to your OneDrive and shared as a link. Up to 4 items of 4 MB.
  - **Yours, not your agents'**: the Teams sign-in is never put in an environment variable, an agent's config or the MCP server; there is no command that reads or posts without a person at the keyboard; and both Teams commands refuse to run inside an AI agent's session. That is checked three ways: a known agent CLI (Claude Code, Codex, Gemini, Copilot, OpenCode, Aider, Cline and others) among the processes that started the command, the variable an agent sets on its commands, and the need for an interactive terminal. Kai also marks every agent it starts.
  - Message text is cleaned of terminal escape sequences before it is shown, so a message cannot move the cursor, change the title or hide text. Pasted and opened images are saved in a private per-user temp folder.

- 05b721a: Music player: the play, pause, next, previous, mute, volume and seek buttons now control the video in the desktop app.

  - **Buttons did nothing on desktop**: the player was told it lived on `youtube-nocookie.com` instead of the app's real address (`http://tauri.localhost` on Windows). YouTube only accepts commands from the address it was given, so every button changed its own icon but the video kept playing, and the title and time never updated. The real address is now passed, so the buttons and the footer mini-player act on the video.
  - **macOS and Linux**: those builds have no address YouTube accepts, so the player cannot be remote-controlled there. It now shows YouTube's own controls on the video and a notice explaining why, instead of buttons that silently do nothing.
  - **Dim button**: pressing it a second time now closes its popover (it used to reopen it).
  - **Random**: one of the four random songs (the Lofi Girl live radio) forbids embedding and left a dead player. It is replaced with a video that plays.
  - **Unplayable videos**: Next and Previous no longer switch the button to "Pause" for a video YouTube refused to play; they show the reason instead.

- 36694cf: Music player at small sizes: the controls no longer get cut off.

  - **Controls**: at the narrowest width the previous-track button and the volume slider were clipped. The controls now wrap, so the volume sits on a second row when the player is narrow, and everything stays visible.
  - **Height**: the smallest height is now 360px (was 320px) so the wrapped row fits. A height you saved below that is raised to it, not reset.
  - **Search box**: the placeholder is shorter ("Paste a link or search a song") so it is no longer cut mid-word.

- 05b721a: Music shortcuts that are easier to find and remember, and a search box for all shortcuts.

  - **Previous song now has a shortcut**: `Ctrl+Shift+,` goes back and `Ctrl+Shift+.` goes forward, the `<` and `>` keys, like a media player. Before, the player and status bar had a Previous button but no key for it, and `Ctrl+Shift+,` was Mute.
  - **Mute moved to `Ctrl+Shift+0`**. If you never changed Mute, it moves once; a Mute key you chose yourself stays as it is. Rebind any of them in **Settings → Shortcuts**.
  - **Hover to learn the key**: every music button in the player and the status bar now shows its shortcut in the tooltip (for example "Next song (N or Ctrl+Shift+.)"), and follows your own keys if you changed them.
  - **Command palette**: `Ctrl+Shift+P`, then type "music" to play / pause, go to the previous or next song, or mute. Each entry shows its key. With the player switched off, picking one turns the player on and opens it.
  - **Search in Settings → Shortcuts**: type a name (`split`), a group (`music`) or a key chord (`Ctrl+Shift+W`) to jump to a shortcut instead of scrolling the whole list.
  - **Plainer names**: "Show / hide music player", "Music: play / pause", "Music: previous song", "Music: next song", "Music: mute / unmute".

- e60d0ef: New tabs open in your home folder, and the footer no longer shows a path.

  - A new tab used to borrow the previous tab's folder for the moment before its shell reported one, so the git badge, "open in editor" and the AI panel pointed at the wrong project. Each tab now only knows its own folder; the shared "toolbar" folder it fell back to is gone.
  - Splits still open in the folder of the pane they were split from.
  - Removed the working-directory path from the footer (the git branch, mode and shell picker stay).
  - `kai mcp <agent>` now repairs an MCP entry whose script no longer exists (for example after the app was reinstalled elsewhere) instead of reporting it as already configured, and writes plain paths without the Windows `\?\` prefix.

- 810d407: Steadier terminals and sessions, errors you can see, and a pass over silent failures.

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
  - A font size of 14 you chose is kept (it was reset to 12 on every start); switching **Default shell** back to _System Default_ applies immediately; enabling the music player from the footer or `Ctrl+Alt+M` is now saved; saving any setting no longer desynchronizes the footer mute icon from the audio; the command palette shows your remapped copy, paste and clear keys.
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

- Terminal: links open from the output, and you can paste copied files and images.

  - **Links now open**: web addresses in the terminal (sign-in links, build logs, docs) are underlined when you point at them. Ctrl+click (Cmd+click on macOS) opens them in your browser. Before, nothing in the terminal was clickable. A plain click still just selects text, so TUIs that use the mouse keep working. Only `http` and `https` links open, and never through a shell, so a `&` in an address cannot run anything.
  - **Paste a copied file**: copy files in Explorer, Finder or a file manager and paste (Ctrl+Shift+V, Cmd+V or Shift+Insert). Their paths are pasted, quoted when they contain spaces, ready for a command or an AI CLI.
  - **Paste a copied image**: a screenshot or "Copy image" from a browser is saved as a PNG in the temp folder and its path is pasted, so AI CLIs can attach it. Saved images older than a day are cleaned up. Before, pasting anything that was not text did nothing.
  - Plain text still pastes as before, and a paste never presses Enter.

- 7df6e17: Themes: trimmed to nine and added Rosé Pine.

  - **Kept**: Kai Dark (default), Gruvbox Dark, Catppuccin Mocha, Tokyo Night, Nord, Dracula, Solarized Dark, One Dark. Their colours are unchanged.
  - **Added**: Rose Pine.
  - **Removed**: Monokai, GitHub Dark, GitHub Light and Solarized Light. Saved settings that used one of them open in Kai Dark. There are no light themes any more.

- 262bff0: UI refresh: new theme set, a working background-opacity slider, a cleaner header and a per-terminal shell picker.

  - **Themes**: Kai Dark (new default), GitHub Dark / Light, Gruvbox Dark and Monokai are new; Kali is retired (saved settings move to Kai Dark). Dim text (autosuggestions, comments) is readable in every theme — Solarized Dark's was invisible. Window chrome is tuned per theme and contrast-tested.
  - **Opacity**: the slider now makes the whole window see-through on Windows and Linux (header, tabs, footer and terminal), not just the terminal background. macOS keeps the terminal-only fade.
  - **Header**: the app icon and name sit at the far left; "Open project in editor" is an icon right after the search box (the caret lists installed editors); Music Time and the editor list are gone from the More menu.
  - **Shell per terminal**: the footer starts with a shell picker for the focused terminal. Switching restarts that terminal in the new shell after a confirmation and keeps its folder; splits open in their parent's shell, and each terminal's shell is saved with the session.

- 65380d4: Friendlier default shortcuts, in the Windows Terminal style, and a clearer Shortcuts screen.

  - **New defaults**: panes use `Alt+Shift` (`Alt+Shift+=` splits side by side, `Alt+Shift+-` stacks, `Alt+Shift+W` closes, `Alt+Shift+]` / `[` move between panes), tabs cycle with `Ctrl+Tab` / `Ctrl+Shift+Tab`, Settings is `Ctrl+,`, and Music Time moves to `Ctrl+Shift+M`, `Space`, `.` and `,`. Nothing needs `Ctrl+Alt` any more, because Windows reports it as AltGr and many keyboard layouts use it to type characters.
  - **Previous pane**: a new "Previous pane" action (`Alt+Shift+[`), also in the command palette.
  - **Upgrading**: shortcuts you never changed move to the new defaults once. A shortcut you set yourself keeps its key, and an old default stays if its new key would clash with one of yours. Rebind the old keys in Settings → Shortcuts if you prefer them.
  - **Settings → Shortcuts**: shortcuts are grouped (Tabs, Panes, App, Music Time, Terminal keys), each changed shortcut has its own reset button, a conflict names the other action, macOS shows `Cmd`, and the recorder now captures Tab, Space, Enter and the arrow keys (it could not record the old `Ctrl+Alt+Space` default).
  - **Docs and website**: the README, the Guide page's shortcut list and the architecture notes show the new keys.

## 0.2.1

### Patch Changes

- Azure DevOps integration: `kai integration azure` sets a folder up in one command. It signs you in (the Azure CLI, offering to run `az login` for you, or an access token), connects the project, wires Kai's MCP server into your installed agents, and verifies work items, pull requests and builds with real calls. The organization, project and repository are auto-detected from the folder's git remotes (Azure DevOps Services and Azure DevOps Server HTTPS remotes), from any sub-folder, tolerating a trailing `.git`, never reading a credential embedded in the remote, and asking which one when a repository has several Azure remotes; names are checked against what Azure really has, and a remote's project is never paired with a different organization's account. `kai integration list` shows every integration's state, `kai azure list` shows accounts with their projects and repositories, `kai azure active --name <project>` switches the folder's active project, `kai azure remove` disconnects the folder, and `kai remove --name <id>` removes an account everywhere (its stored token, the account and every folder's connection; it shows what it will remove and asks first). Sign-in is per user and shared by all folders; each folder has exactly one active project, kept in a private file under `~/.kai/projects/` and never in the repository. Tokens go to the OS secret store (Windows DPAPI, macOS Keychain, Linux Secret Service), never to a repository or an agent config. Connected folders get seven read-only MCP tools (`kai_integration_status`, `kai_work_item_search`, `kai_work_item_get`, `kai_pr_list`, `kai_pr_get`, `kai_build_list`, `kai_build_log`) on the existing `kai mcp` server, while a folder that is not connected sees exactly the tool list it saw before. Text from the service is returned as untrusted data, and responses obey the same byte ceiling and paging as the code tools. The AI CLI providers panel has a new **Integrations** tab with the same actions, including switching the project. The structure is provider-neutral, so another service is a new folder plus one catalog entry. The "no network access, no stored credentials" statements in `SECURITY.md` and `KNOWN_LIMITATIONS.md` now carry this opt-in exception; see `MCP.md` and `USER_MANUAL.md`.
- Redesigned header, fonts and colours: the window now has one header row instead of three: the native title bar is gone (Windows and Linux get minimize / maximize / close buttons at the right end of the tab row; macOS keeps its traffic lights) and the toolbar row is removed. The tab row has a `+ ▾` button that opens a tab with a chosen shell, a search box that opens the command palette, AI providers and Settings icons, and a `⋯` menu for workspaces, Music Time, open-in-editor, git review, splitting, diagnostics and updates. Splitting, closing a pane, search, copy and paste stay on their shortcuts, and copy and paste are now palette actions. The status bar only reports (mode, git branch, directory, the music mini-player while one plays, and an update chip when there is one); the version number and refresh button moved out, since Settings and the `⋯` menu already cover them. Fonts are now bundled: Inter for the interface and JetBrains Mono for the terminal, so the app looks the same on every OS instead of falling back to whatever is installed; settings still on the old default font move to the new one, and a font you picked yourself is left alone. All 8 themes get clearer layering (a darker tab bar and status bar, an active tab that matches its terminal) and more readable secondary and hint text. Menus close on Escape and outside click, move with the arrow keys and return focus to their button. The new window frame has not yet been run on every OS; see `KNOWN_LIMITATIONS.md`.
- a303a36: Faster indexing, especially on Windows. The index builder no longer resolves the real path of every file and folder it walks (about two `lstat` calls per path component each, twice per entry); only symbolic links and junctions are resolved and boundary-checked, exactly as before. On this repository (313 indexed files) a rebuild with nothing changed drops from about 500 ms to about 85 ms and a cold build from about 760 ms to about 340 ms.
- Blank "ghost" window fixes: closing Kai now hides the window immediately and gives terminal cleanup at most 1.5 seconds before the process exits. Before, the window stayed on screen while every terminal was being killed, and on Windows a pseudo-console that blocked on close left a frozen, blank "Not Responding" window. The window also starts in the theme's canvas color (a native window `backgroundColor` plus a static style in `index.html`, kept in step with the theme table by a test) instead of showing a blank white frame until the first paint. This was not reproduced on a running desktop app in development, so please report any window that still goes blank on open or close.
- 440fbe3: The app-drawer / Start-menu click now opens the app on every OS. Linux `.deb`/`.rpm` builds generate the launcher with `Exec=kai`, and when the Node CLI shim (`~/.local/bin/kai`) shadows the GUI binary on PATH the click ran the CLI: it printed the usage text into nowhere and exited, so the app "would not open" (Windows and macOS non-pinned launchers hit the same non-TTY path). A bare `kai` invocation with no TTY (any desktop-launcher or script launch, including piped stdin) now opens Kai Terminal for the current directory instead of printing help; typing `kai` in an interactive shell still prints help, and test environments (Vitest, `NODE_ENV=test`) keep the help behavior so CI smoke probes are unchanged. The Linux bundle ships `packaging/linux/kai.desktop` (wired via `bundle.linux.deb.desktopTemplate` and `bundle.linux.rpm.desktopTemplate`) so `Exec` targets the bundled GUI binary with an `open` fallback regardless of PATH shadowing. `kai doctor` flags a drawer entry resolving to the CLI shim (`execIsCliShim` in the audit) instead of showing a misleading ✓.
- Settings shortcut and command palette fixes: the Shortcuts tab no longer lets you type into a shortcut field (typing used to write `Press shortcut...x` into the binding; the field is now a recorder and Backspace clears it). Settings now rejects a binding on a combination the app handles before user bindings (`Ctrl+Shift+G` for review changes, `Ctrl+T` and `Ctrl+Shift+T` for a new tab), which used to save fine and then never fire; those combinations are listed under the fixed shortcuts. The palette's "Git: Review Changes" shortcut shows `Cmd` on macOS. The manual "Fix Ghost Typing (Reset Terminal Input Modes)" palette entry is removed; the automatic terminal-mode reset after an agent exits is unchanged.
- a303a36: Fix "Update installer not found" when updating inside Kai, on every OS. The check that the downloaded installer is the file Kai itself saved added the `kai-update-` prefix a second time, so it rejected every download (the unit test for it never ran in CI because it was gated behind the desktop feature). The update also now installs the build for the machine's CPU: before, an Apple Silicon Mac or a Windows ARM64 PC could be given the Intel/x64 installer, since the WebView reports the wrong architecture.
- a303a36: Two index fixes. A project that links one directory into another (for example `a/x` pointing at `b`) no longer reads as stale until the next rebuild: the freshness walk now visits directories in the same order as the indexer. TypeScript path aliases now come from the nearest `tsconfig.json` above each file, so packages in a monorepo resolve their own `paths`/`baseUrl` (including through a relative `extends`).
- a303a36: The import graph now sees through barrel files and resolves Python project imports. An import of a name that a barrel (`export { x } from`, `export * from`) or a Python package `__init__.py` re-exports also records the file that defines it, so `kai_get_dependencies`, the reverse import map and caller expansion no longer lose callers that go through a barrel. Python absolute imports of project modules (`from pkg import x`, `import pkg.mod`, including a `src/` layout) now resolve to the indexed file. Existing indexes refresh once.
- a303a36: Better import graph and task detection. TypeScript/JavaScript imports through the root `tsconfig.json` `paths` / `baseUrl` aliases (for example `@/utils`) now resolve to the indexed file, and Python `from . import a, b` links to each of `a.py` and `b.py` instead of only `__init__.py`, so `kai_get_dependencies` and neighbour expansion see those edges. Existing indexes refresh once to pick this up. Task classification now recognises "debug why ...", "review ...", "audit ...", "why does ... crash" and "replace X with Y".
- Azure DevOps and terminal fixes. Integrations: connecting an account for the folder's own organization now makes it active in the same step (a project picker opens when the folder has no matching git remote); every other signed-in account has "Make active"; the picker names the account it is choosing a project in; connecting an organization that is already signed in warns that it replaces that sign-in; the unused Server URL field is gone from the panel (`--server-url` stays on the command line); a personal access token is now explained in the form with an "Open the token page in your browser" button (the backend allow-list gained exactly `https://dev.azure.com/<org>/_usersSettings/tokens`). `kai integration …` and `kai azure …` now run only inside a Kai Terminal tab, except `azure rpc`, which the desktop panel calls itself. Terminal: a hidden tab no longer resizes its shell. The tab's container collapses when hidden and FitAddon derived a 12x5 grid from its stale style, so every tab switch reflowed the shell at 12 columns and left a displaced, garbled prompt; panes now fit and resize the PTY only while on screen. Detection: VS Code's `copilot-shim` answers `--version` with "GitHub Copilot CLI was not found…", which was shown as the version; it is now reported as not installed, and the badge shows only a real version token. The "Windows crashpad registration" noise (`CHROME_CRASHPAD_PIPE_NAME` leaked from an Electron/WebView2 parent) is scrubbed from every shell, editor, browser and probe Kai starts. Layout: Azure DevOps Server accounts now sign in with an access token by default (the Azure CLI's Microsoft Entra tokens are not accepted by an on-premises server), ask for the 7.0 comments preview instead of the 7.1 one, and a signed-out or token-less Server account is told to run `--server-url <address>` instead of a wrong `--org`. Layout: the AI CLI and Settings modals keep their header, tabs and footer at full height, shortcut rows no longer clip or nest scroll boxes, and the AI CLI modal no longer flickers or jumps when it opens.

## 0.2.0

### Minor Changes

- Token-efficient, bounded code retrieval over MCP: files rejected for content (secrets, binary-looking) are remembered (a failed read is retried after a minute), so reads no longer trigger a full re-index and index rewrite on every call; incomplete scans (file-count cap) are reported instead of looking complete. Symbol extraction now handles wrapped signatures, class/impl members and accurate line ranges, and no longer indexes local variables (about 70% fewer symbols on this repo, most of them noise). Every MCP response, including errors, is now bounded in bytes (default 64 KiB, `KAI_MCP_MAX_RESPONSE_BYTES`) with `limit`/`offset` pagination, and change lists are summarised. New `kai_read_range` reads one symbol or line range. `kai_search_code` is now metadata-first: it returns paths, ranges, symbols and hashes, and snippets are opt-in with `includeSource: true` (they used to be on by default, so callers that relied on them must pass it). `kai_get_context` called without `tokenBudget` now starts from a task-type default (about 1,700 tokens for an explanation, never more than the old flat 4,000, overridable with `KAI_CONTEXT_BUDGETS`) and leaves out files scoring far below the best match, listing them as `low_relevance` omissions; an explicit `tokenBudget` behaves as before. When a budget is too tight for the best source, it is shortened on a line boundary instead of dropped, and the package says so. Ranking is based on symbol words weighted by rarity and snippets centre on the best match. Token figures are labelled as heuristic estimates (the old "cl100k" label was inaccurate), and the parsed index is cached in-process.

### Patch Changes

- Remappable terminal keys. Zoom (in / out / reset), copy, paste, select all, clear, scroll top / bottom and tab jump can now be rebound in **Settings → Shortcuts** (new "Terminal keys" group). Defaults are unchanged, conflict detection covers the new keys, and rebinding a key frees its old combo, so moving zoom-out off `Ctrl+-` lets readline undo reach the shell again. `Ctrl/Shift+Insert`, `Shift+PageUp/PageDown` and `Ctrl+Shift+G` stay fixed.
- The project index sees more. Private class properties (`private x`, `#x`) and constructor parameter properties are indexed; Rust `#[path = "..."]` modules, `go.work` workspaces, Python `package-dir` mappings and TypeScript side-effect barrel imports now resolve; re-export chains are followed up to 5 levels (bounded to 64 files per import); Rust trait-impl methods whose type or trait lives in another file are marked exported from the resolved imports (fail-closed); and rename requests such as "X should be called Y" or "X is misnamed, call it Y" are recognised. `KAI_MAX_INDEX_FILES` (100 to 50,000, default 10,000) sets the indexed-file cap. Existing indexes re-extract once.
- Flatpak installs start the host's shell (`flatpak-spawn --host`) instead of the sandbox's, and the working-directory badge follows `cd` in bash. A WSL job was added to CI, and more symlink-dependent tests now run on Windows (directory junctions). Flatpak host shell and the WSL job have not yet run outside unit tests; see `KNOWN_LIMITATIONS.md`.
- `kai_get_context` now treats an identifier you type in full (`cancelOrder`, `format_money`) that names an indexed symbol as the anchor of the request. A file that merely shares one of its split words (a route file called `orders.ts` for `cancelOrder`) no longer outranks the file that defines it, and under the task-aware default budget files matching only on those split words are dropped earlier (listed as `low_relevance`). For refactor, debug, implement and test tasks without an explicit `tokenBudget`, it also adds a bounded, one-hop neighbourhood of the anchored symbol from the import graph: callers (usage excerpts, refactor only) and up to two tests that import its file, labelled in the output and capped; whatever does not fit is reported in an omission entry. "rename X to Y" is now classified as a refactor. Retrieval-only: no model is run, and completion rate is not measured.

- Music Time improvements:

  - **Calls are handled automatically.** While the player is playing and a known call app (Teams, Zoom, Meet, WhatsApp, Phone Link, ...) holds the microphone, music pauses and resumes when the call ends — no Settings entry anymore; music paused before the call stays paused. The old "Pause music during calls" checkbox is gone.
  - **Loop is reliable and no longer restarts the song.** The YouTube embed bakes native `loop=1` in when a track starts with loop on; toggling loop mid-song never rebuilds the iframe (which used to restart playback from zero), and switching loop off on an embed that carries native loop rebuilds it while preserving the playback position.
  - **Favorites.** A heart button in the player controls adds/removes the current song (persisted locally, capped at 50). The "Next playing" drawer now has tabs — **Next Playing** and **Favorites** — and favorites play from the list; each favorite row has its own heart to remove it.

- Fix the brief flash of stale text when switching tabs: a re-shown tab now re-fits, drains output that arrived while it was hidden, and scrolls to the newest line in a layout effect, before the browser paints it, and the GPU renderer is re-attached before the first frame instead of after it.
- Pasting no longer asks for clipboard permission. Ctrl+Shift+V, Cmd+V and Shift+Insert use the native paste, and the toolbar Paste button reads the clipboard through the OS (PowerShell, `pbpaste`, `wl-paste` / `xclip` / `xsel`) instead of the WebView, so the "Allow Kai to see text and images copied to the clipboard?" prompt never appears.
- 22647fe: Reliable in-app updates on every OS. Fix "Update installer not found" on Windows (the downloaded installer was rejected by a trailing-separator path check). Updates now install unattended: Kai closes itself, a detached helper installs the update (Windows `.exe`/`.msi`, macOS `.app` swap from the `.dmg`, Linux `.deb` via polkit or in-place AppImage replace), deletes the downloaded installer once it has finished, and reopens the new version automatically. When no unattended path exists (read-only install location, no `pkexec`) the installer is opened for you as before. Kai also updates through the package type it was installed with (AppImage stays an AppImage, MSI stays MSI).

  The install itself is invisible: no installer windows, and the only progress you see is Kai's own two-step bar ("Downloading 42%", then "Installing in the background"). After the restart Kai tells you whether the update worked ("Kai updated — you are now running vX", or "Update didn't finish" with a Try again button).

## 0.1.7

### Patch Changes

- MCP server renamed to `kai-terminal`, mouse tab drag and smoother terminals: the MCP server now registers as `kai-terminal` instead of `kai`, so it reads clearly in each agent's MCP tool list (Claude Code, Cursor, Codex, Gemini CLI, Copilot / VS Code, Windsurf, opencode, Aider, Antigravity). Existing setups keep working: detection accepts both names, `kai agent add` migrates a legacy `kai` entry (JSON and Codex TOML) to the new name without duplicating tables, and `kai remove -m` / `kai mcp remove` clean up either name. Re-run `kai mcp <agent>` to migrate an old entry.
- Terminal and player polish. Tabs now pick up immediately when you press and drag with a mouse (touch and pen keep press-and-hold, so a swipe cannot reorder by accident). A tab that was hidden while output streamed in is fully repainted and scrolled to the newest lines when shown again, instead of keeping ghost rows. The footer mini-player gains a Previous song button, and the branch badge announces its dirty / clean state to screen readers.
- Internal quality and smoothness release. The app shell is split into focused hooks and components, and each tab's panes are memoized, so footer updates (music progress, git badge) and tab switches no longer re-render every terminal. The CLI is split into per-command modules with shared helpers and an unrecognized command that matches an inherited object key (for example `kai constructor`) now reports "Unknown command" instead of printing garbage. Dead code and unused exports are removed, the music toggle no longer triggers a state update from inside a state updater, and the new App-shell characterization suite plus CLI helper tests raise coverage to 700+ tests. No behavior changes beyond the fixes above.
- Harden YouTube Music search. Parsing result pages can no longer panic on non-ASCII titles (a panic aborted the whole app in release builds), and search queries are URL-encoded correctly so queries such as `AC/DC & Friends` no longer truncate or break the request.
- 7a2d580: Fix "Open in editor" on Windows (PATH lookup no longer picks the extensionless `code`/`cursor` bash shim; the real GUI exe is launched directly, and the `cmd` fallback quotes paths with spaces correctly). Make tab switching smoother: blocking backend commands (git, editor/shell detection, AI CLI probes) no longer run on the UI thread, hidden tabs keep their WebGL renderer briefly so quick tab flips don't rebuild it, and no-op PTY resizes are skipped.

## 0.1.6

### Minor Changes

- c25045c: Close the fixable KNOWN_LIMITATIONS items: live PTY kill tests (`close_pty` / `close_all` verified against the OS process table), symlink-dependent tests now report explicit skips with a reason, freshness detection also compares ctime and re-hashes racily-clean files so same-size edits with restored timestamps are caught, opt-in `kai mcp --watch` / `KAI_MCP_WATCH=1` background graph refresh for pure-MCP clients, and release/CI targets for Linux `.rpm`, Windows ARM64 (NSIS) and macOS Intel.

### Patch Changes

- More terminal shortcuts: `Ctrl+Shift+A` select all, `Ctrl+Shift+K` clear, `Ctrl+Shift+Home`/`End` scroll to top/bottom, `Ctrl+=`/`Ctrl+-`/`Ctrl+0` zoom the font (this session), and `Ctrl+1`–`9` jump to a tab (`Cmd` on macOS). Copy/paste (`Ctrl+Shift+C`/`V`) is unchanged and plain `Ctrl+C` still interrupts. The fixed shortcuts are listed read-only in Settings → Shortcuts.
- c25045c: `kai run` can now launch Windows `.ps1` scripts directly: they run via `powershell.exe -NoProfile -File` (no shell, execution policy respected) instead of failing with `spawn ENOENT`.
- c25045c: Show a notice when a pane split is refused (8-pane cap or the minimum pane size) instead of silently doing nothing.
- c25045c: Fix Changes review dialog sizing: remove the minimize button, resize from any edge/corner like a normal terminal window, and make fullscreen work after a manual resize (the manual size no longer sticks around to override fullscreen). The footer branch badge is now display-only — the git Changes menu is removed.

## 0.1.5

### Patch Changes

- 5619d33: New `kai mcp` command family for the local MCP server and agent wiring

  - `kai mcp <agent|all>` wires an agent (with `--print`, `--dry-run`, `--force`), `kai mcp list` shows server info and connection state, `kai mcp remove <agent>` unwires. Connected agents run the stdio MCP server automatically.
  - `kai list -m` / `kai list --mcp` reports MCP server state and tool connections; `kai remove -m <agent>` / `kai remove --mcp <agent>` disconnects a tool.
  - CLI help regrouped (Outside / Run / Manage / Check) to match the rewritten command reference.
  - Website: command reference grouped by topic (Open and close, Run tool, Setup & MCP, Project graph with init/update/status, Check), dedicated MCP page, floating Topics index with scroll-spy, and an inline GitHub link in the manual hero.

## 0.1.4

### Patch Changes

- **Code Mode Task Planning (`kai_plan_task`)**: Structured task planning engine (`planCodeTask`) with selected-file prioritization, dependency/caller/test expansion, freshness-gated context retrieval, and strict token budget enforcement.
- **Automated Graph Freshness & Lifecycle Sync**: Guaranteed graph synchronization (`runCodeTaskWithAutoSync`, `kai_sync_graph`) on task completion, failure, or cancellation, featuring boundary verification, drift fallback, and concurrent rebuild deduplication with PID locks and generation guards.
- **External Agent Runner (`kai run`)**: Process execution wrapper for external coding agents (`kai run -- <cmd>`), preserving child exit codes, handling timeout (`124`) and cancellation (`130`), enforcing clean process tree termination (SIGTERM -> 2s -> SIGKILL, `taskkill /PID /T /F` on Windows), and triggering automated post-run graph synchronization.
- **Crash Consistency & Dual-Copy Verification**: Atomic persistence with sequential write drift detection (`checkPersistenceConsistency`), synchronized status transitions across `meta.json` and `index.json` (`markProjectGraphStatus`), and automatic rebuild recovery.
- **MCP Freshness Contract & Auto-Refresh**: Graph-dependent reads (`kai_search_code`, `kai_find_symbol`, `kai_get_dependencies`, `kai_get_context`) automatically gate freshness and execute bounded auto-refreshes when stale.
- **GPU WebGL Terminal Renderer**: Integrated hardware-accelerated WebGL terminal renderer (`@xterm/addon-webgl`) for visible terminal panes, running at 60fps with automatic fallback to DOM rendering on context loss or failure, plus `localStorage.kai_renderer="dom"` opt-out.
- **High-Throughput PTY Buffering**: Implemented FIFO `TerminalOutputBuffer` replacing O(n²) string concatenations, providing ~1800× higher throughput during large output floods (~10 MB) without freezing the UI. Increased PTY chunk reads to 32 KB.
- **Auto-Strip AI Co-Authors**: Entering Code Mode (`kai code .`) installs a self-contained, POSIX-compliant `commit-msg` git hook into the target repository to automatically strip `Co-authored-by:` trailers on all future commits while safely preserving pre-existing hooks.
- **Expanded Agent MCP Support (10 Agents)**: Added Antigravity CLI (`agy`) support to the shared agent registry (`src/core/agents.ts`), providing automated MCP wiring (`kai agent setup agy`) and dynamic PATH detection (`kai agent list`).
- **Cross-Platform Path & Shim Hardening**: Windows `.cmd`/`.ps1` shims now resolve to the underlying executable bundle path instead of raw shim tokens; letter-casing path folding on Windows and macOS ensures identical project directories register once; symlink tests skip gracefully in locked-down environments.
- **Zero-Remount Flat Grid Split Panes**: Panes render as absolutely-positioned siblings with stable keys, completely preventing live terminals from unmounting or losing state when opening, closing, or resizing splits.
- **Split Divider Visibility**: High-contrast border-strong tokens ensure split divider lines are clearly visible across all 8 dark and light themes (including Kali theme).
- **Pointer-Based Tab Drag Reorder**: Cross-platform tab drag-and-drop using pointer capture, edge auto-scrolling, midpoint insertion preview, and accidental-click suppression.
- **LSP Framing & Telemetry Rotation**: Byte-accurate `Content-Length` framing in LSP bridge with 8 MB cap; local telemetry (`metrics.jsonl`) automatically rotates at 5 MB.

## 0.1.3

### Patch Changes

- **Windows Agent Detection & PATHEXT Resolution**: Probes PATH using `PATHEXT` to locate `.cmd`/`.bat` binaries, executing version probes cleanly through `cmd /c` without flashing console windows; GUI-based agents safely skip version checks.
- **Status Bar & Code Mode Synchronization**: Real-time git status refresh button in footer; immediate Code Mode status sync upon terminal command execution; compact path display with copy button; footer jump button when Code Mode is active in another directory.
- **Desktop First-Launch CLI Integration**: Desktop installers automatically configure and add the user-level `kai` launcher to user PATH on first startup.
- **CSP & Update Fixes**: Added `connect-src` (`https://api.github.com`, `ipc:`, `http://ipc.localhost`) and `img-src data:` to Content Security Policy in `tauri.conf.json`; release links open in external OS browser.
- **Default Theme & Tab Color Polish**: Resolved tab accent glow obscuring custom tab colors; synchronized Kali theme as default across frontend and backend; added `kai doctor` to audit Linux `.desktop` launcher entries.

## 0.1.2

### Patch Changes

- Reorder footer status bar items to display active path first, followed by code mode, then git status and actions.

- 0a715fd: Automatic agent registration: `kai agent setup <agent>` now installs kai MCP wiring directly into the agent's own config file (JSON merge with `.kai.bak` backup, idempotent re-runs, `--dry-run`/`--force`/`--print` flags) instead of only printing a snippet. New `kai agent setup all` wires every system-installed agent at once, `kai agent register` aliases setup, and `kai agent list` reports per-agent kai wiring state. The desktop AI providers panel shows wiring status with one-click Auto-wire backed by new `setup_agent_mcp_cmd` / `get_kai_cli_launch_cmd` IPC commands. Aider and opencode use verified config shapes (`mcpServers` in `~/.config/aider/mcp.json`, `mcp` local entry in `~/.config/opencode/opencode.json`).
- 0a715fd: Slim toolbar and footer: removed the toolbar New Session button (use TabBar + / Ctrl+Shift+T), the Recent dropdown, the top git badges, the top Code Mode pill, and the Clear button — git branch, project directory, and Code Mode (now an explicit exit toggle button) live only in the bottom status bar. AI providers panel: dropped per-provider Auto-wire buttons (kai wiring is auto-detected read-only), redesigned provider cards with proper spacing, added a Re-detect button. Detection fix: desktop probing now also covers well-known install locations (`~/.local/bin`, `~/.opencode/bin`, `~/.cargo/bin`, nvm node bins, `/usr/local/bin`, …) so GUI launches with a minimal PATH still find user-installed CLIs, added the `agy` CLI to the catalog plus extra binary aliases (`claude-code`, `cursor-agent`, `opencode2`, `github-copilot`).
- Refine split terminals: remove per-split pane headers, display active terminal directory as selectable text in footer status bar, sync Code Mode and Git status on pane click, and replace borders with a subtle 1px hairline separator.

## 0.1.1

### Patch Changes

- 1257891: Expand AI coding agent ecosystem and harden MCP stream and retrieval staleness:
  - Add verified agent setup generators for Gemini CLI, GitHub Copilot (VS Code), Windsurf, and Cline alongside Claude Code, Cursor, and Codex (`kai agent setup <agent>`).
  - Expand Rust desktop AI CLI auto-detection catalog to 6 tools (`codex`, `claude`, `gemini`, `opencode`, `copilot`, `aider`) with non-intrusive local auth checks.
  - Add stream-level `BoundedLineTransform` to MCP stdio server to reject oversized requests (>10MB) before buffer accumulation.
  - Add real-time file staleness detection in context retrieval comparing live disk SHA-256 with index metadata.
  - Track inode change timestamps (ctimeMs) alongside mtime and size in indexer.
  - Support orphaned project index cleanup by 16-hex hash ID when meta.json is missing or corrupted.
  - Enforce strict allowlist for `kai config get` keys, bound task classifier inputs to 4,000 characters, and validate LSP command names.
  - Ensure prototype-safe index maps (`Object.create(null)` + `hasOwnProperty` guards) and POSIX path normalization across platforms.
  - Update documentation (README, SECURITY, KNOWN_LIMITATIONS, ARCHITECTURE, INSTALL) and website components to reflect expanded agent support, catalogued CLIs, and streaming/staleness boundaries.
- d22f36e: Enhance customization, app branding, and release standardization:
  - Redesign app and website icons with a 1024x1024 high-contrast flat vector terminal prompt (`>_`) on a near-black navy canvas with emerald and cyan accents.
  - Modernize terminal settings dialog into a structured 4-tab interface (Appearance, Font & Display, Shell & Tools, Shortcuts).
  - Add system-based and popular monospace font selection dropdown with real-time typography preview.
  - Add terminal background opacity slider (20%-100%) with dynamic rgba background rendering and expanded theme gallery (Nord, Tokyo Night).
  - Support configurable code editor selection with automated tool detection and custom binary paths.
  - Add interactive keyboard shortcut recording with conflict resolution.
  - Standardize all downloadable release filenames to lowercase (`kai_0.1.0_*`).
  - Fix Linux WebKitGTK dropdown visibility by enforcing `color-scheme: dark` and explicit option styling.
- d404981: Clean and professionalize release download interface and update deployment URL:
  - Modernize Releases & Direct Downloads section with a stacked, executive-grade card architecture for Apple (macOS), Linux, and Windows.
  - Remove emoji clutter and extraneous icons from platform filters and headings for a sleek developer-tool aesthetic.
  - Add direct installer cards with format tags, file descriptions, architecture badges, and download triggers.
  - Update live site deployment URLs to `https://kai-terminal.vercel.app/` across canonical tags, OpenGraph metadata, sitemaps, robots.txt, and project documentation.
- 92fc5ba: Fix Tauri IPC command macro name collisions (E0255) and import missing `tauri::Manager` trait for state resolution (E0599).
- f1a7926: Enhance group-wise release architecture and direct download pipelines:
  - Implement structured group-wise releases ordered strictly across Apple (macOS), Linux, and Windows platforms with dedicated architecture badges and format indicators.
  - Provide direct installer download paths for Apple Silicon macOS (.dmg), Linux x86_64 and ARM64 packages (.deb and portable .AppImage), and Windows 64-bit installers (NSIS .exe and MSI).
  - Add interactive platform filtering, command-line quick-install snippets with copy controls, and system prerequisites/security guidance (macOS Gatekeeper xattr, Linux FUSE 2, Windows WebView2 runtime).
  - Elevate website changelog presentation with categorized release highlights for v0.1.0, latest release badges, and structured parsing of pending unreleased changesets.
  - Synchronize marketing hero quick download pills and installation bar platform order to Apple (macOS), Linux, Windows, and From source.
- d01d25f: Harden intelligence subsystem: early rejection of unknown MCP tools, strict two-pass token budget enforcement, short-symbol search fallback, safe Windows MCP agent setup path escaping, and first-run CLI config directory creation.
- e6c5844: Independent production audit and security release gate fixes:
  - Fix npm package distribution: add files whitelist and prepack script to guarantee CLI bundle in published tarballs.
  - Resolve critical symlink escape vulnerability in loadProjectRules and loadIgnorePatterns with realpath boundary verification and size bounding.
  - Harden secret detection with PKCS#8 private keys, fine-grained GitHub PATs, and Anthropic/OpenAI API keys.
  - Enforce MCP workspace boundary confinement to prevent unauthorized project directory access.
  - Demarcate untrusted context boundaries and add safe code fence dynamic backtick escaping in context templates.
  - Improve retrieval ranking: filter common task stop words from partial symbol matches, add singular/plural stem matching, and extract constant/variable symbols.
  - Harmonize benchmark evaluations for equivalent condition testing across configs.
  - Support flexible flag ordering in CLI unregister command.
- Handle terminal process exit cleanly without error:
  - Prevent BrokenPipe and SessionNotFound race conditions during shell exit in PTY backend.
  - Catch unhandled promise rejections on window resize, paste, and disconnect events.
  - Automatically close split panes and secondary tabs when the shell process exits with status 0.
  - Allow restarting a disconnected single-session terminal by pressing Enter.

All notable changes to **Kai Terminal** (`kai-terminal`) will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Added

- **Clean Professional Release Interface & Domain Migration**:
  - Transitioned website deployment URL to `https://kai-website-jet.vercel.app/` across all meta tags, canonical links, and documentation.
  - Redesigned Releases & Direct Downloads with stacked, professional container boxes for Apple (macOS), Linux, and Windows.
  - Eliminated emoji icons from platform switcher tabs and headings for a clean, developer-focused aesthetic.
  - Structured installer package cards featuring format badges, architecture pills, and direct download actions.
- **Structured Group-Wise Release Architecture**:
  - Organized release matrix into structured groups: **Apple (macOS)**, **Linux**, and **Windows**.
  - Direct download pipelines for Apple Silicon macOS (`.dmg`), Linux x86_64 and ARM64 (`.deb`, `.AppImage`), and Windows 64-bit (`.exe` NSIS and `.msi`).
  - Terminal quick-install snippets with copy controls and system requirements for each operating system.
  - Interactive platform filter switcher on website and download pages.
- **AI Agent Ecosystem Expansion**:
  - Verified agent setup generators for Gemini CLI, GitHub Copilot (VS Code), Windsurf, and Cline (`kai agent setup <agent>`).
  - Expanded Rust desktop AI CLI auto-detection catalog to 6 tools (`codex`, `claude`, `gemini`, `opencode`, `copilot`, `aider`) with non-intrusive local auth checks.
- **MCP Streaming & Staleness Hardening**:
  - Stream-level `BoundedLineTransform` to reject oversized MCP stdio requests (>10MB) before buffer accumulation.
  - Real-time file staleness detection in context retrieval comparing live disk SHA-256 against index metadata.
  - Inode change timestamps (`ctimeMs`) tracked alongside `mtime` and size in AST indexer.
  - Orphaned project index cleanup by 16-hex hash ID when `meta.json` is missing or corrupted.

### Fixed

- **Security & Confinement**:
  - Symlink boundary validation in `loadProjectRules` and `loadIgnorePatterns` preventing escape beyond project roots.
  - Secret scrubbing for PKCS#8 private keys, fine-grained GitHub PATs, and Anthropic/OpenAI API keys.
  - MCP workspace boundary confinement preventing unauthorized access to external project directories.
  - Safe dynamic backtick fence escaping in context templates.
- **Tauri IPC Command Visibility**:
  - Resolved macro name collisions (E0255) and imported missing `tauri::Manager` trait for state resolution (E0599).

---

## [0.1.0] - 2026-10-11

### Added

- **Native Rust Portable-PTY Core**:
  - Native pseudoterminal integration via `portable-pty` crate.
  - ConPTY subsystem support on Windows 10/11 with sub-millisecond ANSI throughput.
  - POSIX pty streaming on macOS and Linux with isolated per-tab process trees.
- **GPU Canvas Terminal Rendering**:
  - Tauri 2 desktop shell with GPU-accelerated `@xterm/xterm` canvas renderer running at 60fps.
  - ~30MB idle RAM footprint (10× lighter than Electron-based terminals).
  - Split pane layouts (up to 4 panes per tab) with independent cwd and pty channels.
- **Project Intelligence & Model Context Protocol (MCP)**:
  - Local AST symbol graph indexing (TypeScript, JavaScript, Python, Rust, Go).
  - Deterministic context retrieval with sub-10ms query latency and ~70% token savings.
  - Stdio JSON-RPC MCP server adhering to Model Context Protocol specification.
- **One-Command Agent Integrations**:
  - Automatic MCP configuration generators for Claude Code, Cursor, and Codex CLI.
- **Cross-Platform Native Artifacts**:
  - Apple Silicon macOS disk image (`Kai_0.1.0_aarch64.dmg`).
  - Linux Debian/Ubuntu packages (`kai_0.1.0_amd64.deb`, `kai_0.1.0_arm64.deb`).
  - Linux portable AppImages (`kai_0.1.0_amd64.AppImage`, `kai_0.1.0_arm64.AppImage`).
  - Windows installers (`Kai_0.1.0_x64-setup.exe`, `Kai_0.1.0_x64_en-US.msi`).
