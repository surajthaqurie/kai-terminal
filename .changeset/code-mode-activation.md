---
"kai-terminal": patch
---

Fix `kai code .` not activating Code Mode, on all OSes. The badge previously synced only on Enter *before* the CLI ran (the state file is written during execution, after indexing), with no post-execution re-sync and no focus change inside Kai's own tab — so the badge stayed stale. `kai` state-changing lines (`code` / `stop` / `clear` / direct path) now schedule post-execution re-syncs, and `kai code` persists the state file before the slow indexing pass so activation is fast on large repos. Backend state lookup now mirrors the CLI's home precedence (`KAI_HOME` > `XDG_DATA_HOME/kai` > `~/.kai`), fixing Linux systems where `XDG_DATA_HOME` sent the CLI and app to different state files. Directory matching also tolerates the macOS `/private` alias (`realpath` vs logical `$PWD`). Combined with the Windows OSC 9;9 cwd tracking, the footer path, git badge, and Code Mode badge now follow `cd` + `kai code .` in every pane.
