---
"kai-terminal": patch
---

Automatic `Co-authored-by:` removal with no new commands: entering Code Mode (`kai code .`) now installs a self-contained git `commit-msg` hook into the repo, so every future commit from any agent (Claude Code, opencode, others) lands without AI trailers and nothing has to be remembered. The hook is POSIX sh plus `grep -v -i` only, so the identical file runs on Linux, macOS, and Windows with no Node dependency; it fails open and never blocks a commit, and pre-existing hooks are preserved and chained. Install is best-effort (non-git folders are unaffected), idempotent, skippable via `kai code . --no-hook`, and visible in `kai status`. Covered by auto-install, opt-out, chaining, and real end-to-end commit tests.
