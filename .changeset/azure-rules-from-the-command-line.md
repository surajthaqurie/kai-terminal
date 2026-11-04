---
"kai-terminal": minor
---

The merge branch and branch naming pattern of an Azure DevOps folder can now be set from the command line, not only from the desktop card.

- `kai integration azure --merge-branch <name>` and `--branch-pattern "<regex>"` set them; `--clear-merge-branch` and `--clear-branch-pattern` remove them. They use the same checks and storage as the desktop: a branch the repository does not have is refused (offline, it is accepted as typed), and a broken pattern is explained and not saved, with a tip for a pattern without `^` and `$`.
- They run on their own in an already connected folder, without signing in again, and are refused when mixed with the options that connect a folder. They stay guidance for agents (`kai_workflow_rules`): Kai still never checks a branch name or blocks a commit.
- `kai integration azure --help` and `kai --help` list the new options.
