---
"kai-terminal": patch
---

`kai run` can now launch Windows `.ps1` scripts directly: they run via `powershell.exe -NoProfile -File` (no shell, execution policy respected) instead of failing with `spawn ENOENT`.
