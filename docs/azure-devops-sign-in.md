# Azure DevOps browser sign-in

> Maintainers: the one-time setup for Azure DevOps and Teams sign-in is in [microsoft-sign-in-setup.md](microsoft-sign-in-setup.md).

Kai signs users in to Azure DevOps through their browser (OAuth 2.0 authorization
code with PKCE, against Microsoft Entra). The user clicks **Connect Azure DevOps**,
signs in with their Microsoft account, and Kai finds their organizations on its own:
there is no organization, token or sign-in method to type.

This needs one thing from the maintainers: an Entra **app registration** for Kai.
It is a public client, so it has no secret and nothing sensitive ships in the app.
Its ID is a constant in the build. **Users never enter it**: there is no sign-in app form,
no client ID and no directory to type. **Connect** generates one Microsoft sign-in
address, opens it in the browser, and finishes on its own.

## Register the app (once)

1. Open the [Entra admin center](https://entra.microsoft.com) > **Identity** >
   **Applications** > **App registrations** > **New registration**.
2. **Name:** `Kai Terminal`.
3. **Supported account types:** *Accounts in any organizational directory and
   personal Microsoft accounts*. Users sign in from their own tenant, so it must
   be multi-tenant.
4. **Redirect URI:** platform **Mobile and desktop applications** (public client),
   value `http://localhost`. Entra ignores the port for `localhost`, and Kai picks a
   free port each time.
5. **Register**, then open **Authentication** and make sure **Allow public client
   flows** is **Yes**.
6. Open **API permissions** > **Add a permission** > **Azure DevOps** >
   **Delegated permissions** > **user_impersonation** > **Add permissions**.
   No admin consent is required for it.
7. Copy the **Application (client) ID** from **Overview**.

## Put the client ID in the build (maintainers, once)

Set the ID when the CLI is built; nothing is edited in source. In GitHub, add a repository
**variable** (Settings > Secrets and variables > Actions > **Variables**) named
`KAI_AZURE_CLIENT_ID` with the ID from step 7. `release.yml` passes it to the build as
`KAI_BUILD_AZURE_CLIENT_ID`, and `vite.cli.config.ts` bakes it into the CLI bundle. For a local
build or `npm publish`, export `KAI_BUILD_AZURE_CLIENT_ID` first (`prepack` runs the build).

- A value that is not a GUID **fails the build**, so a typo never ships.
- With no value the build still succeeds with a warning and has no built-in app. Add the repository
  variable `KAI_REQUIRE_SIGNIN_APP` = `1` (or export `KAI_REQUIRE_SIGNIN_APP=1`) to fail such a
  build instead, once the ID is set up.

It is public (a variable, not a secret). Teams uses the same registration (or
`KAI_BUILD_TEAMS_CLIENT_ID` / the `KAI_TEAMS_CLIENT_ID` variable for a Teams-only app; or
`KAI_TEAMS_CLIENT_ID`: see `teams-sign-in.md`). The registration must be multi-tenant (step 3),
so the sign-in goes through the `common` directory and every user signs in from their own tenant.

**Until it is set**, this build has no app to sign in with, and Kai handles that openly:

- In the desktop app, **Connect Azure DevOps** is disabled. The card says browser sign-in is not
  set up in this build and points to the terminal: `kai integration azure --az` (Azure CLI) or
  `--pat-stdin` (access token). Nothing asks the user for an app ID.
- `kai integration azure` falls back to the Azure CLI or an access token and says why.

**Environment variables** (CI, or to test a registration before it is built in):
`KAI_AZURE_CLIENT_ID` and, for a single-tenant app, `KAI_AZURE_TENANT_ID`. They win over the
built-in ID, and a malformed value is reported by name instead of silently using another app.

Microsoft's sign-in errors are translated into what to change: an unknown client ID
(*AADSTS700016*), a single-tenant app (*AADSTS50194*, set `KAI_AZURE_TENANT_ID`), a missing
`http://localhost` redirect (*AADSTS50011*), a missing consent (*AADSTS65001*) and a registration
that is not a public client (*AADSTS7000218*).

## How it works

- The CLI starts a listener on `127.0.0.1` (random port), opens the Microsoft
  sign-in page, and waits up to 5 minutes for the redirect. The redirect is only
  accepted with the matching `state`; the code is traded using the PKCE verifier.
- Kai reads the signed-in user and the organizations they belong to from
  `app.vssps.visualstudio.com`, and saves one account per organization. Each
  account keeps its own copy of the refresh token in the OS secret store, so signing
  one out never breaks another.
- Access tokens last about an hour. Kai refreshes them shortly before they expire
  and stores the rotated refresh token. If the refresh is refused (password change,
  revoked access, 90 days unused), the user is asked to connect again.

## Permissions for write tools

Kai's agent tools only read until you run `kai integration azure --allow-writes` for a folder. Writing needs no extra sign-in step and no extra scope on the browser sign-in: it asks for `user_impersonation`, the same delegated permission reads use, so what an agent can change is limited by what *you* can change in Azure DevOps. The same is true of the Azure CLI. Only an **access token (PAT)** carries its own scopes: for write tools it needs **Work Items (Read & write)** and **Code (Read & write)** (a read-only token keeps working for reads, and a refused write names the missing scopes).

## Not handled by browser sign-in

- **Azure DevOps Server** (on-premises) cannot use Entra sign-in. The desktop
  app has no button for it for now; sign in from a terminal:
  `kai integration azure --server-url <url> --pat-stdin`. A server account that
  is already signed in is listed on the card, and **Enter token** there replaces
  an expired or missing token.
- **Scripts and CI** can keep using `--pat-stdin` (an access token on stdin) or
  `--az` (the Azure CLI's sign-in). The desktop app offers neither for Azure
  DevOps Services; its Server form takes an access token.
- An organization that is backed by a **different Entra tenant** than the one the
  user signed in with can reject the token. Sign in with the account from that tenant.
