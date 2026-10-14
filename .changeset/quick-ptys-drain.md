---
"kai-terminal": patch
---

Faster terminal output and tighter resource cleanup on all OSes

- PTY reader: 32 KB read buffer (was 4 KB) so output floods emit up to 8x fewer IPC events, and the per-read OSC cwd scan is skipped for escape-free output.
- Live-cwd probes (`lsof` on macOS, `/proc` on Linux) now run outside the global sessions lock, so a slow probe can no longer stall other tabs' input/resize/close.
- Git probes: stdout is buffered up to a bounded size (the rest is drained, not stored) so huge diffs cannot balloon memory; polling starts at 2 ms instead of 25 ms.
- Terminal rendering: panes now use xterm's GPU (WebGL) renderer instead of the DOM renderer for smoother typing, scrolling and heavy output (TUIs, AI CLIs, builds). Only visible panes hold a WebGL context; any failure or context loss falls back to the DOM renderer. Set `localStorage.kai_renderer = "dom"` to force the old renderer.
- Clicking inside an already-active pane no longer re-renders the whole app (focus handler is a no-op when nothing changes).
- Frontend: window resize/focus listeners that resolve after unmount are now unlistened, and the 20 s PTY-launch timeout timer is cleared once the spawn settles.
- LSP bridge: byte-accurate `Content-Length` framing (multibyte characters split across chunks no longer corrupt messages), no per-message full-buffer re-encoding, 8 MB buffer cap.
- Telemetry: `metrics.jsonl` rotates at 5 MB (one `.1` generation) instead of growing forever.
