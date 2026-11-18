---
"kai-terminal": patch
---

Fixes for several known limitations.

- **Large pastes**: pastes over 1 MB are no longer refused. They are sent in ordered 256 KB chunks, and a keystroke typed during a big paste goes out after it.
- **Mini music player**: the window reopens at the size you left it, the progress bar holds still while YouTube buffers, and moving the video between windows resumes at the exact spot instead of the last whole second.
- **Exact token counts**: `kai_get_context` takes an optional `model`; with an OpenAI model the context is sized with its real tokenizer. The desktop app now ships the tokenizer vocabularies, and `estimateChatTokensAsync` counts chat-message framing.
- **Microsoft Teams card**: paste the Microsoft app ID right in the card, see and copy the sign-in link while it waits, cancel a stuck sign-in, and sign in without channel messages when admin approval blocks it.
- **Integrations tab**: runs the CLI bundled with the app, so an older `kai` on PATH no longer breaks it.
