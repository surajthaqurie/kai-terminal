---
"kai-terminal": patch
---

Microsoft sign-in no longer needs the app ID edited into source, and Teams can remember one on this computer.

- **Built into releases**: the Entra app ID is set at build time from the `KAI_AZURE_CLIENT_ID` / `KAI_TEAMS_CLIENT_ID` repository variables, so Azure DevOps and Teams sign-in work with one click. A malformed ID fails the build; `KAI_REQUIRE_SIGNIN_APP=1` fails a build that has none.
- **Teams on a build without an app ID**: `kai integration teams --client-id <ID>` saves it in `~/.kai/config.json` (kept when you sign out), and the command asks for it when run at a keyboard with none set. The environment variable still wins.
