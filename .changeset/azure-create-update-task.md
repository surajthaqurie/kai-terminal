---
"kai-terminal": minor
---

Azure DevOps agents with write tools turned on can now create and update tasks, and link work items when they open a pull request.

- New `kai_work_item_create` makes a work item in the connected project (a `Task` unless you name another type) with a title, description, assignee (`me`, an email or a name), tags, priority, remaining hours, area and sprint, and can place it under a parent item.
- New `kai_work_item_update` changes only the fields it is given. It refuses to overwrite an edit made since the item was read, and its answer lists which fields changed, never their values. Changing the state is still `kai_work_item_set_state`.
- `kai_pr_create` takes `workItemIds` to link up to 20 work items to the new pull request, `reviewers` and `requiredReviewers` (an email or a name each) and `labels`, and its answer lists what was attached. Every linked item, and a parent given to `kai_work_item_create`, must be in the connected project: one from another project fails with `not_found` before anything is created. A reviewer who matches nobody, or several people, also stops the call before the pull request exists.
- Same safety rules as the other write tools: off until a person runs `kai integration azure --allow-writes`, checked on every call, inputs validated and length-capped (never silently cut), description text escaped. Nothing merges or deletes.
