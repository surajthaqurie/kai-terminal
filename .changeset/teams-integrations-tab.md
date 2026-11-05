---
"kai-terminal": minor
---

Microsoft Teams in the Integrations tab.

- **A Teams card next to Azure DevOps**: connect, test the connection and sign out from the desktop app. Channel messages are asked for by default, so the card shows only your account. If an administrator has to approve them, Kai signs in without them and the card adds `Channel messages need admin approval.` with a **Try again** button. **Switch account** replaces the signed-in account (Teams keeps one).
- **Still your account only**: Teams is not tied to a folder and is never handed to an AI agent. The card talks to the CLI over the same private channel as Azure DevOps, the token stays in the OS secret store and never reaches the window, and every Teams request is refused when an AI agent's session is running it.
- **Clear when it cannot work**: a build with no Microsoft Entra app registered shows "Not set up" with a pointer to `docs/teams-sign-in.md` and keeps the Connect button disabled, instead of failing after you click.
