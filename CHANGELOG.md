# Changelog

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
