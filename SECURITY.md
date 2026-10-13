# Security Model & Policy

This document describes process execution controls, IPC capabilities, permission handling, and secret policies enforced in Kai Terminal.

---

## 1. Process Launching Controls

- **Direct Argv Execution:** Child processes are spawned using `portable-pty`'s `CommandBuilder` with direct `shell_path` and string arguments. Command line strings are never interpolated through a shell interpreter, preventing command injection vulnerabilities.
- **Path & Parameter Validation:** `shell_path` and `cwd` are checked before spawning: executable files must exist on disk and possess executable permissions. NUL bytes and oversized paths (>4096 bytes) are rejected.
- **Environment & Working Directory:** The default working directory falls back to `$HOME` / `%USERPROFILE%`. Working directory paths fall back safely rather than auto-creating missing paths or using elevated system folders.

---

## 2. IPC Boundary & Capabilities

- **Minimal Capability Permissions:** Tauri capabilities (`src-tauri/capabilities/default.json`) restrict IPC commands exclusively to the main application window with `core:default` minimal permissions.
- **Content Security Policy (CSP):** Enforced in `tauri.conf.json`:
  `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:;`
- **Exposed IPC Commands:** `create_pty`, `write_to_pty`, `resize_pty`, `close_pty`, `get_pty_cwd`, `get_session_info`, `list_sessions`, `get_available_shells`, `get_system_terminal_config`, `get_app_version`, `get_autostart_enabled`, `set_autostart_enabled`, `get_ai_cli_status`, `get_ai_cli_details`, `check_ai_cli_path`, `get_kai_cli_launch_cmd`, `setup_agent_mcp_cmd`, `get_git_info_cmd`, `run_git_action_cmd`, `get_git_changes_cmd`, `get_git_diff_cmd`, `stage_git_file_cmd`, `unstage_git_file_cmd`, `discard_git_file_cmd`, `open_project_in_editor`, `detect_installed_editors_cmd`, `get_project_intelligence_cmd`, `get_active_project_cmd`, `get_diagnostics`. No remote code execution interfaces exist.
- **Git Command Boundaries:** Git actions validate relative repository paths against null bytes, path traversal (`..`), leading slashes, and Windows drive letters. Symlinks escaping the repository root are strictly resolved and rejected. Git processes are bounded by an 8-second execution deadline with background stdout draining and child process reaping on timeout.
- **Agent Auto-Wire Safety:** `setup_agent_mcp_cmd` only accepts built-in provider ids (never paths); the launcher binary must exist on PATH or as a file; configs over 1 MB or with invalid JSON/TOML are never rewritten; existing files are backed up to `<file>.kai.bak` and replaced atomically (temp file + rename).

---

## 3. User Privileges & Secrets

- **User Privileges:** Kai runs with standard OS user permissions. It does not auto-elevate or run as Administrator/root. Admin privileges are only granted when the user explicitly runs `sudo` or elevation prompts within their shell.
- **No Telemetry or Secret Persistence:** Keystrokes typed into shell sessions, environment variable values, and terminal outputs are never logged to disk or external servers.
- **Local Settings Storage:** User settings (`kai_user_settings`) and saved workspace tab structures (`kai_workspaces_v1`) store layout information, shell paths, and UI preferences in browser `localStorage`. Command history, scrollback logs, and credentials are never stored.

---

## 4. Project Scanner, Indexer & MCP Security Model

- **Non-Execution Invariant:** Under no circumstances are indexed project files, build scripts, test suites, or package hooks executed during scanning, indexing, or retrieval. All parsing is passive, static lexical analysis.
- **Path Traversal & Symlink Escapes:** Canonical paths are verified with `fs.realpathSync`. Any symbolic link pointing outside the authorized project root is rejected and never traversed.
- **Default Secret Exclusion:** Sensitive files and credential patterns are filtered by default:
  - Environment files: `.env`, `.env.*`
  - SSH and cryptography keys: `id_rsa*`, `id_ed25519*`, `*.pem`, `*.key`, `*.pfx`, `*.p12`, PKCS#8 / OpenSSL PEM private keys
  - Cloud and API credentials: `credentials.json`, `secrets.json`, `token.json`, `service-account*.json`, fine-grained GitHub PATs (`github_pat_*`), Anthropic API keys (`sk-ant-*`), OpenAI API keys (`sk-*`)
- **Resource Exhaustion Bounds:**
  - File size cap: 512 KB per file.
  - File count limit: 10,000 files per project.
  - Traversal depth limit: 20 directories.
  - Binary files (by extension or null byte check) are skipped.
- **Context Injection & Prompt Isolation:**
  - Prompt templates demarcate untrusted context boundaries with explicit warning headers.
  - Dynamic code fence escaping (`safeCodeFence`) prevents markdown breakout when user source code contains triple or quadruple backticks.
- **Concurrency & Atomic Storage:**
  - Index and metadata writes use atomic temporary file creation followed by rename (`atomicWriteJson`).
  - Concurrent operations are protected by PID-tracked file locks (`ProjectLock`) preventing index corruption.
- **MCP Stdio Isolation & Stream Protection:**
  - The MCP server operates exclusively over standard input/output (`stdio`) JSON-RPC. It does not open network sockets or unauthenticated network ports.
  - All tools are strictly read-only on project sources.
  - All tool arguments resolving file paths enforce strict workspace confinement using `fs.realpathSync`, rejecting unauthorized path traversal and out-of-boundary access.
  - Stream-level line size enforcement (`BoundedLineTransform`) discards requests exceeding 10 MB directly on the byte stream before Node buffers or `readline` can accumulate unbounded memory.
  - Project paths and symbol query arguments containing NUL bytes (`\0`) are strictly rejected.
- **Live Staleness Detection & Index Verification:**
  - Context retrieval computes on-the-fly SHA-256 digests of disk sources and compares them against index snapshot hashes. Stale files trigger explicit warnings directing users to re-index (`kai graph rebuild`).
  - Index caching validates `mtimeMs`, `ctimeMs`, and `sizeBytes` to prevent silent corruption or stale reuse across filesystem changes.
- **Prototype Pollution Defense & Input Boundaries:**
  - In-memory index maps and dependency lookups use null-prototype objects (`Object.create(null)`) with explicit `Object.prototype.hasOwnProperty` guards.
  - Task classifier inputs are strictly bounded to 4,000 characters to prevent regex backtracking or CPU exhaustion on oversized prompts.
  - `kai config get` restricts lookups strictly to an approved configuration key allowlist (`ALLOWED_KEYS`).
  - Language server probes validate command names before checking system `PATH`.
  - Storage deletion in `kai unregister` validates input project paths and supports clean deletion of orphaned storage by 16-character hexadecimal ID when `meta.json` is missing or corrupted.
- **Privacy-Safe Telemetry:**
  - Local diagnostic metrics are appended to `~/.kai/metrics.jsonl` tracking only execution latencies, token counts, and error codes.
  - User prompts, indexed source contents, and secret keys are never persisted to metrics logs.

