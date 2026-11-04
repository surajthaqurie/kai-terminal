---
"kai-terminal": minor
---

Azure DevOps Server projects are now recognized from their SSH git remotes too (`ssh://user@host/<collection>/<project>/_git/<repo>`, `user@host:<collection>/<project>/_git/<repo>` and `user@host:v3/<collection>/<project>/<repo>`).

- An SSH address does not say the server's web address, so Kai derives `https://<host>/<collection>` (no SSH port, no credentials) as a suggestion and asks you to confirm it before signing in to it. In a script it stops and prints the exact `kai integration azure --server-url … --project … --pat-stdin` command instead. Nothing is sent to a guessed host.
- It does not ask when you are already signed in to that exact address or pass `--server-url` yourself. A Server remote now goes straight to the access-token sign-in instead of trying browser sign-in, which only reaches Azure DevOps Services.
- Remotes of GitHub, GitLab, Bitbucket and similar hosts are never mistaken for Azure DevOps Server.
