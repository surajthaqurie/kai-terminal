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
✔ Kai v0.2.2 is ready

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

Connect Kai's MCP server to an outside service so your AI tools can read it. Today that is Azure DevOps (work items, pull requests, builds). Signing in is per user and shared by every folder; each folder has exactly one active project. Microsoft Teams chat (below) is set up the same way but belongs to you, not to a folder.

> These commands can run directly in any standard terminal (Bash, Zsh, PowerShell) or inside a Kai Terminal tab. The organization, project and repository always come from the folder's git remote, when it has one, so there is usually nothing to type.

---

### In the desktop app

The same setup is in **AI CLI Providers → Integrations**. It reads the same sign-ins and the same per-folder connection as the commands below.

- **Connect Azure DevOps** generates one Microsoft sign-in address, opens it in your browser, and carries on by itself when you finish. There is nothing to fill in: no app ID, no directory. Prefer not to use the browser? Use the Azure CLI or a token as described next.
- **Sign in with** the Azure CLI (run `az login` first; Kai stores nothing) or an **access token (PAT)**. A personal access token is a password-like key you create in Azure DevOps so Kai can read your work items, pull requests and builds. **Open the token page in your browser** takes you to `https://dev.azure.com/<organization>/_usersSettings/tokens`: choose **New Token**, give it read access to Work Items, Code and Build, copy it and paste it into Kai.
- **One step to active.** The organization, project and repository come from the folder's git remote. Signing in for that organization also makes it active for the folder. With no matching remote, a project and repository picker opens instead.
- **Several accounts, one active.** A folder has exactly one active account. The active account is marked **Active**; every other signed-in account has **Make active**. The project comes from the folder's git remote (a folder with no Azure DevOps remote shows **Choose project**). Each organization has a single sign-in: connecting it again replaces the old one, whether it used the Azure CLI or a token.
- **Accounts are grouped by person.** The card lists each signed-in user once, with their organizations underneath. A user with several organizations has **Sign out all**, which asks first. **Add account** opens Microsoft's account picker; afterwards Kai says which organizations were added, when an organization now uses a different user, and when you were already signed in with that account. If another account is already active for the folder it stays active: use **Make active** to switch.
- **Browser sign-in needs no setup from you.** Kai signs in through one Microsoft Entra app that ships with the build, so you only sign in with your own account. If a build does not have that app yet, **Connect Azure DevOps** is turned off and says so; sign in from a terminal with `kai integration azure --az` (Azure CLI) or `--pat-stdin` (access token) instead. For CI and for testing an app, `KAI_AZURE_CLIENT_ID` (and `KAI_AZURE_TENANT_ID` for a single-tenant app) override it. Maintainers: `docs/azure-devops-sign-in.md`.
- **No refresh button.** The Azure DevOps and Microsoft Teams cards re-read their status by themselves when you open the tab and whenever the window regains focus, so a sign-in or change made from a terminal (for example `kai integration azure` or `kai azure remove`) shows up as soon as you come back. Re-reading changes nothing and does not rewrite any MCP configuration. Agent tools follow the connection on their own: Kai tells a running agent when its tool list changes (MCP `tools/list_changed`); restart an agent that does not honor it.
- **Merge branch (More).** Once a folder is active, **More** on the card shows a **Merge branch** box. Type the branch name yourself; Kai does not load the repository's branches. It is where agents start new branches and which branch their pull requests go into; leaving it empty means the repository's own default branch. When you **Save**, and again when a pull request is opened, Kai checks that one name and says if the repository has no such branch (names are case-sensitive; if the repository cannot be reached, a typed branch is saved as is). Agents read it through the `kai_workflow_rules` tool. It is guidance: Kai never checks or blocks a commit or a push. It is per folder and survives switching project. **Remove** puts it back to the repository default.
- **Branch naming (More).** Under the merge branch, **Branch naming (regex)** takes an optional regular expression that new branch names should match, such as `^(feature|bugfix)/\d+-[a-z0-9-]+$`. The field wraps and grows as you type (a few lines, then it scrolls) and counts characters against the 200-character limit; a longer pattern is never cut off, it is marked and cannot be saved, and line breaks cannot be typed or pasted. A broken pattern is explained under the field and cannot be saved (for example an unclosed group, slashes around the pattern, or a pattern that matches an empty name); a pattern without `^` and `$` only gets a tip. Agents read it through `kai_workflow_rules`. **Remove** clears it and agents choose their own names. It is guidance: Kai never checks a branch name.
- **Azure DevOps Server (on-premises).** The desktop app has no button for it for now. Set it up from a terminal with `kai integration azure --server-url <url> --pat-stdin`; the account then appears in the list (shown as `collection @ host`) with **Make active** and **Sign out**, and **Enter token** appears if its token is ever lost.

---

### kai integration list

- Show every integration and where it stands for the current folder: not set up, signed in but not used here, active here, or needing a new sign-in.

```bash
kai integration list            # add --json for scripts
```

---

### kai integration azure

- One command sets Azure DevOps up for the current folder. It is safe to run again: it checks what is already done and only asks about what is missing.
- **Sign-in:** reuses a working sign-in, or signs in with the Azure CLI (offering to run `az login` for you) or an access token. If this build of Kai has no browser sign-in set up (no Microsoft app registered for it), it says so and uses the Azure CLI or an access token on its own. Tokens go to the OS secret store (Windows DPAPI, macOS Keychain piped via stdin without argv exposure, Linux Secret Service), never to a file in a repository or an agent config. Concurrent token requests reuse in-flight authentication calls.
- **Project (auto-detected):** organization, project and repository come from the folder's git remotes: `dev.azure.com`, `*.visualstudio.com`, their SSH forms, and Azure DevOps Server `https://<host>/<collection>/<project>/_git/<repo>` addresses. An Azure DevOps Server **SSH** remote (`ssh://user@host/<collection>/<project>/_git/<repo>`, `user@host:<collection>/<project>/_git/<repo>` or `user@host:v3/<collection>/<project>/<repo>`) does not say the server's web address, so Kai only suggests `https://<host>/<collection>` (no SSH port, no virtual directory such as `/tfs`) and **asks you to confirm it before signing in to it**; in a script it stops and prints the exact `--server-url` command to run instead. If you are already signed in to that very address, or you pass `--server-url` yourself, it does not ask. It works from any sub-folder of the repository, ignores a trailing `.git`, and never reads a credential embedded in the remote. If the repository has several Azure remotes it asks which one (or uses `origin`'s and says so). With no Azure remote you pick from a list. Names are checked against what Azure really has and stored with their true spelling, and a remote's project is never paired with a different organization's account.
- **Agents:** wires Kai's MCP server into every installed agent that is not wired yet (the same as `kai mcp all`, after asking once). Supports both global agent configs (e.g. `~/.claude.json`) and project-scoped configs (e.g. `.mcp.json` for Claude Code, `.cursor/mcp.json`, `.vscode/mcp.json`). Nothing else in an agent's config is touched.
- **Safety & Boundaries:** work item searches and custom WIQL queries are strictly validated to ensure they remain scoped within the active project boundary, preventing cross-project information leakage.
- **Check:** makes a small real call for work items, pull requests and builds, so a token that signs in but cannot read is caught now, with a hint about the missing scope.

```bash
kai integration azure                       # run inside the project folder (also: ado)
kai integration azure --yes                 # no questions (scripts)
kai integration azure --org contoso --pat-stdin   # token piped in, never an argument
kai integration azure --project Payments --repo api   # when there is no Azure DevOps remote
kai integration azure --no-agents           # do not touch any agent's config
```

Other options: `--az` (use the Azure CLI), `--server-url <url>` (Azure DevOps Server, which signs in with an access token: pipe it with `--pat-stdin`, because on-premises servers do not accept the Azure CLI's tokens). A running agent is told when the tool list changes, so one that honors MCP `tools/list_changed` picks the tools up on its own; restart any that does not.

**Settings of a connected folder.** These run on their own (not together with the options above) and need the folder to be connected already. They do not sign in again.

```bash
kai integration azure --merge-branch main                      # where agents start new branches and open pull requests
kai integration azure --branch-pattern "^feature/[0-9]+-[a-z-]+$"   # a regular expression new branch names should match
kai integration azure --clear-merge-branch --clear-branch-pattern   # back to the repository default / no rule
kai integration azure --allow-writes                           # let agents comment, change a state, open pull requests (asks first)
kai integration azure --no-writes                              # read-only again (the default)
```

- `--merge-branch` and `--branch-pattern` are the same two settings as **More** on the desktop card, with the same checks: a branch the repository does not have is refused (offline, it is accepted as typed), and a broken pattern is explained and not saved. Quote the pattern (in `cmd.exe`, use double quotes so `^` is kept). They are guidance for agents (`kai_workflow_rules`); Kai never checks a branch name or blocks a commit.
- `--allow-writes` adds six tools that change data as you: `kai_work_item_comment`, `kai_work_item_set_state`, `kai_work_item_create`, `kai_work_item_update`, `kai_pr_create` and `kai_pr_comment` (see `MCP.md`). It is off by default, per folder, and only you can turn it on: it asks first (`-y`/`--yes` answers for you in a script) and refuses to run inside an AI agent's session. They never create branches, merge or delete. A personal access token needs **Work Items (Read & write)** and **Code (Read & write)** for them; Azure CLI and browser sign-ins use your own permissions. `kai integration list` shows when write tools are on.

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

In the desktop app, the same actions are in the **Integrations** tab of the AI CLI providers panel (robot icon in the header).

---

### kai integration teams

- **In the desktop app:** the Integrations tab has a **Microsoft Teams** card next to Azure DevOps. **Connect Microsoft Teams** opens your browser (it runs through the `kai` command line, so a current `kai` must be on PATH), and the card also offers **Test connection** and **Sign out**. Channel messages are asked for by default, so the card shows only your account. If your organization has not approved them it adds `Channel messages need admin approval.` and a **Try again** button. **Switch account** replaces the signed-in account (Teams keeps one). A build with no Microsoft app ID shows **Not set up** and keeps Connect disabled. The chat itself (`kai teams`) runs in a terminal tab.
- Set up Microsoft Teams chat. Unlike Azure DevOps it is not tied to a folder or an AI agent: it is your own account, shared by every terminal.
- **Sign-in:** opens your browser, you sign in with your Microsoft account, and Kai remembers it. Safe to run again: it reuses a working sign-in. The token goes to the OS secret store (Windows DPAPI, macOS Keychain, Linux Secret Service), never to a file in a repository.
- **Access:** checks that your teams and chats can be read, and tells you whether channel messages can be read too. Channel messages are asked for by default. Reading what others wrote in a channel needs an administrator's approval in most organizations: when that is the case Kai signs in without it, says so, and you can try again after approval with `--channels`. Chats and sending to channels work without it.
- **Sign out:** `remove` forgets the account and deletes its token.

```bash
kai integration teams              # sign in and check access
kai integration teams --channels   # sign in again to add channel messages, after an administrator approved them
kai integration teams remove       # sign out and forget this account
```

---

### kai teams

- The Teams chat, in the tab you run it in. A list of your teams, channels and chats on the left, the conversation on the right, a message box at the bottom. Everything is clickable, and everything also works from the keyboard. It runs in any terminal, inside Kai Terminal or not. Want it in its own tab? Open a new tab (Ctrl+T) and run it there.
- **Pictures show in the conversation.** Where the terminal draws images (iTerm2, WezTerm, mintty, Kai Terminal) they appear inline. Elsewhere each one is a line you click to open it in your image viewer. A link to another site says which site it opens before you click.
- **Send an image or file:** copy it and press **Ctrl+V**, or click **Attach**, or paste its path (Kai Terminal pastes copied files as paths). It shows above the message box; click its **x** (or press Backspace on an empty box) to remove it. Images go inline in the message; other files are uploaded to your OneDrive and shared as a link for people in your organization. Up to 4 items per message, 250 MB in total (a picture over 4 MB goes as a link instead of inline). Large files show their upload progress.
- **Keys:** Enter sends, Ctrl+J starts a new line, Up and Down switch conversation while the box is empty, PageUp and PageDown (or the mouse wheel) scroll, Esc clears the attachments, then the text, then leaves. Ctrl+C also leaves.
- **It keeps itself up to date.** The open conversation refreshes every few seconds (every 30 seconds while the window is not focused, and at once when you come back). The chat list refreshes every 20 seconds, with the most recent chats first and a **●** next to any chat or channel that has messages from others you have not seen. Channels and chats you have opened in this session are checked too, so their dot stays right. A new message in another conversation shows a notice, and rings the terminal bell when the window is not focused. Edits and deletions show up. The header shows the state: `synced 09:41`, `offline, retry 09:42:10` (it backs off and recovers by itself) or `sign-in expired` (leave and run `kai integration teams`).
- **Older messages:** scroll to the top (PageUp or the mouse wheel), or click the line there, to load the page before.
- **Sending:** your message appears at once marked `sending...` and the box is free for the next one. If Teams refuses it, the message goes away and your text and attachments come back. Each conversation keeps its own half-written message while you switch.
- **It is for you, not your AI agents.** There is no command that lists, reads or posts without a person at the keyboard, the Teams sign-in is never given to an agent (not in its environment, its config or Kai's MCP server), and both Teams commands refuse to run inside an agent's session, whether Kai started the agent or not: a known agent CLI (Claude Code, Codex, Gemini, Copilot, OpenCode, Aider, Cline and others) among the processes that started the command, or the variable an agent sets on its commands, is enough.

```bash
kai teams                          # open the chat here (first time: kai integration teams)
```

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
