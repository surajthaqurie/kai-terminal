---
"kai-terminal": patch
---

Expand AI coding agent ecosystem and harden MCP stream and retrieval staleness:
- Add verified agent setup generators for Gemini CLI, GitHub Copilot (VS Code), Windsurf, and Cline alongside Claude Code, Cursor, and Codex (`kai agent setup <agent>`).
- Expand Rust desktop AI CLI auto-detection catalog to 6 tools (`codex`, `claude`, `gemini`, `opencode`, `copilot`, `aider`) with non-intrusive local auth checks.
- Add stream-level `BoundedLineTransform` to MCP stdio server to reject oversized requests (>10MB) before buffer accumulation.
- Add real-time file staleness detection in context retrieval comparing live disk SHA-256 with index metadata.
- Track inode change timestamps (ctimeMs) alongside mtime and size in indexer.
- Support orphaned project index cleanup by 16-hex hash ID when meta.json is missing or corrupted.
- Enforce strict allowlist for `kai config get` keys, bound task classifier inputs to 4,000 characters, and validate LSP command names.
- Ensure prototype-safe index maps (`Object.create(null)` + `hasOwnProperty` guards) and POSIX path normalization across platforms.
- Update documentation (README, SECURITY, KNOWN_LIMITATIONS, ARCHITECTURE, INSTALL) and website components to reflect expanded agent support, catalogued CLIs, and streaming/staleness boundaries.
