---
"kai-terminal": minor
---

New `kai mcp` command family for the local MCP server and agent wiring

- `kai mcp [path]` / `kai mcp start [path]` starts the stdio MCP server; `kai mcp <agent|all>` wires an agent (with `--print`, `--dry-run`, `--force`), `kai mcp list` shows server info and connection state, `kai mcp remove <agent>` unwires.
- `kai list mcp` (`-m`) reports MCP server state and tool connections; `kai remove -m <agent>` disconnects a tool.
- CLI help regrouped (Outside / Run / Manage / Check) to match the rewritten command reference.
- Website: command reference grouped by topic (Open and close, Run tool, Setup & MCP, Project graph with init/update/status, Check), dedicated MCP page, floating Topics index with scroll-spy, and an inline GitHub link in the manual hero.
