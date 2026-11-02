---
"kai-terminal": minor
---

Azure DevOps projects can now set a merge branch and a branch naming pattern that agents use for every work item.

- A **Merge branch** list behind **More** on the Azure DevOps card, filled from the repository's real branches. A branch the repository does not have is refused when you save (offline, it is accepted as typed). Only a change from the default is stored, and it survives switching project.
- A **Branch naming (regex)** field next to it: an optional regular expression new branch names should match. It is checked as you type and when you save, with a plain reason for each problem (a broken pattern, slashes or flags around it, surrounding spaces, more than 200 characters, a nested repeat like `(a+)+`, a pattern that matches an empty name). A pattern without `^` and `$` only gets a tip.
- Both have a **Remove** button. Removing the merge branch goes back to the repository default; removing the naming pattern lets agents choose their own names. Nothing is stored for a cleared field.
- New `kai_workflow_rules` MCP tool. It returns the merge branch, or the repository's default branch when none is set, plus the naming pattern when one is set, so new branches start there, follow the pattern, and pull requests target the merge branch.
- It is guidance: nothing is validated or blocked when an agent commits or pushes.
