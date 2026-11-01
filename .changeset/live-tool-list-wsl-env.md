---
"kai-terminal": patch
---

Integrations tools appear in a running agent, and `kai` works in WSL.

- **Live tool list**: the MCP server now announces `tools: { listChanged: true }` and sends `notifications/tools/list_changed` (within about two seconds, once the client has sent `initialized`) after `kai integration azure` or `kai azure remove`. An agent that honors it refreshes its tools without a restart; one that does not still needs one. `KAI_MCP_TOOLS_POLL_MS` sets the check interval and `0` turns it off.
- **WSL**: a `wsl.exe` terminal now lists `KAI_TERMINAL` in `WSLENV`, keeping your own entries, so `kai <agent>` can run inside WSL instead of refusing to start.
- **Tests**: the directory-link tests skip, with a reason, on a Windows build that creates a junction but will not follow it, instead of failing or passing without checking anything.
