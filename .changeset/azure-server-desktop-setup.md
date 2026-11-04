---
"kai-terminal": minor
---

Azure DevOps Server can now be set up from the desktop Integrations tab.

- **Server form**: **Azure DevOps Server…** on the Azure DevOps card asks for the server URL (with the collection, such as `https://tfs.contoso.com/DefaultCollection`), an optional project and an access token. A server signs in with a token only, so there is no Azure CLI or browser option here. Problems with the address or token are explained next to the field before anything is sent.
- **Token handling**: the token is verified against the server first and kept in your operating system's secret store only when the server accepts it. It reaches the CLI on stdin, never in a command line, and the form keeps no copy once you are connected.
- **Like any account**: a Server account shows as `collection @ host` with **Make active**, **Sign out** and, if its token is lost, **Enter token**. Leave the project empty to use the folder's git remote when it is on that server, or to pick from a list. Two servers that both have a `DefaultCollection` are no longer mistaken for each other.
