# kai — One terminal. Every platform.

[![CI](https://github.com/surajthaqurie/kai-terminal/actions/workflows/ci.yml/badge.svg)](https://github.com/surajthaqurie/kai-terminal/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Release](https://img.shields.io/github/v/release/surajthaqurie/kai-terminal?label=download)](https://github.com/surajthaqurie/kai-terminal/releases/latest)
[![Website](https://img.shields.io/badge/site-kai--website--jet.vercel.app-06b6d4)](https://kai-website-jet.vercel.app/)

Fast, keyboard-first terminal for **Windows · Linux · macOS**.
Native Rust PTY (`portable-pty`) + Tauri 2 + GPU `xterm.js`. ~30MB idle, zero telemetry, MIT.

🌐 Live site: **https://kai-website-jet.vercel.app/** · 💾 Releases: [latest](https://github.com/surajthaqurie/kai-terminal/releases/latest)

[![kai hero](docs/screenshot.png)](https://kai-website-jet.vercel.app/)

## Install (1 file per OS)

| OS | File | Command |
| --- | --- | --- |
| macOS 12+ M1–M4 (Apple Silicon) | `Kai_0.1.0_aarch64.dmg` | open + drag to `/Applications` |
| Linux x64 / ARM64 | `kai_0.1.0_amd64.deb` (or `.AppImage`) | `sudo dpkg -i kai_*.deb` · `chmod +x kai_*.AppImage` |
| Windows 10/11 x64 | `Kai_0.1.0_x64-setup.exe` (or `.msi`) | download + run |

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

## Kai CLI & Project Intelligence

Kai includes a lightweight, terminal-first project intelligence tool that helps external AI coding agents (Claude Code, Cursor, Codex, Gemini, Copilot, Windsurf, Cline) understand codebases efficiently through local, bounded indexing and read-only MCP integration.

### Quickstart

```bash
# Register and index the project (stored safely in ~/.kai/ outside the repository)
kai code .

# Inspect project status, schema version, and index health
kai status

# Remove a project's Kai-owned index data (repository untouched; supports path or 16-hex ID)
kai unregister . --dry-run

# Query task-aware context with deterministic classification & prompt formatting
# (rendered output is hard-bounded to the token budget, default 4000)
kai query "Explain PtyManager lifecycle"

# Inspect token footprint and budget metrics
kai cost

# Start local Model Context Protocol (MCP) server over stdio
kai mcp .

# Inspect local Language Server Protocol (LSP) availability
kai lsp status

# Run privacy-safe evaluation benchmarks across 4 configurations
kai bench .

# Generate verified configuration for coding agents
kai agent setup claude    # ~/.claude.json
kai agent setup cursor    # .cursor/mcp.json
kai agent setup codex     # Codex MCP stdio config
kai agent setup gemini    # ~/.muse/settings.json
kai agent setup copilot   # .vscode/mcp.json (VS Code / Copilot)
kai agent setup windsurf  # ~/.codeium/windsurf/mcp_config.json
kai agent setup cline     # cline_mcp_settings.json
```

### Supported agents

| Agent | Config file | Notes |
| --- | --- | --- |
| Claude Code | `~/.claude.json` | `mcpServers.kai` stdio entry |
| Cursor | `.cursor/mcp.json` | uses `${workspaceFolder}` |
| Codex | Codex MCP stdio config | `mcp_servers` array format |
| Gemini CLI | `~/.muse/settings.json` | `mcpServers.kai` stdio entry |
| Copilot / VS Code | `.vscode/mcp.json` | `servers.kai` with `"type": "stdio"` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | `mcpServers.kai` stdio entry |
| Cline | `cline_mcp_settings.json` | `mcpServers.kai` stdio entry |

The desktop app additionally auto-detects locally installed CLIs
(`codex`, `claude`, `gemini`, `opencode`, `copilot`, `aider`) without
executing them — missing tools simply report `available: false`.

### Audited Performance & Token Optimization
- **Sub-10ms retrieval latency**: Evaluated context assembly executes in `0.8ms – 3.2ms` on local hardware.
- **~70% token savings**: Replaces naive, unbounded repository dumps (`~11.5k tokens`) with focused, ranked AST symbols, dependency chains, and relevant line ranges (`~2.6k – 3.4k tokens`).
- **Deterministic ranker**: Weighted scoring prioritizes exact symbol hits (10.0), symbol mentions (7.0), filename matches (5.0), and import links without non-deterministic prompt drift.

### Supported MCP Tools (stdio JSON-RPC)

Kai exposes 7 standard, strictly read-only MCP tools over stdio:

- `kai_project_info`: High-level metadata, schema version, file counts, and language breakdown.
- `kai_search_code`: Deterministic relevance search over symbols and snippets.
- `kai_find_symbol`: Locate definitions (functions, classes, interfaces, structs) with line ranges.
- `kai_get_dependencies`: Query import and dependency graphs.
- `kai_get_context`: Assemble a task-optimized context package within a strict token budget.
- `kai_refresh_index`: Safe incremental re-index of the repository.
- `kai_get_lsp_status`: Query probe status of locally installed Language Servers (`typescript-language-server`, `rust-analyzer`, `pyright`, `gopls`).

### Desktop GUI Intelligence Widget
The Kai Terminal status bar includes an active project intelligence badge next to the Git branch status. It displays real-time indexing state, file and symbol counts, and the project's estimated token footprint.

### Privacy, Boundaries & Safety
- **Zero code execution**: Indexed project source files and scripts are never executed.
- **Strict exclusion**: `.env*`, `id_rsa*`, tokens, and binary files are excluded by default.
- **Stream-bounded MCP**: `BoundedLineTransform` rejects requests exceeding 10 MB at the byte stream level before memory accumulation.
- **Live staleness detection**: Retrieval validates on-disk files against index SHA-256 hashes and warns when files have drifted since indexing.
- **Isolated storage & cleanup**: All indexes and caches are kept in `~/.kai/` outside the repo; `kai unregister` supports safe 16-hex ID cleanup of orphaned data.
- **Local telemetry**: Diagnostic metrics are stored locally in `~/.kai/metrics.jsonl` with zero prompt logging.

## Docs

[INSTALL](INSTALL.md) · [DEVELOPMENT](DEVELOPMENT.md) · [ARCHITECTURE](ARCHITECTURE.md) · [SECURITY](SECURITY.md) · [TEST_PLAN](TEST_PLAN.md) · [KNOWN_LIMITATIONS](KNOWN_LIMITATIONS.md)

## License

MIT — see [LICENSE](LICENSE). Free for personal + commercial use.
