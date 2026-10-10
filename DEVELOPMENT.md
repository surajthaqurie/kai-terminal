# Development & Setup Guide

This guide details how to set up your environment, run the codebase locally, verify changes, and understand the project structure.

---

## 1. System Requirements

### Runtimes & Tools
- **Node.js**: v20 LTS or higher
- **npm**: v10 or higher
- **Rust**: 1.75.0 or higher (`rustc`, `cargo`)

### OS Build Dependencies

| Platform | Required Packages |
| :--- | :--- |
| **Linux (Debian/Ubuntu/Kali)** | `build-essential`, `pkg-config`, `libssl-dev`, `libwebkit2gtk-4.1-dev`, `libgtk-3-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev` |
| **macOS** | Xcode Command Line Tools (`xcode-select --install`) |
| **Windows** | Visual Studio C++ Build Tools (`MSVC v143`, Windows 10/11 SDK) |

---

## 2. Getting Started

### Step 1: Install Dependencies
```bash
cd terminal
npm install
```

### Step 2: Launch Desktop App (Development Mode)
Run the desktop app with live hot-reloading connected to the native Rust backend:
```bash
npm run tauri dev
```

### Step 3: Launch Web Preview (Frontend Only)
Run the React frontend inside your web browser (uses mock PTY fallback):
```bash
npm run dev
```
The browser preview will be accessible at `http://localhost:1420`.

---

## 3. Project Structure

```text
terminal/
├── package.json              # Frontend npm packages and scripts
├── tsconfig.json             # TypeScript compiler settings
├── vite.config.ts            # Vite bundler config
├── index.html                # App entry HTML
├── src/                      # React Frontend Source Code
│   ├── main.tsx              # React DOM entry point
│   ├── App.tsx               # Primary layout (tabs, toolbar, panels)
│   ├── App.css               # Global application styling
│   ├── components/           # UI Components
│   │   ├── TabBar.tsx        # Tab bar with inline renaming
│   │   ├── Toolbar.tsx       # Shell selector, cwd, recent projects, git badge
│   │   ├── TerminalView.tsx  # xterm.js view connected to PTY backend
│   │   ├── SearchBar.tsx     # Scrollback search overlay
│   │   ├── CommandPalette.tsx# Keyboard command launcher (`Ctrl+Shift+P`)
│   │   ├── SettingsModal.tsx # Theme, font, shell, shortcut configuration
│   │   ├── AiCliPanel.tsx    # Optional AI CLI status and diagnostic view
│   │   └── DiagnosticsModal.tsx # Diagnostic report export window
│   ├── services/             # Typed Frontend Services
│   │   ├── ptyService.ts     # PTY IPC interface and Tauri wrapper
│   │   ├── aiCliService.ts   # AI CLI status and diagnostic checker
│   │   ├── projectService.ts # Recent projects and git info client
│   │   ├── diagnosticsService.ts # Diagnostic report generator
│   │   ├── settingsService.ts# Preferences storage and validation
│   │   ├── shortcuts.ts      # Keyboard shortcut registry
│   │   ├── paneLayout.ts     # Split pane layout engine
│   │   └── workspaces.ts     # Session workspace storage and migration
│   ├── types/                # TypeScript Interfaces
│   │   └── terminal.ts       # Shell profiles, PTY options, settings types
│   └── __tests__/            # Frontend Unit Tests (Vitest)
└── src-tauri/                # Rust Desktop Backend
    ├── Cargo.toml            # Rust crate dependencies
    ├── tauri.conf.json       # Tauri app security and packaging config
    ├── capabilities/         # Security permissions
    │   └── default.json      # Minimal privilege capability sandbox
    ├── build.rs              # Tauri build script
    ├── src/                  # Rust Backend Source Code
    │   ├── main.rs           # Executable entry point
    │   ├── lib.rs            # Tauri application setup and command handlers
    │   ├── pty.rs            # PtyManager session tracking and worker threads
    │   ├── shell.rs          # Cross-platform shell auto-detection
    │   ├── ai_cli.rs         # AI CLI binary presence and version checking
    │   ├── git.rs            # Git branch and status reader
    │   ├── diagnostics.rs    # Diagnostic report compiler
    │   └── error.rs          # TerminalError handling definitions
    └── tests/
        └── pty_integration_tests.rs # Real PTY integration test suite
```

---

## 4. Quality Checks & Verification Commands

All pull requests and code modifications must pass the following verification checks:

### Frontend Verification

```bash
# Type check TypeScript files
npm run typecheck

# Check formatting with Prettier
npm run format:check

# Auto-format frontend code
npm run format

# Run frontend unit tests (Vitest)
npm run test

# Run all frontend checks at once (typecheck + format check + vitest)
npm run check
```

### Rust Backend Verification

```bash
# Check Rust code formatting
cargo fmt --manifest-path src-tauri/Cargo.toml --check

# Format Rust code
cargo fmt --manifest-path src-tauri/Cargo.toml

# Run Rust linter (Clippy)
cargo clippy --no-default-features --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings

# Run Rust backend unit tests
cargo test --no-default-features --manifest-path src-tauri/Cargo.toml --lib

# Run real PTY integration test suite
cargo test --no-default-features --manifest-path src-tauri/Cargo.toml --test pty_integration_tests
```

---

## 5. Frequently Asked Questions

#### Q: Shell fails to launch on Linux or macOS
Ensure your default shell executable exists in your system `$PATH` or `/bin/`. You can view detected shells in the toolbar dropdown or settings modal.

#### Q: `cargo` or `rustc` is not recognized
Verify that Rust is installed on your system via `rustup` and that `~/.cargo/bin` is added to your environment `$PATH`.

#### Q: Webview compilation error on Linux
Make sure GTK 3 and WebKit2GTK header packages are installed:
```bash
sudo apt-get install -y build-essential pkg-config libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev
```
