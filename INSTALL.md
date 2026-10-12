# Installation & Setup Guide

This guide explains how to install pre-built packages of Kai Terminal or build the application from source for Linux, Windows, and macOS.

---

## Supported Operating Systems

| Operating System | Minimum Version | Package Formats | Build Status |
| :--- | :--- | :--- | :--- |
| **Linux (x86_64)** | Ubuntu 22.04 LTS (glibc >= 2.35) | `.deb`, `.AppImage` | Verified native build |
| **Linux (ARM64)** | Ubuntu 24.04 LTS | `.deb`, `.AppImage` | Verified native build |
| **Windows** | Windows 10 (build 17763 / 1809+) or Windows 11 | `.exe` (NSIS), `.msi` | Verified native build |
| **macOS** | macOS 12 (Monterey) or later (Apple Silicon) | `.dmg` | Verified native build |

*Note: Windows ARM64 and macOS Intel (x86_64) are not currently built or tested.*

---

## Installing Kai CLI (Project Intelligence & MCP Server)

The `kai` CLI and Model Context Protocol (MCP) server can be installed globally or run locally using Node.js (v20+):

### Global Installation via npm
```bash
npm install
npm run build:cli
npm run setup:cli
```
`setup:cli` builds the minified bundle if needed (only when sources changed),
installs a `kai` launcher onto a user-level bin dir on every OS (no admin
needed), **and adds that dir to your user PATH automatically**:
- Windows: `%USERPROFILE%\.kai\bin\kai.cmd` (+ `kai.ps1`) → User PATH registry entry
- Linux / macOS: `~/.local/bin/kai` → marked line in your shell rc files

Afterwards just **restart your terminal** (PATH is read at shell startup) and run `kai --version`. No manual `setx` / `export PATH` step.

Alternative (npm global bin, requires that dir to already be on PATH):
```bash
npm link
```
After installing, the `kai` command is available in your shell:
```bash
kai --version
kai code .
kai status
kai mcp .
```

### Local Execution
```bash
./bin/kai.js --help
./bin/kai.js code .
./bin/kai.js query "Explain architecture"
```

---

## Supported Operating Systems (Desktop App)

### Linux

#### Option 1: Debian / Ubuntu package (`.deb`)
1. Download the `.deb` package from [GitHub Releases](https://github.com/surajthaqurie/kai-terminal/releases/latest).
2. Install via terminal:
   ```bash
   sudo apt install ./kai_0.1.0_amd64.deb
   ```
   *(Or using dpkg: `sudo dpkg -i ./kai_0.1.0_amd64.deb && sudo apt-get install -f`)*
3. Launch **Kai Terminal** from your application menu.

#### Option 2: AppImage
1. Download the `.AppImage` file.
2. Make it executable and run:
   ```bash
   chmod +x ./kai_0.1.0_amd64.AppImage
   ./kai_0.1.0_amd64.AppImage
   ```
   *(If FUSE is not installed on your system, extract and run: `./kai_0.1.0_amd64.AppImage --appimage-extract && ./squashfs-root/AppRun`)*

#### Other Linux Packaging Templates
Templates for building non-Debian formats are located in the `packaging/` folder:
- **RPM Spec:** `packaging/rpm/kai.spec`
- **Flatpak Manifest:** `packaging/flatpak/com.kai.terminal.yml`
- **Snapcraft Manifest:** `packaging/snap/snapcraft.yaml`

---

### Windows

1. Download the `.exe` (per-user installer) or `.msi` package from [GitHub Releases](https://github.com/surajthaqurie/kai-terminal/releases/latest).
2. Double-click the installer and follow the setup wizard.
3. Windows 11 includes the required WebView2 runtime by default. On Windows 10, if prompted, install Microsoft WebView2 Runtime.

---

### macOS

1. Download the `.dmg` file from [GitHub Releases](https://github.com/surajthaqurie/kai-terminal/releases/latest).
2. Open the `.dmg` file and drag **Kai** into your **Applications** folder.
3. **First launch note:** Unsigned release builds will display a macOS Gatekeeper prompt. To open:
   - Right-click (or Control-click) the app in Applications and click **Open**.
   - Or clear the quarantine attribute via terminal:
     ```bash
     xattr -cr /Applications/"Kai.app"
     ```

---

## Building from Source

### 1. Requirements

- **Node.js**: v20 LTS or newer (`node -v`)
- **npm**: v10 or newer (`npm -v`)
- **Rust**: stable 1.75 or newer (`rustc -V`)

### 2. Native System Dependencies

#### Linux (Debian / Ubuntu / Kali)
```bash
sudo apt-get update && sudo apt-get install -y \
  build-essential pkg-config libssl-dev \
  libwebkit2gtk-4.1-dev libgtk-3-dev \
  libayatana-appindicator3-dev librsvg2-dev
```

#### Windows
Install **Visual Studio Build Tools** with the **Desktop development with C++** workload (`MSVC v143` + Windows 10/11 SDK).

#### macOS
Install Xcode Command Line Tools:
```bash
xcode-select --install
```

### 3. Build Steps

```bash
# Clone repository
git clone https://github.com/surajthaqurie/kai-terminal.git
cd kai

# Install frontend packages
npm install

# Run in development mode (hot reload)
npm run tauri dev

# Compile ready-to-install release bundles
npm run tauri build
```

---

## Troubleshooting

| Problem | Cause / Solution |
| :--- | :--- |
| **`kai: command not found` after installing the desktop app** | The Tauri `.exe`/`.msi`/`.deb`/`.dmg` installer ships the terminal UI only — it never puts the Node `kai` CLI on PATH. Fix: `npm install && npm run setup:cli`, **restart the terminal**, then `kai --version`. |
| **`kai` still not found right after `setup:cli`** | PATH is read when a shell starts. Open a **new** terminal window (or restart the IDE terminal) — no reinstall needed. |
| **Manual PATH fallback (Windows)** | If auto-update failed: `setx PATH "%PATH%;%USERPROFILE%\.kai\bin"`, then open a **new** terminal. |
| **Manual PATH fallback (Linux/macOS)** | If auto-update failed: add `export PATH="$HOME/.local/bin:$PATH"` to `~/.bashrc` / `~/.zshrc` / `~/.profile`, then restart the terminal. |
| **`bin/kai.js` reports "Compiled CLI bundle not found"** | `dist/cli/index.js` was never built (it is gitignored). Run `npm run build:cli` (or `npm run setup:cli`, which builds automatically). |
| **"WebView2 runtime not found" (Windows)** | Install Microsoft WebView2 runtime, then rerun the installer. |
| **Missing `.deb` dependencies on Linux** | Run `sudo apt-get install -f` to fetch missing GTK/WebKit libraries. |
| **AppImage fails with FUSE error** | Install `libfuse2` package, or launch with `--appimage-extract`. |
| **"Developer cannot be verified" on macOS** | Right-click the app > click Open, or run `xattr -cr /Applications/"Kai.app"`. |
| **PTY creation or directory error** | Verify shell executable exists on system; leave working directory empty to default to `$HOME`. |
| **CLI reports stale results after editing files** | Re-index with `kai graph rebuild <path>` (incremental detection compares mtime, ctime, and size; queries flag live disk changes via SHA-256). |
| **CLI reports "No project registered" after disk changes** | The index under `~/.kai/projects/` may be corrupt or deleted; rerun `kai code <path>`. |
| **Indexing fails with a lock error** | Another `kai` process is indexing the same project; wait ~30s for stale-lock expiry and retry. |

---

## Kai CLI Data Locations & Uninstalling

The `kai` CLI keeps all of its data **outside** your repositories:

| Data | Location |
| :--- | :--- |
| Project indexes & metadata | `~/.kai/projects/<id>/` (override root with `KAI_HOME`) |
| Local diagnostic metrics | `~/.kai/metrics.jsonl` (latency/token counts only — never prompts or source) |
| CLI configuration | `~/.kai/config.json` |
| Session/cache scratch files | `~/.kai/sessions/`, `~/.kai/cache/` |

To remove a single project's index without touching the repository:

```bash
kai unregister <path-or-id> --dry-run  # inspect first (supports path or 16-hex ID for orphaned cleanup)
kai unregister <path-or-id>
```

To fully uninstall the CLI and delete all Kai-owned data:

```bash
npm unlink -g kai-terminal  # only if installed via `npm link`
rm -rf ~/.kai               # or "$KAI_HOME" if set
```

---

## Publishing Releases

To generate and attach build artifacts to a GitHub Release:

1. Run verification checks locally:
   ```bash
   npm run check
   cargo test --no-default-features --manifest-path src-tauri/Cargo.toml
   ```
2. Tag a release version and push to GitHub:
   ```bash
   git tag v0.1.0
   git push origin v0.1.0
   ```
3. GitHub Actions will automatically compile `.deb`, `.AppImage`, `.exe`, `.msi`, and `.dmg` installers and publish them to the release page.
