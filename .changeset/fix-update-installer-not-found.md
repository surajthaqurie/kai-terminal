---
"kai-terminal": patch
---

Fix "Update installer not found" when updating inside Kai, on every OS. The check that the downloaded installer is the file Kai itself saved added the `kai-update-` prefix a second time, so it rejected every download (the unit test for it never ran in CI because it was gated behind the desktop feature). The update also now installs the build for the machine's CPU: before, an Apple Silicon Mac or a Windows ARM64 PC could be given the Intel/x64 installer, since the WebView reports the wrong architecture.
