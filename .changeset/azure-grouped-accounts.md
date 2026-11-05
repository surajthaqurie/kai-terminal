---
"kai-terminal": patch
---

Azure DevOps accounts are grouped by who signed in, and the Azure DevOps Server button is gone for now.

- **Grouped accounts**: the card lists each signed-in user once, with their organizations underneath. A user with several organizations gets a **Sign out all** that asks first.
- **Add account**: opens Microsoft's account picker. Afterwards Kai says which organizations were added, when an organization now uses a different user than before, and when you were already signed in with that account. If another account is already active for the folder it stays active.
- **Azure DevOps Server…** is removed from the card. A server account that was set up from the terminal still shows **Enter token** when its token is missing.
- **No sign-in app form**: **Connect** generates one Microsoft sign-in address, opens it in your browser and finishes by itself. Nobody enters an app ID or a directory; Kai signs in through one Microsoft Entra app that ships with the build (`KAI_AZURE_CLIENT_ID` / `KAI_AZURE_TENANT_ID` override it for CI and testing). A build that does not have that app yet turns **Connect** off, says why and points to `kai integration azure --az` / `--pat-stdin`. Teams uses the same app.
- **Clearer sign-in failures**: Microsoft errors for a single-tenant app, an unknown client ID, a missing redirect URI, a missing consent or a non-public client now say what to change.
