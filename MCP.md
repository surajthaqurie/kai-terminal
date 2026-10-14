# MCP

Kai includes a local MCP server. It lets a coding tool read your code map: project info, search, symbols, dependencies, context, task planning, graph sync, language servers, and refresh. Everything runs on your machine.

## Start

```bash
kai mcp .
```

Starts a stdio JSON-RPC server for the project folder. Keep it running while the tool works. `kai setup <agent>` writes this command into the tool's settings for you, so you rarely type it by hand.

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
