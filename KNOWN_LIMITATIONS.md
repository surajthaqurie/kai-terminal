# Known Limitations

This document lists the operating system boundaries, terminal constraints, and intentional design limits of Kai Terminal. Resolved defects, completed features and items that CI has since verified are removed to keep this document concise and actionable.

---

## Platform and Operating-System Limitations

### 1. Windows 7 / 8 / 8.1 Unsupported
- **Cause:** Windows ConPTY APIs were introduced in Windows 10 (build 17763 / version 1809). Older Windows releases lack native pseudo-console support.
- **Behavior:** Kai Terminal checks host build versions at startup (`MIN_SUPPORTED_WINDOWS_BUILD = 17763`). Unsupported versions return a typed `TerminalError::PtyCreationFailed` with actionable upgrade instructions.
- **Status:** Intentional design restriction.

### 2. Operating System Global Shortcuts
- **Cause:** Host operating systems reserve specific global hotkeys (e.g., `Cmd+Space` on macOS, `Win+L` or `Ctrl+Alt+Del` on Windows) at the kernel/window-manager level.
- **Behavior:** Webview applications cannot intercept or override host-reserved system shortcuts.
- **Workaround:** Configure alternative application shortcuts in Settings → Shortcuts. Kai's own defaults avoid `Ctrl+Alt` (AltGr on Windows) for this reason.

### 3. Windows File Symlink Privileges
- **Cause:** Windows requires Developer Mode or elevated (Administrator) privileges to create file symlinks (`EPERM`).
- **Behavior:** Directory symlinks use NTFS junctions (which require no special privileges). File symlinks gracefully skip in unit tests on Windows without Developer Mode, reporting explicit Vitest skip reasons (`symlinkOrSkip`).
- **Untraversable junctions:** Some Windows builds (seen on 11 build 26300) create a junction but then refuse to follow it in every process (`The path cannot be traversed because it contains an untrusted mount point`, surfaced by Node as `UNKNOWN`). The link tests detect this and skip with a reason rather than fail; project indexing and `kai_read_range` already treat such a path as unreadable (fail closed). The same tests run on the Linux and macOS CI runners.
- **Workaround:** Enable Developer Mode in Windows Settings if file symlink creation is required.

### 4. Custom Window Frame
- **Cause:** The native title bar is replaced by the tab row (`decorations: false` on Windows and Linux, an overlay title bar with the native traffic lights on macOS via `src-tauri/tauri.macos.conf.json`). Minimize, maximize and close are drawn by Kai on Windows and Linux.
- **Behavior:** On Windows 11, hovering the maximize button opens the snap-layouts popup (Kai keeps an invisible window over the button so Windows treats it as a native one). Dragging to a screen edge also snaps. The empty strip of the tab row moves the window and a double-click maximizes it.
- **Verification:** Hover and a quick click were run on Windows 11 build 26300. A first click while the popup is already open was not reliable when driven by injected input, so please report it if that does not maximize. Dragging, edge resizing, snapping and the macOS traffic-light spacing have not been run on every OS yet.

### 5. macOS Microphone Attribution
- **Cause:** macOS CoreAudio permissions report whether audio input is active, but do not attribute microphone streams to specific application processes.
- **Behavior:** Music Time pauses when audio input is active and a known native conferencing application is running. Browser-based calls (e.g., Google Meet) cannot be reliably distinguished from other browser microphone usage on macOS.
- **Status:** Operating system privacy boundary.

---

## Terminal and Process Limitations

### 1. Unix Canonical Line Mode Buffer (4,096 bytes)
- **Cause:** The Unix kernel tty line discipline enforces a standard 4,096-byte line buffer for cooked/canonical input.
- **Behavior:** Uncommitted input exceeding 4,096 bytes in canonical mode is capped by the OS kernel. Byte-exact streaming (`write_bytes_chunked`) delivers arbitrary chunk sizes, but interactive shells requiring long uncommitted lines must switch to raw mode.
- **Status:** Standard Unix kernel behavior.

### 2. Pane Count Limit and Minimum Split Floor
- **Cause:** Unbounded terminal splitting leads to severe UI rendering contention and illegible terminals.
- **Behavior:** Kai Terminal enforces a hard ceiling of 8 split panes per tab (`MAX_PANES_PER_TAB = 8`) and a minimum split extent floor of 1/8 pane area (`MIN_SPLIT_EXTENT`), refusing splits that would result in unusable terminals.
- **Status:** Intentional design restriction.

### 3. Programs That Deliberately Leave a `kai run` Command
- **Context:** When `kai run` stops a command on a timeout or Ctrl+C, every process the command started is stopped too, including ones that detached. On Linux and macOS each run carries a random token in its environment and every process still carrying it is stopped. On Windows the command runs inside a Job Object, created by the desktop app's binary, and the whole job is stopped.
- **Boundary:** A program can still opt out on purpose. On Linux and macOS, one that starts a child with a cleared environment (`env -i`) drops the token. On Windows, one that asks to leave the job (`CREATE_BREAKAWAY_FROM_JOB`) is allowed to, so such programs keep working. A `kai` CLI installed from npm without the desktop app has no Job Object helper and falls back to `taskkill /T`, which misses detached processes. In each of these cases `kai run` reports `descendantsMaySurvive` and treats freshness as point-in-time.
- **Verification:** The Windows job is tested on Windows 11 with the shipped (windowed) release binary: a grandchild whose launcher already exited is stopped, and CI runs this on every Windows build. The Linux behavior is tested with real detached processes in a Linux container. The macOS lookup (`ps -E`) is covered by unit tests on its output only, not run on a Mac.

### 4. Very Large Pastes
- **Behavior:** Pastes of any size are sent to the shell in ordered 256 KB pieces, and keys typed meanwhile wait until the paste is done. How fast a multi-megabyte paste is consumed depends on the program reading it, and in canonical line mode the 4,096-byte line limit above still applies.

---

## Feature Boundaries

### 1. Local-Only Persistence
- **Context:** Workspaces, tab layouts, settings, and project indexes are stored strictly in local browser storage (`localStorage`) and `~/.kai/projects/`.
- **Boundary:** Kai Terminal includes no remote synchronization service, cloud storage, or telemetry export by design. Keystrokes, terminal history, scrollback logs, and environment variables are never stored to disk or transmitted over the network. The one opt-in exception is an external-service sign-in (`kai integration azure`), described in limitation 8 below.

### 2. Local AI CLI Diagnostics (No Network Verification)
- **Context:** The AI CLI diagnostics panel discovers installed AI tools via local executable detection (`PATH`), direct bounded `--version` probes, and local configuration file presence (`auth_status: config_present`).
- **Boundary:** Passive diagnostics never verify credentials over the network or make billable API calls. A successful `--version` probe or present config file does not guarantee valid credentials or network reachability.
- **Version Gating:** The version gate (`unsupported_version`) is implemented and tested, but `MIN_SUPPORTED_VERSIONS` is kept empty until vendors publish verified minimum version floors.

### 3. Local Language Server Requirement
- **Context:** Project intelligence (symbol extraction, import resolution, and context retrieval) operates via deterministic AST-free pattern parsing.
- **Boundary:** Deep cross-file type inference requires locally installed language server binaries (`typescript-language-server`, `rust-analyzer`, `pyright`, `gopls`). If missing or if the server exits prematurely, analysis falls back immediately to deterministic heuristic parsing without blocking.

### 4. Token Counts: Exact for OpenAI Models, Estimated Otherwise
- **Context:** Context budgeting and token metrics are character-class heuristic estimates (`isEstimate: true`) unless a tokenizer produced the number. Kai bundles the OpenAI BPE vocabularies (`o200k_base` for GPT-4o, GPT-4.1, GPT-5 and the o-series; `cl100k_base` for GPT-4 and GPT-3.5), loaded on first use, and `estimateModelTokensAsync(text, model)` returns exact counts for those models (`isExact: true`, `tokenizerName: bundled-...`), and `estimateChatTokensAsync(messages, model)` adds the chat-format framing. `kai_get_context` takes an optional `model`; with an OpenAI model it sizes the context with that tokenizer.
- **Boundary:** Models without a public offline tokenizer (Claude, Gemini, Llama and others) keep the labeled estimate unless an adapter is registered with `registerModelTokenizer` or `registerCustomTokenizer`. Counts without a model name, including `kai_get_context` called without `model`, are estimates; Kai cannot tell which model an agent uses unless the agent passes it. The bundled vocabularies add about 3.7 MB to the CLI and the desktop app; they are loaded only when an OpenAI model is named. The estimate is conservative: about 1.3 to 1.4 times the OpenAI token count on code and Markdown, measured on this repository's source (no file counted lower than the real tokenizer).

### 5. Fail-Closed Secret Filtering
- **Context:** Project indexing and MCP range reads enforce strict realpath confinement and pattern-based secret filtering (`sensitive_content`).
- **Boundary:** Files matching secret-detection patterns (credential files, and any file that contains something that looks like a real key or token) are rejected. Files excluded by this filter cannot be retrieved by MCP tools. Obvious placeholders do not count, so documentation and test fixtures stay readable. These are documented example keys (`...EXAMPLE`), `xxxxxxxxxxxx`, `REDACTED`, `placeholder`, `dummy`, and runs such as `abcdefg` or `1234567`. Only the value is judged, never the variable name in front of it, and a setting name such as the AWS secret key's always counts.

### 6. System Git Requirement
- **Context:** The status bar Git badge relies on machine-readable Git plumbing commands (`rev-parse`, `status --porcelain`) executed with strict 8-second timeouts.
- **Boundary:** If `git` is absent from `PATH`, the status badge displays an informative error without affecting terminal functionality.

### 7. Per-Terminal Code Mode Signal
- **Context:** Code Mode is scoped to one terminal: `kai <agent>` announces start and end on its own output as a private `OSC 1337` sequence (`src/core/codeModeSignal.ts`) and the pane that receives it shows the Code Mode pill. No shared state is read by the footer.
- **Verified:** The real CLI's signal arrives intact and in order through Windows 11 ConPTY (build 26300), through a Linux PTY, and through the real xterm.js parser (including a signal split across output chunks).
- **Boundary:** Older Windows builds whose ConPTY may drop escape sequences it does not recognise, and macOS, have not been tested; there the pill would simply stay on "Terminal". A `kai` CLI older than the app does not send the signal.

### 8. External Service Integrations (Azure DevOps)
- **Context:** `kai integration azure` connects a project to Azure DevOps. Its read tools are listed only for connected projects (see `MCP.md`). Six write tools (comment on a work item, create a work item, change its state, change its fields, open a pull request between existing branches, comment on a pull request) are off by default and appear only after you run `kai integration azure --allow-writes` for that folder. They never create branches, merge or delete.
- **Boundary:** Azure DevOps Services and Azure DevOps Server projects are detected from git remotes; a Server remote must be an HTTPS address of the form `https://<host>/<collection>/<project>/_git/<repo>`. A Server SSH remote does not give the web address: Kai asks the likely addresses (`https` and `http`, with and without a `/tfs` virtual directory, and the classic port `8080` or `8443`) whether an Azure DevOps Server answers there, sending no credentials, and offers the one that does, always asking before signing in; when none answers (or the server is on another port or virtual directory), it falls back to its `https://<host>/<collection>` guess and `--server-url` names the real address. The check recognizes a server by the `X-TFS-` / `X-VSS-` headers it sets on an unauthenticated request, and has only been run against a fake server. The desktop Integrations tab sets up both Services and Server (the **Azure DevOps Server...** form takes the server URL with its collection, an optional project and an access token). Server support, including that form, has not been run against a real server (it uses REST API 7.0, including the 7.0 comments preview, chosen from Microsoft's API reference and tested against a fake server only). Azure DevOps Server signs in with an access token, never the Azure CLI, because on-premises servers do not accept the Microsoft Entra tokens `az` issues.
- **Boundary:** The merge branch and the branch naming pattern (the **More** link on the Azure DevOps card) are guidance for agents, returned by `kai_workflow_rules`. The pattern is a regular expression checked only for being valid when you save; Kai installs no git hooks and never checks a branch name, or validates or blocks a commit, push or merge, and it creates no branch or pull request itself: the agent runs `git` (and, if it chooses, `az repos pr create`). The branch list comes from the repository over the network, so with no connection the list is empty and a branch typed earlier is kept as saved. It is set from the desktop card or with `kai integration azure --merge-branch` / `--branch-pattern`, per folder, and needs a current `kai` on PATH.
- **Boundary:** The desktop Integrations tab runs the `kai` CLI bundled with the app. Installers from the release workflow carry their own Node.js for it (`scripts/fetch-node.mjs`); a build from source has none and needs Node.js 20 or newer on PATH, falling back to a `kai` on PATH that may be older than the app and then says it did not understand the request. The packaged Node.js, and its macOS signing step, have not been run in a release build yet.
- **Boundary:** Azure CLI sign-in needs `az` installed. On macOS and Linux the app asks your login shell for its PATH at startup (skipped when you start it from a terminal), so `az` is found as it is in a terminal; that lookup is unit-tested but has not been run on a real macOS or Linux desktop launch. Access tokens go to the OS secret store.
- **Boundary:** The macOS Keychain and Linux Secret Service paths are unit-tested with a fake runner, not run on those systems; Windows DPAPI is tested for real. Requests are built to the public Azure DevOps REST API and tested against a fake server, not yet against a live organization.
- **Boundary:** Write tools were tested against a fake server only, not a live organization. A personal access token needs Work Items and Code: Read & write; browser and Azure CLI sign-ins use your own permissions. Turning writes on is refused inside an AI agent's session by a process-tree and environment check. That check is guidance, not a sandbox.

### 9. Microsoft Teams Chat (`kai teams`)
- **Context:** `kai integration teams` signs you in with your Microsoft account and `kai teams` shows your teams, channels and chats in the terminal, through Microsoft Graph with your own permissions. It is not an MCP integration: no agent tool exists for it.
- **Boundary:** Sign-in needs a Microsoft Entra app registration. A build carries an app ID only when the `KAI_TEAMS_CLIENT_ID` (or `KAI_AZURE_CLIENT_ID`) repository variable was set when it was built (`release.yml` bakes it in); the source holds none. With a build that has none, each person registers a (multi-tenant, public-client) app once and runs `kai integration teams --client-id <ID>` (or pastes it when asked); it is saved in `~/.kai/config.json`. Order: `KAI_TEAMS_CLIENT_ID` in the environment, the saved ID, a built-in Teams ID, then the Azure DevOps registration. With none of them, sign-in stops with "Microsoft Teams sign-in is not set up yet". The desktop card has a field to paste the ID, which saves it the same way. See `docs/teams-sign-in.md`.
- **Boundary:** The chat itself (`kai teams`) is only in a terminal tab. The Microsoft Teams card is covered by unit tests with a fake CLI, not run against a live Microsoft 365 tenant.
- **Boundary:** Reading what others wrote in a channel needs `ChannelMessage.Read.All`, which most organizations require an administrator to approve. Sign-in asks for it by default and, when Microsoft says an administrator has to approve it, repeats the sign-in once without it. That fallback is covered by tests with a fake browser; it has not been run against a tenant that blocks the permission. If Microsoft shows its approval page without returning to Kai, cancel the sign-in on the desktop card and choose **Sign in without channel messages**; that option appears only after a cancelled sign-in. In a terminal there is no cancel button: press Ctrl+C, or the sign-in gives up after 5 minutes. Without the permission, chats and sending to a channel work and reading a channel shows a note; `kai integration teams --channels` signs in again after approval.
- **Boundary:** A file you send can be at most 2 GB, with at most 4 items per message. Files up to 4 MB are held in memory; a larger file is read from disk 5 MiB at a time while it uploads to your OneDrive (resumed if the connection drops), so memory does not grow with its size. If the file is moved, deleted or shortened while it uploads, the upload stops and the half-uploaded file is removed. A picture is shown inline in the message only up to 4 MB; a larger one is sent as a link. Images are drawn inline in the terminal only where it supports it (iTerm2, WezTerm, mintty, Kai Terminal) and only as PNG, JPEG or GIF; elsewhere they open in your image viewer.
- **Boundary:** The agent guard refuses to run `kai teams` inside an AI agent's session by checking the process tree, environment markers and the interactive terminal. It is not a sandbox: a program running as the same operating-system user can in principle ask the OS to decrypt that user's stored secrets, as with any desktop app's sign-in.
- **Boundary:** Graph requests are covered by unit tests against fake responses; this has not been verified against a live Microsoft 365 tenant, and the macOS Keychain and Linux Secret Service paths are not run on those systems.

### 10. Music Mini Player (Picture-in-Picture)
- **Context:** The music player's pop-out button moves the YouTube video into a small always-on-top window. The main window keeps the queue, history and shortcuts and drives the mini window over app events.
- **Boundary:** The mini window exists only in the desktop app, not in a browser tab. The mini window has to load its own YouTube embed. While it loads, a playing song keeps playing from the player's embed, which is hidden. The mini window's embed loads muted and takes over at the same spot once it plays (after 8 s at most), so there is no silent gap. The player keeps its embed loaded and paused while the mini window is open, so bringing the video back is a seek and play, not a reload. If the song changed while the video was in the mini window, the player rebuilds its embed at the current position.
- **Boundary:** On macOS and Linux the app's page is `tauri://localhost`, an origin YouTube refuses commands from. There the player hosts YouTube inside a small local page served by the app on `http://localhost:<random port>` (`src-tauri/src/music_relay.rs`), which passes commands and reports through. YouTube refuses to play inside a page addressed as `127.0.0.1` (error 150), so the name must be `localhost`. The relay was tested end to end against real YouTube in a Chromium engine (Edge) on Windows: commands reach the video and its reports come back. It has not been run inside the macOS (WebKit) or Linux (WebKitGTK) webviews. The app uses the relay only after the relay page confirms it loaded inside the app. If a webview refuses to frame it, the player keeps the previous behavior: YouTube's own controls, and a reload with a short gap when moving between windows.
- **Boundary:** On Windows the app allows video with sound to start without a click (`--autoplay-policy=no-user-gesture-required`), because the mini window is a new page nobody has clicked in. The arguments are written once, in `tauri.windows.conf.json`; the mini window reads them from there at compile time, because WebView2 refuses a window whose arguments differ from the main window's. macOS and Linux webviews allow autoplay by default in the web view library Kai uses, so they need no switch; if one blocks the video anyway, it stays paused until you press play.
- **Verification:** Covered by unit tests, a TypeScript check and `cargo check` on Windows. Dragging, transparency (on macOS it uses Tauri's private API, so the app cannot ship through the Mac App Store; it is distributed as a `.dmg`), autoplay, the remembered position and size, and the exact resume of a paused song (a muted seek then pause; the commands are tested, YouTube's reaction is not) have not yet been run by hand on every OS, so please report anything that does not behave as described.

