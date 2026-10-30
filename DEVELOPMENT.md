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
cd kai-terminal
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

### Step 3b: Run Tests in Docker (no host toolchain install)
Requires only Docker + Docker Compose. Mirrors the CI Linux job:
```bash
npm run test:docker:build  # build kai-terminal:test image once
npm run test:docker         # full gate: frontend + rust + pty + builds
```
Subsets: `npm run test:docker:frontend`, `npm run test:docker:rust`, `npm run test:docker:pty`.
See `docker-compose.test.yml`, `Dockerfile.test`, `scripts/docker-test.sh`.

---

## 3. Project Structure

```text
kai-terminal/
├── bin/
│   └── kai.js                # Executable Node CLI entrypoint
├── package.json              # Dependencies, bin link, and scripts
├── tsconfig.json             # TypeScript compiler settings
├── vite.config.ts            # Desktop frontend Vite bundler config
├── vite.cli.config.ts        # Standalone CLI Vite bundler config
├── index.html                # Desktop app entry HTML
├── src/                      # TypeScript Source Code
│   ├── cli/                  # Terminal CLI command handlers
│   │   └── index.ts          # CLI runner & argument dispatcher
│   ├── core/                 # Project Intelligence Engine
│   │   ├── types.ts          # Core data models
│   │   ├── registry.ts       # Project storage (~/.kai/), atomic writes, locks
│   │   ├── tokenCounter.ts   # Deterministic token estimator & budgeter
│   │   ├── indexer.ts        # Bounded incremental file scanner & symbol extractor
│   │   ├── classifier.ts     # Task classifier (explain, implement, debug, etc.)
│   │   ├── templates.ts      # Versioned prompt templates
│   │   ├── skills.ts         # On-demand skill registry
│   │   ├── retrieval.ts      # Deterministic relevance search & ranking
│   │   ├── contextAssembler.ts # Multi-stage context package builder
│   │   ├── codeModeWorkflow.ts # Task planning, lifecycle & graph auto-sync
│   │   ├── mcp.ts            # Stdio JSON-RPC Model Context Protocol server
│   │   ├── integrations/     # External services (Azure DevOps): accounts, secret store, tools
│   │   │   └── providers/azure-devops/  # Remote parsing, auth, REST calls, mappers
│   │   ├── benchmarks.ts     # 4-configuration benchmark harness
│   │   └── telemetry.ts      # Privacy-safe local metrics logging
│   ├── components/           # UI Components (Desktop app)
│   ├── services/             # Typed Frontend Services
│   ├── types/                # UI TypeScript Interfaces
│   └── __tests__/            # Unit & Integration Tests (Vitest)
│       ├── intelligence.test.ts # Intelligence, tokens, classifier tests
│       ├── mcp_security.test.ts # MCP protocol, security, concurrency tests
│       ├── retrievalExpansion.test.ts # Anchored ranking, relevance floor, bounded caller/test expansion
│       ├── indexInterruption.test.ts  # Interrupted/failed index writes, removed storage vs the shared cache
│       ├── autoSyncLifecycle.test.ts # Auto-sync, task planning & lifecycle tests
│       ├── codeModeWorkflow.test.ts  # Code mode workflow & lock tests
│       ├── finalHardening.test.ts    # Process tree, signal, shell & crash consistency tests
│       └── releaseHardening.test.ts  # Incarnations, process group cleanup, persistence tests
└── src-tauri/                # Rust Desktop Backend
    ├── Cargo.toml            # Rust crate dependencies
    ├── tauri.conf.json       # Tauri app security and packaging config
    ├── capabilities/         # Security permissions
    └── src/                  # Rust Backend Source Code
```

---

## 4. Quality Checks & Verification Commands

All pull requests and code modifications must pass the following verification checks:

### TypeScript & CLI Verification

```bash
# Type check TypeScript files
npm run typecheck

# Check formatting with Prettier
npm run format:check

# Auto-format codebase
npm run format

# Run all unit, intelligence, and security tests (Vitest)
npm run test

# Build production bundles (Desktop frontend + CLI bundle)
npm run build

# Build standalone CLI bundle only
npm run build:cli

# Run all checks at once (typecheck + format check + vitest)
npm run check

# Verify CLI commands directly
./bin/kai.js --help
./bin/kai.js code .
./bin/kai.js run -- node -e "console.log('agent done')"
./bin/kai.js graph rebuild .
./bin/kai.js status
./bin/kai.js bench .
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
Ensure your default shell executable exists in your system `$PATH` or `/bin/`. You can view detected shells in the `+ ▾` menu next to the new-tab button or in the settings modal.

#### Q: `cargo` or `rustc` is not recognized
Verify that Rust is installed on your system via `rustup` and that `~/.cargo/bin` is added to your environment `$PATH`.

#### Q: Webview compilation error on Linux
Make sure GTK 3 and WebKit2GTK header packages are installed:
```bash
sudo apt-get install -y build-essential pkg-config libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev
```
