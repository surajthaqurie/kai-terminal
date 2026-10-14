# Commands

Kai is a desktop terminal with a built-in CLI for running AI coding tools on your code. Commands outside Kai launch or quit the app. Everything else runs inside Kai.

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

## Setup

### kai setup

Connect one tool, or every installed tool.

```bash
kai setup <agent>
kai setup all
```

Options: `--print` (preview only), `--dry-run` (show what would change), `--force` (replace existing entry), `--project` (project settings instead of global).

### kai list

Look things up. The default view shows tools.

- `kai list -a` — installed tools and connection state
- `kai list -i` — mapped projects
- `kai list -s` — session and cache files
- `kai list -c` — current settings

### kai remove

Delete Kai's own data. Your code is never touched.

- `kai remove -i .` — a project's map (`--dry-run` previews first)
- `kai remove -a <name>` — disconnect a tool
- `kai remove -s` — session and cache files

## Project graph

### kai graph

Build or check the code map.

```bash
kai graph init .    # build from scratch
kai graph update .  # rebuild now
kai graph status .  # size and age
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
