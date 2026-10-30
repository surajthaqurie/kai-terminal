# Azure DevOps browser sign-in

Kai signs users in to Azure DevOps through their browser (OAuth 2.0 authorization
code with PKCE, against Microsoft Entra). The user clicks **Connect Azure DevOps**,
signs in with their Microsoft account, and Kai finds their organizations on its own:
there is no organization, token or sign-in method to type.

This needs one thing from the maintainers: an Entra **app registration** for Kai.
It is a public client, so it has no secret and nothing sensitive ships in the app.

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

## Give Kai the client ID

- Release builds: set `KAI_AZURE_CLIENT_ID` in
  `src/core/integrations/providers/azure-devops/oauth.ts` (the constant is empty
  until the app is registered).
- A developer machine or CI can override it with the `KAI_AZURE_CLIENT_ID`
  environment variable, which also lets you test a registration before shipping it.

Without a client ID, **Connect** fails with *"Browser sign-in is not set up in this
build of Kai"* and opens nothing.

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

## Not handled by browser sign-in

- **Azure DevOps Server** (on-premises) cannot use Entra sign-in. Use the
  command-line fallback: `kai integration azure --server-url <url> --pat-stdin`.
- **Scripts and CI** can keep using `--pat-stdin` (an access token on stdin) or
  `--az` (the Azure CLI's sign-in). The desktop app does not offer either.
- An organization that is backed by a **different Entra tenant** than the one the
  user signed in with can reject the token. Sign in with the account from that tenant.
