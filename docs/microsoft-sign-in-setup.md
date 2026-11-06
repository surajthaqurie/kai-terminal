# Microsoft sign-in: one-time setup for maintainers

Azure DevOps and Microsoft Teams sign-in use **one Microsoft Entra app** that you register
once. After that, every user signs in with one click and never sees or types an app ID:

1. They click **Connect** (or run `kai integration azure` / `kai integration teams`).
2. Their browser opens Microsoft's sign-in page. They sign in and approve.
3. Kai keeps them signed in (the token is in the OS secret store and refreshes itself).

This guide is the whole maintainer job. Do it once per product, not once per user.
Details per card: `azure-devops-sign-in.md`, `teams-sign-in.md`.

## 1. Register the app (Entra admin center, about 5 minutes)

Use an account that is allowed to create app registrations in your tenant.

1. Open https://entra.microsoft.com > **Entra ID** > **App registrations** > **New registration**.
2. **Name:** `Kai Terminal`.
3. **Supported account types:** _Accounts in any organizational directory (Any Microsoft Entra ID
   tenant - Multitenant)_. It must be multi-tenant so people sign in from their own organization.
4. **Redirect URI:** platform **Public client/native (mobile & desktop)**, value
   `http://localhost` (no port; Kai picks a free one). Click **Register**.
5. **Authentication** > **Advanced settings** > **Allow public client flows** = **Yes**. Save.
6. **API permissions** > **Add a permission**:
   - **Microsoft Graph** > **Delegated permissions**: `User.Read`, `Team.ReadBasic.All`,
     `Channel.ReadBasic.All`, `Chat.ReadWrite`, `ChannelMessage.Send`, `Files.ReadWrite`,
     `ChannelMessage.Read.All`.
   - **APIs my organization uses** > search **Azure DevOps** (`499b84ac-1321-427f-aa17-267ca6975798`)
     > **Delegated permissions** > `user_impersonation`.
7. **Overview** > copy the **Application (client) ID** (not the Directory ID or Object ID).

Only `ChannelMessage.Read.All` needs an administrator's approval in most organizations. Kai
works without it (chats and sending still work), so do not block on it.

## 2. Give the ID to the build (GitHub, 1 minute)

The ID is public, so it is a repository **variable**, not a secret.

1. Repository **Settings** > **Secrets and variables** > **Actions** > **Variables** tab >
   **New repository variable**.
2. Name `KAI_AZURE_CLIENT_ID`, value the Application (client) ID. Save.
3. Optional: `KAI_TEAMS_CLIENT_ID` for a separate Teams-only app (otherwise Teams shares the app above).
4. Release as usual. `release.yml` passes the variables to the build, which bakes them into the CLI.
   A value that is not a GUID fails the build.

Building locally or running `npm publish`? Export it first:

```powershell
$env:KAI_BUILD_AZURE_CLIENT_ID = "<Application (client) ID>"
npm run build:cli
```

Once it works, add the variable `KAI_REQUIRE_SIGNIN_APP` = `1` so a release without an ID fails
instead of shipping with sign-in turned off.

## 3. Make the consent screen trustworthy (recommended)

On the same app registration:

- **Branding & properties:** name, logo, privacy statement and terms URLs.
- **Publisher verification:** without it users see an "unverified" warning and some organizations
  block the app.
- For organizations that need channel reading: an administrator opens **Enterprise applications** >
  Kai Terminal > **Permissions** > **Grant admin consent**.

## 4. Check it

On a build made after step 2, in a normal terminal (not inside an AI agent):

| Check                                          | Expected                                                            |
| ---------------------------------------------- | ------------------------------------------------------------------- |
| `kai integration teams`                        | Browser opens, you sign in once, it prints your name and your teams |
| `kai integration azure`                        | Browser opens, you sign in once, it lists your organizations        |
| Integrations tab, Teams and Azure DevOps cards | **Connect** is enabled (not "Not set up")                           |
| Run the command again                          | No browser: the saved sign-in is reused                             |

## 5. If something fails

| Microsoft says                 | Fix                                                                                 |
| ------------------------------ | ----------------------------------------------------------------------------------- |
| `AADSTS700016` (app not found) | Wrong ID in the variable. Copy the Application (client) ID again                    |
| `AADSTS50194` (single-tenant)  | Step 1.3: change to multi-tenant                                                    |
| `AADSTS50011` (redirect URI)   | Step 1.4: add `http://localhost` under _Mobile and desktop_                         |
| `AADSTS7000218`                | Step 1.5: turn on **Allow public client flows**                                     |
| `AADSTS65001` / admin approval | Approve in the browser, or ask an administrator (see step 3)                        |
| Card still says "Not set up"   | The build has no ID: check the variable name and that you released after setting it |

## Forks and test builds

A build with no built-in ID can still be used:

- Teams: `kai integration teams --client-id <ID>` (saved on that computer) or the
  `KAI_TEAMS_CLIENT_ID` environment variable.
- Azure DevOps: the `KAI_AZURE_CLIENT_ID` environment variable, or `kai integration azure --az` /
  `--pat-stdin`.
