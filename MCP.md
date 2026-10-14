# MCP

Kai includes a local MCP server. It lets a coding tool read your code map: project info, search, symbols, dependencies, context, task planning, graph sync, language servers, and refresh. Everything runs on your machine.

## Commands

### 1. Start Server

```bash
kai mcp .
```

Starts a stdio JSON-RPC server for the project folder. Keep it running while the tool works.

### 2. Connect an Agent

Auto-wire Kai MCP into an agent's configuration:

```bash
kai mcp claude          # Wire Claude Code (~/.claude.json)
kai mcp cursor          # Wire Cursor (.cursor/mcp.json)
kai mcp all             # Wire every detected agent on your system
```

Options: `--print` (preview snippet only), `--dry-run` (simulate without writing), `--force` (overwrite existing Kai entry), `--project` (project-scoped config).

### 3. List MCP Status & Connections

```bash
kai mcp list            # Or: kai list mcp, kai list -m
```

Displays local MCP server status, available tools, and connection status across all supported agents.

### 4. Remove Agent Wiring

Disconnect Kai MCP from an agent's configuration:

```bash
kai remove -m claude    # Or: kai mcp remove claude
kai remove -m cursor    # Or: kai mcp remove cursor
```

Option: `--dry-run` to preview changes without modifying files.

## Tools

| Tool | Does |
| :--- | :--- |
| `kai_project_info` | Project name, root, and map state |
| `kai_search_code` | Search files, symbols, and snippets (`query`, up to 20 files) |
| `kai_find_symbol` | Find a symbol by name |
| `kai_get_dependencies` | Imports of a file |
| `kai_get_context` | Context package for a task (token budget, default 4000) |
| `kai_refresh_index` | Rebuild the map now (incremental unless forced) |
| `kai_get_lsp_status` | Language server state |
| `kai_plan_task` | Task plan with file priorities |
| `kai_sync_graph` | Sync the map after writes |
