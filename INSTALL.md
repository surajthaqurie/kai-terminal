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

## Installation Instructions

### Linux

#### Option 1: Debian / Ubuntu package (`.deb`)
1. Download the `.deb` package from [GitHub Releases](https://github.com/surajthaqurie/kai-terminal/releases/latest).
2. Install via terminal:
   ```bash
   sudo apt install ./Kai_0.1.0_amd64.deb
   ```
   *(Or using dpkg: `sudo dpkg -i ./Kai_0.1.0_amd64.deb && sudo apt-get install -f`)*
3. Launch **Kai Terminal** from your application menu.

#### Option 2: AppImage
1. Download the `.AppImage` file.
2. Make it executable and run:
   ```bash
   chmod +x ./Kai_0.1.0_amd64.AppImage
   ./Kai_0.1.0_amd64.AppImage
   ```
   *(If FUSE is not installed on your system, extract and run: `./Kai_0.1.0_amd64.AppImage --appimage-extract && ./squashfs-root/AppRun`)*

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
| **"WebView2 runtime not found" (Windows)** | Install Microsoft WebView2 runtime, then rerun the installer. |
| **Missing `.deb` dependencies on Linux** | Run `sudo apt-get install -f` to fetch missing GTK/WebKit libraries. |
| **AppImage fails with FUSE error** | Install `libfuse2` package, or launch with `--appimage-extract`. |
| **"Developer cannot be verified" on macOS** | Right-click the app > click Open, or run `xattr -cr /Applications/"Kai.app"`. |
| **PTY creation or directory error** | Verify shell executable exists on system; leave working directory empty to default to `$HOME`. |

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
