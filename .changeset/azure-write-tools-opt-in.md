---
"kai-terminal": minor
---

Azure DevOps agents can now write, but only where you turn it on. Write tools are off by default and are not even listed until you run `kai integration azure --allow-writes` in a folder (`--no-writes` turns them off again).

- Four new MCP tools: `kai_work_item_comment`, `kai_work_item_set_state`, `kai_pr_create` and `kai_pr_comment`. They add a work item comment, change a work item's state, open a pull request between two branches that already exist (it never creates a branch, and defaults to the merge branch rule), and comment on a pull request as a new thread, on a file line, or as a reply. Each tool's description says it writes to the remote service.
- Only a person decides: `--allow-writes` asks first (`-y/--yes` answers in a script) and refuses to run inside an AI agent's session, and no MCP tool can change the setting. The setting lives in the folder's private connection file, not in the repository, and is dropped if the folder is connected to a different account or project.
- Checked on every call, not just when the tool list is built, so an agent that kept an old tool list cannot write after you turn writes off. Inputs are validated and length-capped (too long is refused, never cut), a work item or pull request of another project fails closed, a state change refuses to overwrite an edit made since it was read, comment text is escaped, and tokens are redacted from errors.
- Nothing new to sign in with: browser and Azure CLI sign-ins use your own Azure DevOps permissions. A personal access token needs Work Items (Read & write) and Code (Read & write); a refused write names the missing scopes. `kai integration list` and `kai_integration_status` show when write tools are on, and the desktop app can read and set it through the new `set_write_tools` request.
