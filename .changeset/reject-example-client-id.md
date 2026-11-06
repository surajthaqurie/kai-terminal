---
"kai-terminal": patch
---

Microsoft sign-in refuses example app IDs instead of sending you to a Microsoft error page.

- **Example IDs are rejected**: the RFC 4122 example UUID (`f81d4fae-…`) and the all-zero ID are well-formed GUIDs, so they used to be saved and used, and Microsoft answered `AADSTS700016` on its own page (Kai never saw it and the sign-in just waited). `kai integration teams --client-id`, `KAI_TEAMS_CLIENT_ID`, `KAI_AZURE_CLIENT_ID` and the build-time IDs now refuse them with a message saying what to copy instead.
- **Self-healing**: an example ID that an earlier Kai saved in `~/.kai/config.json` is ignored, so `kai teams` asks for a real one.
- **Clearer prompt**: when Kai asks for the Application (client) ID it now says where to find it in Microsoft Entra, and that the Directory and Object IDs do not work. The "app not found" explanation also mentions the saved ID.
