# kai — One terminal. Every platform.

[![CI](https://github.com/surajthaqurie/kai-terminal/actions/workflows/ci.yml/badge.svg)](https://github.com/surajthaqurie/kai-terminal/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Release](https://img.shields.io/github/v/release/surajthaqurie/kai-terminal?label=download)](https://github.com/surajthaqurie/kai-terminal/releases/latest)
[![Website](https://img.shields.io/badge/site-kai--website--khaki.vercel.app-06b6d4)](https://kai-website-khaki.vercel.app/)

Fast, keyboard-first terminal for **Windows · Linux · macOS**.
Native Rust PTY (`portable-pty`) + Tauri 2 + GPU `xterm.js`. ~30MB idle, zero telemetry, MIT.

🌐 Live site: **https://kai-website-khaki.vercel.app/** · 💾 Releases: [latest](https://github.com/surajthaqurie/kai-terminal/releases/latest)

[![kai hero](docs/screenshot.png)](https://kai-website-khaki.vercel.app/)

## Install (1 file per OS)

| OS | File | Command |
| --- | --- | --- |
| Windows 10/11 x64 | `Kai_0.1.0_x64-setup.exe` (or `.msi`) | download + run |
| Linux x64 / ARM64 | `kai_0.1.0_amd64.deb` (or `.AppImage`) | `sudo dpkg -i kai_*.deb` · `chmod +x kai_*.AppImage` |
| macOS 12+ M1–M4 | `Kai_0.1.0_aarch64.dmg` | open + drag to `/Applications` |

> No release files yet? Push tag `v0.1.0` to trigger builds, or build from source below.

## Run from source (30s)

```bash
git clone https://github.com/surajthaqurie/kai-terminal.git
cd kai-terminal
npm install
npm run tauri dev   # desktop, hot reload
```

Prereqs: Node 20+ · Rust 1.75+. Linux also needs:
```bash
sudo apt-get install -y build-essential pkg-config libssl-dev libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev
```

Other useful scripts: `npm run dev` (browser mock PTY) · `npm run tauri build` (bundles in `src-tauri/target/release/bundle/`) · `npm run check` (lint+types+tests).

## AI CLIs (optional, local only)

kai probes `PATH` for tools you already installed — `codex`, `claude`, `gemini` — and runs them in a full pty. Zero bundled binaries, your keys stay yours.

```bash
kai --status      # pty + render + AI probe
kai --probe ai    # list detected CLIs
```

## Docs

[INSTALL](INSTALL.md) · [DEVELOPMENT](DEVELOPMENT.md) · [ARCHITECTURE](ARCHITECTURE.md) · [SECURITY](SECURITY.md) · [TEST_PLAN](TEST_PLAN.md) · [KNOWN_LIMITATIONS](KNOWN_LIMITATIONS.md)

## License

MIT — see [LICENSE](LICENSE). Free for personal + commercial use.
