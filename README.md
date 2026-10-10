# Kai Terminal

[![CI](https://github.com/surajthaqurie/kai-terminal/actions/workflows/ci.yml/badge.svg)](https://github.com/surajthaqurie/kai-terminal/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Download](https://img.shields.io/github/v/release/surajthaqurie/kai-terminal?label=download)](https://github.com/surajthaqurie/kai-terminal/releases/latest)

> One terminal. Every platform.

A modern cross-platform terminal for Windows, Linux, and macOS. Built using Tauri 2, Rust (`portable-pty`), React, TypeScript, and xterm.js.

Kai runs locally without requiring cloud accounts, telemetry, or runtime dependencies like Node.js or Rust after installation. Optional AI coding tools (such as Claude Code, Gemini CLI, or Codex) can be detected and run directly inside any tab if already installed on your machine.

---

## Features

- **Native PTY & Split Panes:** Real pseudo-terminal sessions per pane. Supports up to 4 split panes per tab (horizontal and vertical) with drag-to-resize support.
- **Tabs & Workspaces:** Multi-tab interface with inline double-click tab renaming and saved session layouts.
- **Shell Auto-detection:** Automatic detection of PowerShell, CMD, and WSL on Windows, and `$SHELL`, bash, zsh, fish, and sh on Linux/macOS. Supports custom shell paths.
- **Customization & Shortcuts:** Persistent themes (Catppuccin, One Dark, Dracula, Solarized), configurable fonts, customizable keybindings, and a command palette (`Ctrl+Shift+P`).
- **Editor Launching:** Quickly open your project directory in editors like VS Code, Cursor, VSCodium, Sublime Text, or Zed.
- **Git Status Indicator:** Real-time branch name and dirty status badge, with actions to fetch, pull, or view status.
- **Optional AI CLI Panel:** Checks local PATH presence for AI coding tools (Claude Code, Gemini CLI, Codex, or custom executables) and displays version status without sending data outside your machine.

---

## Supported Platforms

| Operating System | Architecture | Package Formats | Status |
| :--- | :--- | :--- | :--- |
| **Linux (Ubuntu 22.04+)** | x86_64 | `.deb`, `.AppImage` | Verified on native runner |
| **Linux (Ubuntu 24.04+)** | ARM64 | `.deb`, `.AppImage` | Verified on native runner |
| **Windows 10/11** | x86_64 | `.exe` (NSIS), `.msi` | Verified on native runner |
| **macOS 12+** | Apple Silicon (ARM64) | `.dmg` | Verified on native runner |

---

## Downloading Installers

Pre-built binary installers are automatically published to [GitHub Releases](https://github.com/surajthaqurie/kai-terminal/releases/latest) when a version tag is created:

- **Linux:** Download `.deb` or `.AppImage`
- **Windows:** Download `.exe` or `.msi`
- **macOS:** Download `.dmg`

*Note: If no release files are listed yet on GitHub Releases, push a release tag (`v0.1.0`) to trigger the build workflow, or follow the build instructions below to build locally.*

---

## Quick Start (Building from Source)

### Prerequisites
- **Node.js**: v20 LTS or higher
- **Rust**: 1.75 or higher
- **Linux system dependencies** (Debian/Ubuntu/Kali):
  ```bash
  sudo apt-get update && sudo apt-get install -y \
    build-essential pkg-config libssl-dev \
    libwebkit2gtk-4.1-dev libgtk-3-dev \
    libayatana-appindicator3-dev librsvg2-dev
  ```

### Development Commands

1. **Clone the repository and install dependencies:**
   ```bash
   git clone https://github.com/surajthaqurie/kai-terminal.git
   cd kai
   npm install
   ```

2. **Run desktop app in development mode (with hot reload):**
   ```bash
   npm run tauri dev
   ```

3. **Run frontend preview in browser (mock PTY mode):**
   ```bash
   npm run dev
   ```

4. **Build ready-to-install release binaries locally:**
   ```bash
   npm run tauri build
   ```
   Built packages will be placed in `src-tauri/target/release/bundle/`.

---

## Testing & Quality Checks

Run the verification suite before committing changes:

```bash
# Frontend type checking, formatting, and unit tests
npm run check

# Rust backend formatting check, linter, and tests
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --no-default-features --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --no-default-features --manifest-path src-tauri/Cargo.toml --lib
cargo test --no-default-features --manifest-path src-tauri/Cargo.toml --test pty_integration_tests
```

Detailed test plan and results: [TEST_PLAN.md](TEST_PLAN.md).

---

## Documentation

- [INSTALL.md](INSTALL.md) — Detailed installation instructions for Linux, Windows, and macOS.
- [DEVELOPMENT.md](DEVELOPMENT.md) — Architecture outline, project layout, and contributor guide.
- [ARCHITECTURE.md](ARCHITECTURE.md) — Technical overview of IPC design and PTY streaming.
- [SECURITY.md](SECURITY.md) — Process launching guardrails, permissions, and security policies.
- [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md) — System boundaries and platform constraints.
- [TEST_PLAN.md](TEST_PLAN.md) — Verification matrix and integration test suite details.

---

## License

MIT License — see [LICENSE](LICENSE). Free for personal and commercial use.
