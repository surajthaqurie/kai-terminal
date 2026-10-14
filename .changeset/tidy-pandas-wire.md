---
"kai-terminal": patch
---

Fix Code Mode activation visibility, desktop MCP auto-wire entries, and agent setup errors

- Code Mode: the footer pill now combines global + per-pane truth. When `kai code <path>` targets a project the active pane is not inside, the footer shows `Code Mode: <name>` (click to jump) instead of a misleading `Terminal`. `kai-open-project` events carrying a path focus/open that directory so second launches are never silently swallowed.
- Desktop agent auto-wire (`setup_agent_mcp_cmd`) now resolves the launcher to the verified `node <kai.js> mcp` spawn form before writing: Windows `.cmd`/`.ps1` shims are parsed for the embedded bundle path (verbatim prefixes stripped) instead of being written verbatim as the entry command, which agents cannot spawn. Unresolvable launchers fail with a terminal-CLI pointer instead of writing a known-broken config.
- `kai` CLI discovery (`get_kai_cli_launch_cmd`) falls back past the GUI-process PATH to the installer user bin dir, well-known per-user locations, and absolute paths, and rejects desktop-GUI-lookalike `kai` binaries so agent configs never spawn the GUI as their MCP server.
- Copilot project-scoped wiring is supported from the desktop via the new optional `project_dir` (writes `<project>/.vscode/mcp.json`, merged); without it the call is declined with guidance. Custom-registered binaries no longer show a Configure button that could only fail.
- Forced Codex refresh replaces the stale `[mcp_servers.kai]` section instead of appending a duplicate table (a TOML parse error in the agent).
- New `get_agent_setup_snippet_cmd` backs a per-provider Manual setup expander in the AI panel, so declined/failed writes still leave copyable steps; auto-wire failures auto-open it.
- CLI `agent setup` resolves symlinked `argv[1]` to the real bundle path before baking MCP entries.
