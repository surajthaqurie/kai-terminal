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
- **Exposed IPC Commands:** `create_pty`, `write_to_pty`, `resize_pty`, `close_pty`, `get_available_shells`, `get_ai_cli_status`, `get_ai_cli_details`, `get_git_info_cmd`, `get_diagnostics`. No remote code execution interfaces exist.

---

## 3. User Privileges & Secrets

- **User Privileges:** Kai runs with standard OS user permissions. It does not auto-elevate or run as Administrator/root. Admin privileges are only granted when the user explicitly runs `sudo` or elevation prompts within their shell.
- **No Telemetry or Secret Persistence:** Keystrokes typed into shell sessions, environment variable values, and terminal outputs are never logged to disk or external servers.
- **Local Settings Storage:** User settings (`kai_user_settings`) and saved workspace tab structures (`kai_workspaces_v1`) store layout information, shell paths, and UI preferences in browser `localStorage`. Command history, scrollback logs, and credentials are never stored.
