---
"kai-terminal": patch
---

Music Time now pauses by itself while you are on a call and resumes when the call ends. Kai notices when a known call app (Teams, Zoom, Meet, WhatsApp, Phone Link, ...) starts recording from your microphone, on Windows, macOS and Linux (Linux needs `pactl`); dictation and recorders do not pause it. Music you had already paused stays paused. Turn it off in Settings > "Pause music during calls".

Pasting no longer asks for clipboard permission. Ctrl+Shift+V, Cmd+V and Shift+Insert use the native paste, and the toolbar Paste button reads the clipboard through the OS (PowerShell, `pbpaste`, `wl-paste` / `xclip` / `xsel`) instead of the WebView, so the "Allow Kai to see text and images copied to the clipboard?" prompt never appears.
