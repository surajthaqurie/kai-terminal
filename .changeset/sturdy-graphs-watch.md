---
"kai-terminal": minor
---

Close the fixable KNOWN_LIMITATIONS items: live PTY kill tests (`close_pty` / `close_all` verified against the OS process table), symlink-dependent tests now report explicit skips with a reason, freshness detection also compares ctime and re-hashes racily-clean files so same-size edits with restored timestamps are caught, opt-in `kai mcp --watch` / `KAI_MCP_WATCH=1` background graph refresh for pure-MCP clients, and release/CI targets for Linux `.rpm`, Windows ARM64 (NSIS) and macOS Intel.
