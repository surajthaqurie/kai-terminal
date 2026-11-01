---
"kai-terminal": patch
---

The footer **Code Mode** pill is now display-only. Clicking it used to flip the footer to "Terminal" while the agent was still running in Code Mode, so the footer disagreed with the terminal. Code Mode now ends only when `kai <agent>` exits or `kai stop` runs.
