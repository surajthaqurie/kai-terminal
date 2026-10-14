# Commands

## Open and close

Run these from any shell.

### kai open

Launch Kai. Without a path it uses the current folder.

```bash
kai open
kai open /path/to/project
```

### kai close

Quit Kai.

```bash
kai close
```

## Run tool

Replace `<agent>` with your tool's command.

### kai <agent>

Run a tool on a project. Kai connects it to your code and updates the map when it finishes.

```bash
kai claude .
```

### kai stop

Leave tool mode. Maps and files are kept.

```bash
kai stop
```

## Setup & MCP

### kai mcp

Manage the Model Context Protocol (MCP) server and agent connections.

```bash
kai mcp .               # start local MCP stdio server for this folder
kai mcp <agent>         # wire Kai MCP into an agent (e.g. kai mcp claude)
kai mcp all             # wire all detected tools automatically
kai mcp list            # check MCP server info and connected agents
kai mcp remove <agent>  # disconnect a tool from Kai MCP
```

### kai setup

Connect one tool, or every installed tool (alias for `kai mcp <agent>`).

```bash
kai setup <agent>
kai setup all
```

Options: `--print` (preview only), `--dry-run` (show what would change), `--force` (replace existing entry), `--project` (project settings instead of global).

### kai list

Look things up. The default view shows tools.

- `kai list mcp` / `kai list -m` — MCP server state and tool connections
- `kai list -a` — installed tools and connection state
- `kai list -i` — mapped projects
- `kai list -s` — session and cache files
- `kai list -c` — current settings

### kai remove

Delete Kai's own data. Your code is never touched.

- `kai remove -m <name>` — disconnect a tool from Kai MCP (e.g. `kai remove -m claude`)
- `kai remove -a <name>` — disconnect a tool
- `kai remove -i .` — a project's map (`--dry-run` previews first)
- `kai remove -s` — session and cache files

## Project graph

### kai graph

Build or check the code map.

#### kai graph init

Build the map from scratch.

```bash
kai graph init .
```

#### kai graph update

Rebuild the map now.

```bash
kai graph update .
```

#### kai graph status

Show map size and age.

```bash
kai graph status .
```

### kai status

Project health on one screen: map state, hook state, language support.

```bash
kai status .
```

## Check

### kai doctor

Check version, data folder, and desktop app.

```bash
kai doctor
```

### kai lsp

Check installed language servers. A missing one prints its install command.

```bash
kai lsp
```

### kai metrics

Local timing stats. `kai metrics clear` wipes them.

```bash
kai metrics
kai metrics clear
```
