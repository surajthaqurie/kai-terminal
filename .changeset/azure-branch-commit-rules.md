---
"kai-terminal": minor
---

Azure DevOps projects can now set a merge branch that agents use for every work item.

- A **Merge branch** list behind **More** on the Azure DevOps card, filled from the repository's real branches. A branch the repository does not have is refused when you save (offline, it is accepted as typed). Only a change from the default is stored, and it survives switching project.
- New `kai_workflow_rules` MCP tool. It returns the merge branch, or the repository's default branch when none is set, so new branches start there and pull requests target it.
- It is guidance: nothing is validated or blocked when an agent commits or pushes.
