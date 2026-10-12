---
"kai-terminal": patch
---

Automatic agent registration: `kai agent setup <agent>` now installs kai MCP wiring directly into the agent's own config file (JSON merge with `.kai.bak` backup, idempotent re-runs, `--dry-run`/`--force`/`--print` flags) instead of only printing a snippet. New `kai agent setup all` wires every system-installed agent at once, `kai agent register` aliases setup, and `kai agent list` reports per-agent kai wiring state. The desktop AI providers panel shows wiring status with one-click Auto-wire backed by new `setup_agent_mcp_cmd` / `get_kai_cli_launch_cmd` IPC commands. Aider and opencode use verified config shapes (`mcpServers` in `~/.config/aider/mcp.json`, `mcp` local entry in `~/.config/opencode/opencode.json`).
