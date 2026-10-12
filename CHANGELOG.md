# Changelog

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
