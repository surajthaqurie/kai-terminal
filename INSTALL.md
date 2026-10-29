# Installation & Setup Guide

This guide explains how to install pre-built packages of Kai Terminal or build the application from source for Linux, Windows, and macOS.

---

## Supported Operating Systems

| Operating System | Minimum Version | Package Formats | Build Status |
| :--- | :--- | :--- | :--- |
| **Linux (x86_64)** | Ubuntu 22.04 LTS (glibc >= 2.35) | `.deb`, `.AppImage`, `.rpm` | Verified native build (`.deb`, `.AppImage`); `.rpm` was left out of the v0.2.0 upload list and first ships in v0.2.1 |
| **Linux (ARM64)** | Ubuntu 24.04 LTS | `.deb`, `.AppImage`, `.rpm` | Verified native build (`.deb`, `.AppImage`); `.rpm` as above |
| **Windows** | Windows 10 (build 17763 / 1809+) or Windows 11 | `.exe` (NSIS), `.msi` | Verified native build |
| **Windows (ARM64)** | Windows 11 ARM64 | `.exe` (NSIS) | Verified native build (`windows-11-arm` runner; shipped in v0.2.0) |
| **macOS (Apple Silicon)** | macOS 12 (Monterey) or later | `.dmg` | Verified native build |
| **macOS (Intel x86_64)** | macOS 12 (Monterey) or later | `.dmg` | Verified native build (`macos-15-intel` runner; shipped in v0.2.0) |

*Note: Snap and Flatpak manifests are complete and built + smoke-tested by the `linux-packages` job in `ci.yml`, but they are not published with releases and the Flatpak/Snap build has not yet had a CI run (see `KNOWN_LIMITATIONS.md`). A Flatpak install starts your host's shell through `flatpak-spawn --host` (the manifest grants `--talk-name=org.freedesktop.Flatpak`); that path is unit-tested but not yet run in a real Flatpak.*

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
# External commands (from any terminal)
kai open                 # launch / focus Kai Terminal desktop app in current directory
kai open /path/to/dir    # launch / focus Kai Terminal desktop app for a specific project
kai close                # close active Kai Terminal instances
kai --version

# Inside Kai Terminal
kai claude .
kai list -a
kai list -m
kai list -i
kai graph init .
kai graph status .
kai health
```

See [USER_MANUAL.md](USER_MANUAL.md) for full syntax and command reference.

---

## Supported Operating Systems (Desktop App)

### Linux

#### Option 1: Debian / Ubuntu package (`.deb`)
1. Download the `.deb` package from [GitHub Releases](https://github.com/surajthaqurie/kai-terminal/releases/latest).
2. Install via terminal:
   ```bash
   sudo apt install ./kai_0.2.1_amd64.deb
   ```
   *(Or using dpkg: `sudo dpkg -i ./kai_0.2.1_amd64.deb && sudo apt-get install -f`)*
3. Launch **Kai Terminal** from your application menu.

#### Option 2: AppImage
1. Download the `.AppImage` file.
2. Make it executable and run:
   ```bash
   chmod +x ./kai_0.2.1_amd64.AppImage
   ./kai_0.2.1_amd64.AppImage
   ```
   *(If FUSE is not installed on your system, extract and run: `./kai_0.2.1_amd64.AppImage --appimage-extract && ./squashfs-root/AppRun`)*

#### Other Linux Packaging
Manifests for non-Debian formats are located in the `packaging/` folder. Snap and Flatpak repackage the Tauri-built `.deb`; their header comments give the build steps:
- **RPM Spec:** `packaging/rpm/kai.spec`
- **Flatpak Manifest:** `packaging/flatpak/com.kai.terminal.yml`
- **Snapcraft Manifest:** `packaging/snap/snapcraft.yaml`

---

### Windows

1. Download the `.exe` (per-user installer) or `.msi` package from [GitHub Releases](https://github.com/surajthaqurie/kai-terminal/releases/latest).
2. Double-click the installer and follow the setup wizard.
3. Launch **Kai Terminal** once: on first startup it auto-installs the `kai`
   CLI launcher (`%USERPROFILE%\.kai\bin\kai.cmd` + `kai.ps1`, backed by the
   CLI bundle shipped inside the installer) and adds that folder to your
   **user PATH automatically** — no manual `setx` step.
4. Open a **new** terminal window (PATH is read at shell startup) and verify:
   ```powershell
   kai --version
   ```
   The launcher needs Node.js 20+ at call time. If `kai --version` reports
   Node is missing, install Node LTS from https://nodejs.org, then run
   `kai --version` again in a new terminal.
5. Windows 11 includes the required WebView2 runtime by default. On Windows 10, if prompted, install Microsoft WebView2 Runtime.

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
cd kai-terminal

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
| **`kai: command not found` after installing the desktop app** | Recent builds self-repair on first launch: Kai installs a `kai` launcher from its bundled CLI and adds it to your user PATH automatically — launch Kai once, open a **new** terminal, then `kai --version`. If `kai` instead opens a window, see the name-collision row below. |
| **`kai code .` / `kai agent setup ...` opens a NEW Kai window (or new terminal) instead of running in this terminal** | `kai` on PATH resolves to the **desktop GUI binary**, not the Node CLI — both share the name `kai` on every OS (Linux: `/usr/bin/kai` vs `~/.local/bin/kai`; macOS: `Kai Terminal.app/.../kai` vs `~/.local/bin/kai`; Windows: `KaiTerminal\kai.exe` vs `.kai\bin\kai.cmd`). Fix: `npm run setup:cli` (backs up the collision to `~/.local/bin/kai.desktop-bak` on Linux/macOS), **restart the terminal**, then `kai --version` must print `kai v...` and exit instantly. If it opens a window, `which kai` / `where kai` still hits the desktop first — put `~/.local/bin` (Linux/macOS) or `%USERPROFILE%\.kai\bin` (Windows) FIRST on PATH. New desktop builds also refuse CLI args with a pointer instead of opening a duplicate window; only `kai code` (CLI) ever launches/focuses the GUI — `agent setup`, `status`, `query`, etc. never open anything. |
| **Check-for-updates / "View release" does nothing in the installed app** | Fixed: the WebView CSP now allows `https://api.github.com`, and release links open via the OS browser on all three OSes (`xdg-open` / `open` / `start`). If the button still fails on Linux, make sure `xdg-open` exists (`which xdg-open`) and a default browser is set. |
| **Linux app-drawer entry has the wrong icon/name, or clicking it does nothing** | Run `kai doctor` (or `./bin/kai.js doctor`) — it audits every kai `.desktop` entry (Name/Exec target/Icon) and tells you exactly which part is broken. Also try: `grep -ril kai /usr/share/applications ~/.local/share/applications`, then run the `Exec=` binary directly in a terminal to see the real error (often a missing WebKit/GTK lib — fix with `sudo apt-get install -f`). |
| **`npm run setup:cli` hangs on Windows (no output, looks frozen)** | `powershell` first launch (`.NET` JIT) or the first `vite` build can stall under antivirus/OneDrive locks. Wait up to a minute; the script now prints build timing and caps PowerShell probes at 15–20 s before printing manual `setx` steps instead of hanging. Re-run with `node scripts/setup-cli.cjs --skip-build` to skip a finished build. |
| **`kai` still not found right after `setup:cli`** | PATH is read when a shell starts. Open a **new** terminal window (or restart the IDE terminal) — no reinstall needed. |
| **Manual PATH fallback (Windows)** | If auto-update failed, run once in PowerShell: `powershell -NoProfile -Command "[Environment]::SetEnvironmentVariable('Path', ([Environment]::GetEnvironmentVariable('Path','User').TrimEnd(';') + ';%USERPROFILE%\.kai\bin'), 'User')"`, then open a **new** terminal. Do NOT use `setx PATH "%PATH%;..."` — setx silently truncates values over 1024 chars and can corrupt PATH. |
| **Manual PATH fallback (Linux/macOS)** | If auto-update failed: add `export PATH="$HOME/.local/bin:$PATH"` to `~/.bashrc` / `~/.zshrc` / `~/.profile`, then restart the terminal. |
| **`bin/kai.js` reports "Compiled CLI bundle not found"** | `dist/cli/index.js` was never built (it is gitignored). Run `npm run build:cli` (or `npm run setup:cli`, which builds automatically). |
| **"WebView2 runtime not found" (Windows)** | Install Microsoft WebView2 runtime, then rerun the installer. |
| **Missing `.deb` dependencies on Linux** | Run `sudo apt-get install -f` to fetch missing GTK/WebKit libraries. |
| **AppImage fails with FUSE error** | Install `libfuse2` package, or launch with `--appimage-extract`. |
| **"Developer cannot be verified" on macOS** | Right-click the app > click Open, or run `xattr -cr /Applications/"Kai.app"`. |
| **PTY creation or directory error** | Verify shell executable exists on system; leave working directory empty to default to `$HOME`. |
| **CLI reports stale results after editing files** | Re-index with `kai graph update <path>` (incremental detection compares mtime, ctime, and size). |
| **CLI reports "No project registered" after disk changes** | The index under `~/.kai/projects/` may be corrupt or deleted; rerun `kai graph init <path>`. |
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
kai remove -i <path-or-id> --dry-run  # inspect first (supports path or 16-hex ID for orphaned cleanup)
kai remove -i <path-or-id>
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
   git tag v0.2.1
   git push origin v0.2.1
   ```
3. GitHub Actions will automatically compile `.deb`, `.AppImage`, `.exe`, `.msi`, and `.dmg` installers and publish them to the release page.
