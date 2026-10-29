# MCP

Kai includes a local MCP server that runs automatically over stdio for connected AI coding tools. It lets a coding tool read your code map: project info, search, symbols, dependencies, context, task planning, graph sync, language servers, and refresh. The code-map tools run entirely on your machine; connecting an external service is opt-in per project (see External services).

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
| `kai_get_dependencies` | Imports of a file (`includeDependents: true` also lists importers, paged with `limit` / `offset`) |
| `kai_get_context` | Context package for a task (`tokenBudget` optional: the default depends on task type, 1,700 to 4,000, or set `KAI_CONTEXT_BUDGETS`). Name a symbol exactly (`cancelOrder`) and the file that defines it ranks first; refactor, debug, implement and test tasks without an explicit budget also get its callers (refactor only) and up to two tests that import its file, labelled and capped |
| `kai_refresh_index` | Rebuild the map now (incremental unless forced) |
| `kai_get_lsp_status` | Language server state |
| `kai_plan_task` | Task plan with file priorities |
| `kai_sync_graph` | Sync the map after writes |

## External services

By default the server only reads your code map, and nothing leaves your machine. If you connect an external service to a project, extra tools appear for that project only and make HTTPS requests to that service.

```bash
kai integration azure           # sign in, connect this folder, wire your agents, verify
kai azure remove                # disconnect this folder
```

Only one integration is active per project. A project that is not connected sees exactly the tools listed above, no more.

| Tool | Does |
| :--- | :--- |
| `kai_integration_status` | Which service and account this project uses, and which tools it offers |
| `kai_work_item_search` | Search work items (`text`, `state`, `type`, `assignedTo` or read-only `wiql`), paged |
| `kai_work_item_get` | One work item: description, acceptance criteria, relations, recent comments |
| `kai_pr_list` | Pull requests (`status`, `repo`), paged |
| `kai_pr_get` | One pull request: reviewers, changed files, review threads |
| `kai_build_list` | Recent builds (`status`, `result`, `branch`), paged |
| `kai_build_log` | A build's failed steps and log list; `logId` reads log text (last 150 lines, max 400) |

These tools are read-only. Text from the service (work item bodies, comments, PR threads) is written by other people, so each response carries a notice marking it as untrusted data, and rich text is reduced to plain text. They follow the same response limits and paging as the code tools. A failure says what to run, for example `kai integration azure`, and a signed-out account is never replaced by another account.

The tool list is read when an agent connects, so restart a running agent session after `kai integration azure` to see the new tools.

## Response limits

Every response, errors included, stays under a byte ceiling (64 KiB by default; set `KAI_MCP_MAX_RESPONSE_BYTES` to change it). List results take `limit` and `offset`, and report `total`, `returned`, `hasMore` and `nextOffset`, so an agent can walk a long list page by page. When the ceiling cuts a result short, the response says so (`truncated`) instead of returning a partial list silently. Token figures are heuristic estimates, not exact counts. The indexer stops at 10,000 files by default; set `KAI_MAX_INDEX_FILES` (100 to 50,000) to change it, and `scan.fileLimit` in the project info reports the cap in force.
