# Commands

### kai open

- Launch Kai. Without a path it uses the current folder.
- Activates Code Mode for the selected project workspace.
- Creates local stdio Model Context Protocol (MCP) server context for connected AI coding tools.
- Automatically generates and indexes the project graph and symbol dependencies.

```bash
kai open
kai open /path/to/project
```

---

### kai health

- Check system readiness, environment diagnostics, and installation health.
- Verifies Kai CLI version, data directories (`~/.kai`), and desktop app availability.
- Confirms fast, private, and free local status.

```bash
kai health
```

Output:
```text
✔ Kai v0.1.5 is ready

✔ Fast and private · Free
```

## Agents

The `kai agent` group (alias: `kai agents`) manages AI coding tools. Run tools, connect tools to Kai, or inspect tool wiring.

---

### kai <agent>

- Run an AI coding tool on a project (shortform `kai <agent> [path]`).
- Auto-wires Kai MCP configuration if needed.
- Activates Code Mode and generates the project graph.
- Automatically synchronizes code and graph changes when the tool finishes.
- Any binary on your `PATH` works dynamically; extra arguments are forwarded. Advanced passthrough: `kai run -- <command> [args...]`.

```bash
kai <agent> .
```

---

### kai stop

- Leave Code Mode and return to plain terminal mode.
- Preserves all indexed code maps, caches, and project files.

```bash
kai stop
```

---

### kai agent add

- Wire Kai MCP into one tool, or every installed tool automatically.
- Aliases: `add` = `setup` = `install`.

```bash
kai agent add <agent>           # group form (e.g. kai agent add claude)
kai setup <agent>               # top-level alias (also: kai setup --agent <agent>)
kai agent add all               # wire every detected tool (also: kai setup all)
```

Options: `--print` (preview snippet only), `--dry-run` (show what would change), `--force` (replace existing entry), `--project` (project settings instead of global), `--global` (global user config).

---

### kai agent remove

- Disconnect a tool from Kai MCP. Your repository code is never touched.
- Aliases: `remove` = `rm` = `unlink` = `unregister`.

```bash
kai agent remove <agent>        # group form (e.g. kai agent remove claude)
kai remove -a <agent>           # short flag (also: kai remove --agent <agent>)
kai remove -m <agent>           # MCP flag (also: kai remove --mcp <agent>)
```

Option: `--dry-run` previews first. Same pattern for every id: `kai agent remove cursor`, `kai remove -a codex`, `kai remove -m claude`, and so on.

---

### kai list -a

- Show installed tools and connection state (probes live system `PATH` and configs).

```bash
kai list -a                     # list installed tools (also: kai list --agent, kai list)
```

## Project graph

Build, rebuild, inspect, or remove the AST symbol index and dependency graph.

---

### kai graph

- **What**: Generates a high-precision AST symbol index, dependency graph, and project intelligence map for your codebase.
- **Where**: Stored locally and privately in `~/.kai/projects/<project-id>/`. Your repository code is never modified.
- **How**:
  - `kai graph init [path]` — Build the map from scratch. Automatically installs a self-contained `commit-msg` git hook to prevent co-author trailers.
  - `kai graph update [path]` — Rebuild and refresh the map with incremental change detection.
  - `kai graph status [path]` — Inspect map size, symbol counts, file counts, and index freshness.
  - `kai remove -i [path]` — Remove a project's map from `~/.kai/projects/` (`--dry-run` previews first).

```bash
kai graph init .                # build the map from scratch
kai graph update .              # rebuild and refresh map
kai graph status .              # show map size, symbol counts, and freshness
kai remove -i .                 # remove project code map (--dry-run previews first)
```

## Session

Manage active sessions, workspace caches, and editor state.

---

### kai session

- **What**: Manages local session states, window layouts, and runtime caches.
- **Where**: Stored locally in `~/.kai/sessions/` and `~/.kai/cache/`.
- **How**:
  - `kai remove -s [path]` — Clear session and cache files for a project (defaults to `.` current folder; `--dry-run` previews first).
  - `kai remove -s all` — Clear all managed session and cache files across all projects.
  - `kai list -s` — List active session and cache files.

```bash
kai remove -s .                 # remove current project's session and cache
kai remove -s /path/to/project  # remove specific project session
kai remove -s all               # clear all session and cache files
kai list -s                     # list managed session files
```

## Check

Environment, Language Server Protocol, and performance diagnostics.

---

### kai doctor

- Check version, data folder, PATH, and desktop app diagnostics.
- Verifies Node environment, KAI_HOME directories, and GUI executable availability.

```bash
kai doctor
```

---

### kai lsp

- Check installed language servers (`typescript-language-server`, `rust-analyzer`, `pyright`, `gopls`).
- Missing servers print their installation commands.

```bash
kai lsp
```

---

### kai metrics

- View local timing stats, operation counts, and token estimates.
- Wipe local stats with `kai metrics clear`.

```bash
kai metrics
kai metrics clear
```

## Close

Quit Kai Terminal from any shell.

---

### kai close

- Safely terminates active Kai instances across Linux, macOS, and Windows.

```bash
kai close
```
