---
"kai-terminal": patch
---

Enhance group-wise release architecture and direct download pipelines:
- Implement structured group-wise releases ordered strictly across Apple (macOS), Linux, and Windows platforms with dedicated architecture badges and format indicators.
- Provide direct installer download paths for Apple Silicon macOS (.dmg), Linux x86_64 and ARM64 packages (.deb and portable .AppImage), and Windows 64-bit installers (NSIS .exe and MSI).
- Add interactive platform filtering, command-line quick-install snippets with copy controls, and system prerequisites/security guidance (macOS Gatekeeper xattr, Linux FUSE 2, Windows WebView2 runtime).
- Elevate website changelog presentation with categorized release highlights for v0.1.0, latest release badges, and structured parsing of pending unreleased changesets.
- Synchronize marketing hero quick download pills and installation bar platform order to Apple (macOS), Linux, Windows, and From source.
