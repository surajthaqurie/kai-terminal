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
✔ Kai v0.2.1 is ready

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

## Integrations

Connect Kai's MCP server to an outside service so your AI tools can read it. Today that is Azure DevOps (work items, pull requests, builds). Signing in is per user and shared by every folder; each folder has exactly one active project.

> These commands run inside a Kai Terminal tab. Outside it they stop with a pointer to `kai open [path]`. The organization, project and repository always come from the folder's git remote, when it has one, so there is usually nothing to type.

---

### In the desktop app

The same setup is in **AI CLI Providers → Integrations**. It reads the same sign-ins and the same per-folder connection as the commands below.

- **Sign in with** the Azure CLI (run `az login` in a Kai Terminal tab first; Kai stores nothing) or an **access token (PAT)**. A personal access token is a password-like key you create in Azure DevOps so Kai can read your work items, pull requests and builds. **Open the token page in your browser** takes you to `https://dev.azure.com/<organization>/_usersSettings/tokens`: choose **New Token**, give it read access to Work Items, Code and Build, copy it and paste it into Kai.
- **One step to active.** The organization, project and repository come from the folder's git remote. Signing in for that organization also makes it active for the folder. With no matching remote, a project and repository picker opens instead.
- **Several accounts, one active.** A folder has exactly one active account. Every other signed-in account has **Make active**, and **Switch project** changes the project inside the active one. Each organization has a single sign-in: connecting it again replaces the old one, whether it used the Azure CLI or a token.
- Azure DevOps Server (on-premises) is set up with the command line only (`--server-url`).

---

### kai integration list

- Show every integration and where it stands for the current folder: not set up, signed in but not used here, active here, or needing a new sign-in.

```bash
kai integration list            # add --json for scripts
```

---

### kai integration azure

- One command sets Azure DevOps up for the current folder. It is safe to run again: it checks what is already done and only asks about what is missing.
- **Sign-in:** reuses a working sign-in, or signs in with the Azure CLI (offering to run `az login` for you) or an access token. Tokens go to the OS secret store (Windows DPAPI, macOS Keychain, Linux Secret Service), never to a file in a repository or an agent config.
- **Project (auto-detected):** organization, project and repository come from the folder's git remotes: `dev.azure.com`, `*.visualstudio.com`, their SSH forms, and Azure DevOps Server `https://<host>/<collection>/<project>/_git/<repo>` addresses. It works from any sub-folder of the repository, ignores a trailing `.git`, and never reads a credential embedded in the remote. If the repository has several Azure remotes it asks which one (or uses `origin`'s and says so). With no Azure remote you pick from a list. Names are checked against what Azure really has and stored with their true spelling, and a remote's project is never paired with a different organization's account.
- **Agents:** wires Kai's MCP server into every installed agent that is not wired yet (the same as `kai mcp all`, after asking once). Nothing else in an agent's config is touched.
- **Check:** makes a small real call for work items, pull requests and builds, so a token that signs in but cannot read is caught now, with a hint about the missing scope.

```bash
kai integration azure                       # run inside the project folder (also: ado)
kai integration azure --yes                 # no questions (scripts)
kai integration azure --org contoso --pat-stdin   # token piped in, never an argument
kai integration azure --project Payments --repo api   # when there is no Azure DevOps remote
kai integration azure --no-agents           # do not touch any agent's config
```

Other options: `--az` (use the Azure CLI), `--server-url <url>` (Azure DevOps Server, which signs in with an access token: pipe it with `--pat-stdin`, because on-premises servers do not accept the Azure CLI's tokens). Restart a running agent session afterwards so it re-reads its tools.

---

### kai azure list

- Show each signed-in account with its projects. The folder's active project is marked `*` and shows its repositories.

```bash
kai azure list                  # --repos shows every project's repositories, --json for scripts
```

---

### kai azure active

- Switch this folder's active project. Switching changes only this folder.

```bash
kai azure active --name Payments            # add --repo <name|none>, --org <name>
kai azure active                            # in a terminal: pick a project and repository from a list
```

---

### kai azure remove

- `kai azure remove` disconnects this folder. Your sign-in and every other folder stay as they are.
- `kai azure remove --name <id>` (or `kai remove --name <id>`) removes an account everywhere: it signs it out, deletes its stored token and disconnects every folder that used it. `<id>` is the account id from `kai integration list` (for example `azure-devops:contoso`) or the organization name. No repository is ever touched.

```bash
kai azure remove                # this folder only
kai remove --name contoso             # shows what it will remove (folders, token), then asks
kai remove --name contoso --yes       # remove it without asking
```

In the desktop app, the same actions are in the **Integrations** tab of the AI CLI providers panel (toolbar robot icon).

## Project graph

Build, rebuild, inspect, or remove the symbol index and import graph.

---

### kai graph

- **What**: Generates a symbol index (from a deterministic text-based scan, not a full parser), an import graph, and a project intelligence map for your codebase.
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
