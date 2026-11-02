---
"kai-terminal": patch
---

Music player: the play, pause, next, previous, mute, volume and seek buttons now control the video in the desktop app.

- **Buttons did nothing on desktop**: the player was told it lived on `youtube-nocookie.com` instead of the app's real address (`http://tauri.localhost` on Windows). YouTube only accepts commands from the address it was given, so every button changed its own icon but the video kept playing, and the title and time never updated. The real address is now passed, so the buttons and the footer mini-player act on the video.
- **macOS and Linux**: those builds have no address YouTube accepts, so the player cannot be remote-controlled there. It now shows YouTube's own controls on the video and a notice explaining why, instead of buttons that silently do nothing.
- **Dim button**: pressing it a second time now closes its popover (it used to reopen it).
- **Random**: one of the four random songs (the Lofi Girl live radio) forbids embedding and left a dead player. It is replaced with a video that plays.
- **Unplayable videos**: Next and Previous no longer switch the button to "Pause" for a video YouTube refused to play; they show the reason instead.
