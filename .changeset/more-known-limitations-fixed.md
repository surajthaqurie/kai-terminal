---
"kai-terminal": patch
---

More known limitations fixed.

- **Large Teams files**: a file over 4 MB is now read from disk one 5 MiB piece at a time while it uploads, instead of being held in memory whole. The 250 MB per-file limit and the 250 MB per-message total are gone; one file can now be up to 2 GB, and four of them can go in one message.
- **Commands that leave processes behind (Linux and macOS)**: when `kai run` stops a command on a timeout or Ctrl+C, it now also stops processes the command started and detached from it (`setsid`, a double fork). Every run carries a random token in its environment, and anything still carrying it is stopped, with SIGKILL for what ignores SIGTERM. The result says nothing survived only when that is true. Windows cannot read another process's environment, so there a detached process can still survive and Kai still says so.
- **Azure DevOps Server over SSH**: an SSH remote does not say the web address, so Kai now asks the likely addresses (`https` and `http`, with and without `/tfs`, and the old port `8080`) whether an Azure DevOps Server answers, without sending any credential, and offers the one that does. It still asks before signing in. Only tested against a fake server.
- **Token estimate**: the built-in estimate was about 1.7 to 1.9 times a real tokenizer's count; it is now about 1.3 to 1.4 times, and no file in this repository came out lower than the real count. A lone space no longer costs a token and a line break with its indentation costs one. Context budgets now hold more.
- **Context budgets**: a prompt sitting exactly at its budget no longer has its metrics footer cut off by the caveat line added afterwards; another optional item is dropped first.
- **Secret filter**: `src/core/indexer.ts` can be read through the index and `kai_read_range` again; the detector no longer matches its own source.
- **Music mini window (Windows)**: the WebView2 arguments live only in `tauri.windows.conf.json`; the mini window reads them from there instead of keeping a copy that has to stay in step.
