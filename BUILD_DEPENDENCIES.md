# Build Dependencies & CI Guide

This document lists system dependencies, build toolchains, and CI secret configuration required to compile and package Kai Terminal across Linux, Windows, and macOS.

---

## 1. Native Build Dependencies

### Linux (Debian / Ubuntu / Kali)
Native C development libraries and WebKit2GTK headers are required to compile the Rust backend and GTK webview:

```bash
sudo apt-get update && sudo apt-get install -y \
  build-essential \
  pkg-config \
  libssl-dev \
  libwebkit2gtk-4.1-dev \
  libgtk-3-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev
```

### Windows (Windows 10 / 11)
- **Visual Studio Build Tools:** Install Visual Studio 2022 Build Tools with the **Desktop development with C++** workload (`MSVC v143`, Windows 10/11 SDK).
- **Rust Toolchain:** Target `x86_64-pc-windows-msvc`.

### macOS (Apple Silicon & Intel)
- **Xcode Command Line Tools:** Run `xcode-select --install`.
- **Rust Toolchain:** Target `aarch64-apple-darwin` or `x86_64-apple-darwin`.

---

## 2. Toolchain Versions

- **Node.js**: v20 LTS or higher
- **npm**: v10 or higher
- **Rust**: 1.75.0 or higher
- **Tauri CLI**: v2.x (`@tauri-apps/cli`)

---

## 3. GitHub Actions Secrets Reference

Configure the following secrets in GitHub Repository Settings (`Settings > Secrets and variables > Actions`) for signing releases:

| Secret Name | Supported OS | Purpose |
| :--- | :--- | :--- |
| **`TAURI_SIGNING_PRIVATE_KEY`** | All | Private key string for signing Tauri updater bundles. |
| **`TAURI_KEY_PASSWORD`** | All | Passphrase to decrypt `TAURI_SIGNING_PRIVATE_KEY`. |
| **`WINDOWS_CERTIFICATE`** | Windows | Base64-encoded Code Signing Certificate (`.pfx`). |
| **`WINDOWS_CERTIFICATE_PASSWORD`** | Windows | Password for `.pfx` certificate. |
| **`APPLE_CERTIFICATE`** | macOS | Base64-encoded Developer ID Certificate (`.p12`). |
| **`APPLE_CERTIFICATE_PASSWORD`** | macOS | Password for `.p12` certificate. |
| **`APPLE_SIGNING_IDENTITY`** | macOS | Developer ID Application identity string. |

---

## 4. Local Build Verification Commands

```bash
# 1. Run all frontend checks
npm run check

# 2. Check Rust code formatting
cargo fmt --manifest-path src-tauri/Cargo.toml --check

# 3. Run Rust unit tests
cargo test --no-default-features --manifest-path src-tauri/Cargo.toml --lib

# 4. Run real PTY integration tests
cargo test --no-default-features --manifest-path src-tauri/Cargo.toml --test pty_integration_tests
```
