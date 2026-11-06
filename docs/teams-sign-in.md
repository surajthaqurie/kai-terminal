# Microsoft Teams sign-in

> Maintainers: the one-time setup for Azure DevOps and Teams sign-in is in [microsoft-sign-in-setup.md](microsoft-sign-in-setup.md).

`kai teams` chats in Microsoft Teams from the terminal. Kai signs the user in through
their browser (OAuth 2.0 authorization code with PKCE, against Microsoft Entra) and
talks to Microsoft Graph with their own permissions: they only ever see and send what
they could in Teams itself.

This needs one thing from the maintainers: an Entra **app registration** for Kai. It is
a public client, so it has no secret and nothing sensitive ships in the app. The same
registration can also serve Azure DevOps sign-in (see `azure-devops-sign-in.md`); add the
Graph permissions below to it, or register a second app for Teams.

## Register the app (once)

1. Open the [Entra admin center](https://entra.microsoft.com) > **Identity** >
   **Applications** > **App registrations** > **New registration** (or open the existing
   `Kai Terminal` registration).
2. **Supported account types:** *Accounts in any organizational directory*. Users sign in
   from their own tenant, so it must be multi-tenant.
3. **Redirect URI:** platform **Mobile and desktop applications** (public client), value
   `http://localhost`. Entra ignores the port for `localhost`, and Kai picks a free port.
4. Under **Authentication**, make sure **Allow public client flows** is **Yes**.
5. Under **API permissions** > **Add a permission** > **Microsoft Graph** > **Delegated
   permissions**, add:

   | Permission | Why | Admin approval |
   | --- | --- | --- |
   | `User.Read` | Who is signed in | No |
   | `Team.ReadBasic.All` | The teams you belong to | No |
   | `Channel.ReadBasic.All` | The channels in them | No |
   | `Chat.ReadWrite` | Read and send in your chats (and read images in them) | No |
   | `ChannelMessage.Send` | Post in a channel | No |
   | `Files.ReadWrite` | Upload a file you send to your OneDrive and share a link | No |
   | `ChannelMessage.Read.All` | Read what others wrote in channels | **Yes, in most organizations** |

   `offline_access` is requested automatically so the sign-in lasts.
6. Copy the **Application (client) ID** from **Overview**.

## The client ID

Teams uses the first of these that is set:

1. `KAI_TEAMS_CLIENT_ID` in the environment (CI, testing).
2. The ID **saved on this computer** with `kai integration teams --client-id <ID>` (stored as
   `teams.clientId` in `~/.kai/config.json`). Enter it once; it survives sign-out.
3. A Teams-only ID built into the build (`KAI_TEAMS_CLIENT_ID` in `src/core/teams/oauth.ts`).
4. The Azure DevOps registration: `KAI_AZURE_CLIENT_ID` in the environment, or the app ID built
   into the build (see `azure-devops-sign-in.md`). Setting that built-in one covers both cards.

The ID is a public client ID, not a secret. A saved or environment ID must be an
Application (client) ID in GUID form; the Directory (tenant) ID and Object ID look the same but
will not work. The app must be multi-tenant (step 2 above): Kai signs in through the `common`
endpoint.

Without any client ID:

- `kai integration teams` in a terminal explains the one-time step and asks you to paste the
  Application (client) ID, then saves it and continues to sign-in. With no keyboard (a script),
  it stops with *"Microsoft Teams sign-in is not set up yet"* and the exact command to run.
- The desktop **Microsoft Teams** card shows **Not set up**, keeps **Connect Microsoft Teams**
  disabled, and tells you to run `kai integration teams --client-id <ID>` in a terminal tab.
  Reopen the tab afterwards.

## Signing in from the desktop app

The Integrations tab and the command line use the same code path. **Connect Microsoft
Teams** sends `teams_login` to `kai azure rpc`; the CLI starts a listener on a free
`127.0.0.1` port, opens the Microsoft sign-in page in the default browser (authorization
code with PKCE and a random `state`), exchanges the code for tokens and stores them in the
OS secret store. The window only learns who signed in, never a token. The card also offers
**Test connection**, **Switch account** and **Sign out**. When channel messages are approved
the card shows only the account. If the organization has not approved them it adds
`Channel messages need admin approval.` and a **Try again** button.

Each Teams request is refused when an AI agent's session is running it (the checks under
*Your sign-in and AI agents* below), so an agent cannot use the card's channel either.

## Channel messages are on by default

Reading channels is part of Teams, so the sign-in asks for `ChannelMessage.Read.All` together
with everything else: there is no extra step to turn it on. It needs an administrator's
approval in most organizations. When Microsoft says an administrator has to approve it, Kai
repeats the sign-in once without that one permission, so nobody is locked out of Teams
because of it. The card then says channel messages need admin approval. Once an
administrator has approved Kai, **Try again** (or
`kai integration teams --channels`) signs in again with it. Until it is granted:

- chats (one-to-one, group, meeting) work fully: read, send, images, files;
- sending to a channel works;
- reading a channel shows a note explaining that an administrator has to approve it.

An administrator can approve it for everyone from **Enterprise applications** > Kai >
**Permissions** > **Grant admin consent**.

## Where things are stored

- The token set (access and refresh token) is in the OS secret store: Windows DPAPI, the
  macOS login keychain, or the Linux Secret Service, with a private `0600` file as the last
  resort. It is never written to `config.json`.
- `~/.kai/config.json` keeps a `teams` block: who is signed in and the permissions the
  sign-in was granted. No token.
- Images pasted from the clipboard are saved as PNG files in a private per-user temp folder
  (`kai-paste`, mode 0700 on macOS and Linux) and removed after a day. Images opened from
  the chat go to a private `kai-teams` folder the same way.

## Your sign-in and AI agents

The sign-in belongs to the person, not to the AI agents they run in a terminal:

- The token is never put in an environment variable, a file inside a project, an agent's
  config or Kai's MCP server. Teams is not an MCP integration: no agent tool exists for it.
- `kai teams` is the only thing that uses the sign-in, and it needs a person at an interactive
  terminal. There is no `list`, `read` or `send` command a script or an agent could call.
- `kai teams` and `kai integration teams` (including `remove`) refuse to run when an AI agent
  is running them. Three checks, strongest first:
  1. **The process tree.** If any process that started the command is a known agent CLI (Claude
     Code, Codex, Gemini, Copilot, OpenCode, Aider, Cline, Cursor Agent and the other agents Kai
     supports), it refuses, however the agent was started. The walk stops at the Kai desktop
     app, so a normal Kai tab is never blocked, and editors such as Cursor or VS Code are not
     treated as agents.
  2. **Environment markers.** `KAI_AGENT_SESSION` (set by Kai on every agent started with
     `kai <agent>`) and the variables other agents document for their command shells
     (`CLAUDECODE`, `GEMINI_CLI`, `OPENCODE`, `CURSOR_AGENT`,
     `CODEX_SANDBOX_NETWORK_DISABLED`; best effort). These also work when the tree is broken.
  3. **A person at a terminal.** The chat needs an interactive terminal, which most agent
     command runners do not have.

  The process tree cannot see an agent whose shell was started through a launcher that has
  since exited (this happens: Windows does not re-link orphaned processes), so that case relies
  on the markers and the interactive-terminal rule. If the process list cannot be read at all,
  the check lets the command through rather than lock you out.

What this cannot do: any program running as the same operating-system user, including an
agent that was given a shell, can in principle ask the OS to decrypt that user's secrets
(DPAPI, Keychain, Secret Service). That is how every desktop app's stored sign-in works. Kai
never hands the token to an agent, and the checks above stop the ordinary routes, but they are
not a sandbox. Run agents in a sandbox or container if they must not be able to act as you.

## Limits

- A file Kai sends can be at most **250 MB**: up to 4 MB goes in one request, larger files are uploaded to your OneDrive in chunks (and resumed if the connection drops). A picture is shown inline in the message only up to 4 MB; a larger picture is sent as a link like any other file. Everything attached to one message counts toward the 250 MB, because it is held in memory while it is sent.
- Images appear inline in terminals that draw them (iTerm2, WezTerm, mintty, Kai Terminal).
  Everywhere else they are a clickable line that opens the picture in the system viewer.
  Set `KAI_TEAMS_IMAGES=inline` or `off` to override the guess.
- Only PNG, JPEG and GIF are drawn inline. Other pictures (WebP) open in the viewer.
