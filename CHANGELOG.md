# Changelog

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
