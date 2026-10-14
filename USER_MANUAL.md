# Kai Terminal — Comprehensive User Manual & Command Reference

**Kai Terminal** is an ultra-fast, cross-platform terminal (built with Rust, Tauri 2, and WebGL GPU acceleration) combined with a local project intelligence engine designed specifically for external AI coding agents (Claude, Cursor, Codex, Gemini, OpenCode, Aider, Windsurf, Cline, Antigravity, etc.).

---

## 1. Architectural Boundaries & Execution Model

Kai CLI enforces a strict environment boundary to protect workflows and prevent accidental index corruption:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       EXTERNAL SHELL (Bash / Zsh / PowerShell)              │
│                                                                             │
│   • kai open [path]        Opens or focuses Kai Terminal for a project      │
│   • kai close              Closes running Kai Terminal instances            │
│   • kai --help / --version Display help and version information             │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                               kai open [path]
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                      INSIDE KAI TERMINAL (KAI_TERMINAL=1)                   │
│                                                                             │
│   • kai <agent> [path]     Launch AI agents (auto MCP, Code Mode, sync)     │
│   • kai list [-a|-i|-s|-c] Inspect agents, indexed projects, sessions       │
│   • kai setup <agent|all>  Auto-wire Kai MCP into agent configs             │
│   • kai remove [-i|-a|-s]  Safely remove index, agent MCP, or sessions      │
│   • kai graph <subcommand> Manage AST symbol index & dependency graph       │
│   • kai status [path]      Show project metadata, LSP, and hook health      │
│   • kai stop               Exit Code Mode back to plain terminal            │
│   • kai doctor / lsp       Diagnostics and Language Server bridge status    │
└─────────────────────────────────────────────────────────────────────────────┘
```

> **Note**: If an internal command is executed outside Kai Terminal, the CLI exits cleanly with guidance:
> ```
> [kai] Error: 'kai claude' can only be executed inside Kai Terminal.
> To open or focus Kai Terminal for your project, run:
>   kai open [path]
> ```

---

## 2. External Commands

These commands can be run from any standard terminal on macOS, Linux, or Windows.

### `kai open [path]`
Opens or focuses the Kai Terminal desktop application for the specified project directory (defaults to current directory `.` if omitted). It registers the project and primes Code Mode.

**Syntax**:
```bash
kai open [path]
```

**Examples**:
```bash
# Open Kai Terminal for the current directory
kai open

# Open Kai Terminal for a specific project
kai open /home/kali/Documents/my-project
kai open C:\Users\Dev\Projects\backend
```

**Sample Output**:
```text
[kai] Opened Kai Terminal for "my-project" (/home/kali/Documents/my-project)
```

---

### `kai close`
Closes active Kai Terminal desktop application instances across all supported operating systems.

**Syntax**:
```bash
kai close
```

**Sample Output**:
```text
[kai] Kai Terminal instances closed.
```

---

### `kai --help` / `kai --version`
Display CLI documentation or current release version.

**Syntax**:
```bash
kai --help
kai --version
```

**Sample Output**:
```text
kai v0.1.4
```

---

## 3. Internal Commands (Inside Kai Terminal)

The following commands are available inside Kai Terminal tabs and splits.

---

### 3.1 Running Agents (`kai <agent> [path]`)

Launches any supported external AI coding agent directly inside your project directory. 
When invoked, Kai automatically:
1. Registers the target project path (defaults to `.` if omitted).
2. Auto-wires Kai's Model Context Protocol (MCP) server into the agent's configuration.
3. Ensures the baseline symbol index and dependency graph are built.
4. Enters Code Mode and activates git commit-msg hooks.
5. Launches the agent inside the project root.
6. Automatically synchronizes the AST graph and symbol cache upon exit or failure.

**Syntax**:
```bash
kai <agent> [path]
```

**Supported Agents**: `claude`, `cursor`, `codex`, `gemini`, `opencode`, `aider`, `windsurf`, `cline`, `agy`.

**Examples**:
```bash
# Launch Claude Code in current directory
kai claude

# Launch Cursor IDE for a specific project
kai cursor /home/kali/Documents/web-app

# Launch Aider or OpenCode
kai aider .
kai opencode .
```

**Sample Output**:
```text
[kai] MCP configuration auto-wired for claude.
[kai] Indexing project for Code Mode run...
[kai] Running Code Mode task in "my-project": claude
... [Agent Session Runs Here] ...
[kai] Agent finished (command exited with code 0, 1842ms).
[kai] Graph auto-sync: incremental (changed-files; freshness: fresh). Re-indexed 3 modified files in 24ms.
```

---

### 3.2 Resource Listing (`kai list [flags]`)

Inspect system resources, installed agents, registered indexes, active sessions, and configuration.

**Syntax**:
```bash
kai list [options]
```

**Flags**:
- `-a, --agent`: List AI agents and Kai MCP wiring status (default behavior).
- `-i, --index`: List all registered projects and AST index metadata.
- `-s, --session`: List active session and cache files.
- `-c, --config`: Display the active CLI configuration settings.

#### Examples & Sample Outputs:

#### `kai list -a` (AI Agents & MCP Status)
```bash
kai list -a
```
```text
[kai] AI Agent Detection (live system probe):
  ✓ claude     Claude Code      Installed (/usr/local/bin/claude), configured · kai wired ✓
  ✓ cursor     Cursor           Installed (/usr/bin/cursor), configured · kai wired ✓
  ✗ codex      Codex CLI        Not found · kai not wired
    └─ Install via npm: npm install -g @openai/codex | config: ~/.codex/config.toml
  ✓ gemini     Gemini CLI       Installed (~/.local/bin/gemini) · kai wired ✓
  ✓ opencode   opencode         Installed (/usr/bin/opencode) · kai wired ✓
  ✓ aider      Aider            Installed (/home/kali/.local/bin/aider) · kai wired ✓

Tip: Run 'kai <agent> [path]' to launch an agent with auto-wired MCP, Code Mode, and graph sync (e.g. 'kai claude .').
```

#### `kai list -i` (Indexed Projects)
```bash
kai list -i
```
```text
[kai] Indexed Projects (2):
  • my-project (id: e2b57f01a8cd3241)
    Path:     /home/kali/Documents/my-project
    Status:   ready (fresh) | Files: 142 | Symbols: 890
    Indexed:  2026-10-14T22:15:30.124Z
  • backend-api (id: 48f901ab3c2d1190)
    Path:     /home/kali/Documents/backend-api
    Status:   ready (fresh) | Files: 38 | Symbols: 215
    Indexed:  2026-10-14T21:00:12.801Z
```

#### `kai list -s` (Managed Sessions & Cache)
```bash
kai list -s
```
```text
[kai] Managed Sessions & Cache (3 files):
  Sessions (2 in /home/kali/.kai/sessions):
    - session_e2b57f01a8cd3241.json
    - session_48f901ab3c2d1190.json
  Cache (1 in /home/kali/.kai/cache):
    - ast_tokens_cache.bin
```

#### `kai list -c` (Current Configuration)
```bash
kai list -c
```
```text
[kai] Current Configuration:
{
  "defaultTokenBudget": 4000,
  "maxFileSizeBytes": 524288,
  "indexingDepth": 20,
  "telemetryLocal": true
}
```

---

### 3.3 Agent Configuration (`kai setup <agent|all>`)

Auto-wires Kai's Model Context Protocol (MCP) server into an agent's configuration file.
Existing configuration files are backed up automatically (`.kai.bak`) before modification.

**Syntax**:
```bash
kai setup <agent|all> [options]
```

**Options**:
- `--print`: Print the MCP configuration snippet without writing to disk.
- `--dry-run`: Preview changes and file targets without modifying files.
- `--force`: Overwrite existing Kai MCP configuration entries.
- `--project`: Write to project-local configuration instead of global.

**Examples**:
```bash
# Auto-wire Kai into Claude
kai setup claude

# Auto-wire Kai into all detected installed agents
kai setup all

# Preview the configuration snippet for Cursor without writing
kai setup cursor --print
```

**Sample Output**:
```text
[kai] Auto-wired kai MCP entry in ~/.claude.json.
[kai] Previous config backed up to: ~/.claude.json.kai.bak
[kai] Restart Claude Code so it picks up the kai MCP server.
```

---

### 3.4 Resource Removal (`kai remove [flags]`)

Safely removes Kai-owned indexes, agent MCP configurations, or session cache files.
**Repository source code is NEVER touched.**

**Syntax**:
```bash
kai remove [options]
```

**Options**:
- `-i, --index <path|id>`: Delete project index from `~/.kai/projects/<id>`.
- `-a, --agent <name>`: Remove Kai MCP configuration from the specified agent.
- `-s, --session [target]`: Delete session cache files.
- `--dry-run`: Preview what would be deleted without making changes.

**Examples**:
```bash
# Preview index removal for current project
kai remove -i . --dry-run

# Remove project index by directory path or 16-hex project ID
kai remove -i .
kai remove -i /home/kali/Documents/my-project
kai remove -i e2b57f01a8cd3241

# Remove Kai MCP configuration from Claude
kai remove -a claude

# Remove all session and cache files
kai remove -s
```

**Sample Output (`kai remove -i .`)**:
```text
[kai] Remove Project Index Scope:
  Project:           "my-project" (id: e2b57f01a8cd3241)
  Index data:        /home/kali/.kai/projects/e2b57f01a8cd3241
  NOTE: Only Kai-owned data under ~/.kai/projects/ is removed.
  NOTE: The repository at /home/kali/Documents/my-project is NOT touched.
[kai] Project "my-project" index deleted.
```

**Sample Output (`kai remove -a claude`)**:
```text
[kai] Removed kai MCP entry from ~/.claude.json.
```

---

### 3.5 Project Dependency Graph (`kai graph <init|update|status> [path]`)

Manage and inspect the AST dependency graph and symbol database.

**Syntax**:
```bash
kai graph <init|update|status> [path]
```

**Subcommands**:
- `init`: Build a full initial symbol and dependency index for the project.
- `update`: Force a full rebuild and update of the project symbol index.
- `status`: Show the current graph status, file count, and symbol count.

**Examples**:
```bash
# Initialize graph in current directory
kai graph init .

# Rebuild / update graph for a project
kai graph update .

# Check graph status
kai graph status .
```

**Sample Output (`kai graph init .`)**:
```text
[kai] Initializing graph for "my-project"...
[kai] Index ready!
- Files indexed: 142
- Symbols indexed: 890
- Project rules loaded: 3
- Incremental changes: +142 added, ~0 modified, ->0 renamed, -0 deleted
```

**Sample Output (`kai graph status .`)**:
```text
[kai] Graph Status for "my-project":
  Files Indexed:   142
  Symbols Indexed: 890
  Last Indexed:    2026-10-14T22:15:30.124Z
Tip: Run 'kai graph update [path]' to force re-indexing.
```

---

### 3.6 Project Status (`kai status [path]`)

Displays project metadata, freshness, semantic LSP availability, and git commit-msg hook state.

**Syntax**:
```bash
kai status [path]
```

**Sample Output**:
```text
[kai] Project Status:
  Name:             my-project
  ID:               e2b57f01a8cd3241
  Root:             /home/kali/Documents/my-project
  Canonical:        /home/kali/Documents/my-project
  Registered:       2026-10-14T20:00:00.000Z
  Last Indexed:     2026-10-14T22:15:30.124Z
  Status:           ready
  Files Indexed:    142
  Symbols Indexed:  890
  Freshness:        fresh
  Commit Hook:      installed (managed by kai)
  Semantic Mode:    active (LSP connected)
```

---

### 3.7 Code Mode Control (`kai stop`)

Clears the persisted Code Mode active project state and returns Kai Terminal to standard terminal mode. Does not touch index data or repository files.

**Syntax**:
```bash
kai stop
```

**Sample Output**:
```text
[kai] Code Mode cleared — back to plain terminal mode.
```

---

### 3.8 Environment Diagnostics & LSP Status

#### `kai doctor`
Audits the local environment, desktop binary paths, data storage directories, and Linux desktop drawer (`.desktop`) integration.

**Syntax**:
```bash
kai doctor
```

**Sample Output**:
```text
[kai] Doctor — environment & install diagnostics (kai v0.1.4)
  Platform:          linux/x64 (node v20.18.0)
  KAI_HOME:          /home/kali/.kai
  Desktop app binary: /usr/bin/kai
  Linux app-drawer entries mentioning kai: 1
    - /usr/share/applications/kai.desktop
      Name: Kai Terminal
      Exec: /usr/bin/kai ✓ -> /usr/bin/kai
      Icon: kai ✓
```

#### `kai lsp`
Probes local Language Server Protocol (LSP) servers installed on your `PATH` (TypeScript, Python, Rust, Go, C/C++, etc.).

**Syntax**:
```bash
kai lsp
```

**Sample Output**:
```text
[kai] Language Server Protocol (LSP) Bridge Status:
  ✓ typescript   typescript-language-server   Available (installed)
  ✓ python       pyright                      Available (installed)
  ✓ rust         rust-analyzer                Available (installed)
  ✗ golang       gopls                        Not Found
    └─ Install hint: go install golang.org/x/tools/gopls@latest
```

#### `kai metrics [clear]`
View or clear local, privacy-safe telemetry summary (latencies, token heuristics, operation breakdown).

**Syntax**:
```bash
kai metrics
kai metrics clear
```

---

## 4. Quick Reference Cheatsheet

| Command | Environment | Description |
| :--- | :--- | :--- |
| `kai open [path]` | External / Any | Opens or focuses Kai Terminal desktop application |
| `kai close` | External / Any | Closes running Kai Terminal instances |
| `kai <agent> [path]` | Internal | Launches agent with auto-MCP wiring, Code Mode, and graph auto-sync |
| `kai list` / `kai list -a` | Internal | Lists installed AI agents and Kai MCP wiring status |
| `kai list -i` | Internal | Lists indexed projects, status, and symbol metrics |
| `kai list -s` | Internal | Lists managed sessions and cache files |
| `kai list -c` | Internal | Lists current configuration settings |
| `kai setup <agent\|all>` | Internal | Auto-wires Kai MCP into an agent or all agents |
| `kai remove -i <path\|id>` | Internal | Deletes project index (repository code is untouched) |
| `kai remove -a <name>` | Internal | Un-wires Kai MCP from an agent configuration |
| `kai remove -s [target]` | Internal | Clears session and cache files |
| `kai graph init [path]` | Internal | Builds initial AST symbol index & dependency graph |
| `kai graph update [path]` | Internal | Forces update and rebuild of project graph |
| `kai graph status [path]` | Internal | Shows graph index file and symbol counts |
| `kai status [path]` | Internal | Shows project health, commit hook, and LSP status |
| `kai stop` | Internal | Clears Code Mode state, back to plain terminal mode |
| `kai doctor` | Internal | Runs install, binary PATH, and desktop drawer audit |
| `kai lsp` | Internal | Probes local Language Server Protocol (LSP) availability |
| `kai metrics` | Internal | Displays local privacy-safe operation telemetry |
