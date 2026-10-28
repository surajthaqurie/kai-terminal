# MCP

Kai includes a local MCP server that runs automatically over stdio for connected AI coding tools. It lets a coding tool read your code map: project info, search, symbols, dependencies, context, task planning, graph sync, language servers, and refresh. Everything runs privately on your machine.

## Commands

### 1. Connect an Agent

Auto-wire Kai MCP into an agent's configuration:

```bash
kai mcp claude          # Wire Claude Code (~/.claude.json)
kai mcp cursor          # Wire Cursor (.cursor/mcp.json)
kai mcp all             # Wire every detected agent on your system
```

Options: `--print` (preview snippet only), `--dry-run` (simulate without writing), `--force` (overwrite existing Kai entry), `--project` (project-scoped config).

### 2. List MCP Status & Connections

```bash
kai mcp list            # Or: kai list mcp, kai list -m, kai list --mcp
```

Displays local MCP server status, available tools, and connection status across all supported agents.

### 3. Remove Agent Wiring

Disconnect Kai MCP from an agent's configuration:

```bash
kai remove -m claude    # Or: kai remove --mcp claude, kai mcp remove claude
kai remove -m cursor    # Or: kai remove --mcp cursor, kai mcp remove cursor
```

Option: `--dry-run` to preview changes without modifying files.

## Tools

| Tool | Does |
| :--- | :--- |
| `kai_project_info` | Project name, root, and map state |
| `kai_search_code` | Ranked file and symbol search, metadata only (`query`, up to 20 files; `includeSource: true` adds snippets) |
| `kai_read_range` | Read one symbol or line range (max 400 lines) |
| `kai_find_symbol` | Find a symbol by name |
| `kai_get_dependencies` | Imports of a file |
| `kai_get_context` | Context package for a task (`tokenBudget` optional: the default depends on task type, 1,700 to 4,000, or set `KAI_CONTEXT_BUDGETS`) |
| `kai_refresh_index` | Rebuild the map now (incremental unless forced) |
| `kai_get_lsp_status` | Language server state |
| `kai_plan_task` | Task plan with file priorities |
| `kai_sync_graph` | Sync the map after writes |
