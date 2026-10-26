//! Native clipboard read, so pasting never triggers a WebView permission
//! prompt.
//!
//! `navigator.clipboard.readText()` makes WebView2 ask "Allow Kai to see text
//! and images copied to the clipboard?" the first time (and WKWebView shows a
//! Paste bubble every time). Reading through the OS avoids both:
//! - Windows: `Get-Clipboard` via PowerShell (UTF-8 out, no console window).
//! - macOS: `pbpaste`.
//! - Linux: `wl-paste`, then `xclip`, then `xsel`, whichever is installed.
//!
//! No new crates, same approach as `autostart.rs`.

use crate::error::TerminalError;

/// Largest clipboard text handed to the frontend; the PTY write path caps
/// input at 1 MB anyway, so more would only be dropped later.
const MAX_CLIPBOARD_BYTES: usize = 1024 * 1024;

fn decode(bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(bytes);
    let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
    if text.len() <= MAX_CLIPBOARD_BYTES {
        return text.to_string();
    }
    let mut end = MAX_CLIPBOARD_BYTES;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end].to_string()
}

#[cfg_attr(not(any(unix, test)), allow(dead_code))]
fn first_success(attempts: &[(&str, &[&str])]) -> Option<String> {
    attempts.iter().find_map(|(program, args)| {
        let out = std::process::Command::new(program)
            .args(*args)
            .output()
            .ok()?;
        out.status.success().then(|| decode(&out.stdout))
    })
}

/// Text currently on the system clipboard (empty when it holds none).
pub fn read_clipboard_text() -> Result<String, TerminalError> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        let out = std::process::Command::new("powershell")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);\
                 [Console]::Out.Write((Get-Clipboard -Raw))",
            ])
            .creation_flags(0x08000000)
            .output()
            .map_err(|e| TerminalError::IoError(format!("Cannot read clipboard: {e}")))?;
        if out.status.success() {
            Ok(decode(&out.stdout))
        } else {
            Err(TerminalError::IoError("Cannot read clipboard".into()))
        }
    }
    #[cfg(target_os = "macos")]
    {
        first_success(&[("pbpaste", &[])])
            .ok_or_else(|| TerminalError::IoError("Cannot read clipboard".into()))
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        first_success(&[
            ("wl-paste", &["--no-newline"]),
            ("xclip", &["-selection", "clipboard", "-o"]),
            ("xsel", &["--clipboard", "--output"]),
        ])
        .ok_or_else(|| {
            TerminalError::IoError("Install wl-clipboard, xclip or xsel to paste".into())
        })
    }
    #[cfg(not(any(unix, target_os = "windows")))]
    {
        Err(TerminalError::IoError(
            "Clipboard is not supported on this platform".into(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decode_strips_bom_and_keeps_unicode() {
        assert_eq!(
            decode("\u{feff}héllo 世界\r\n".as_bytes()),
            "héllo 世界\r\n"
        );
        assert_eq!(decode(b""), "");
    }

    #[test]
    fn decode_caps_size_on_a_char_boundary() {
        let big = "世".repeat(MAX_CLIPBOARD_BYTES);
        let out = decode(big.as_bytes());
        assert!(out.len() <= MAX_CLIPBOARD_BYTES);
        assert!(out.chars().all(|c| c == '世'));
    }

    #[test]
    fn first_success_skips_missing_programs() {
        assert_eq!(first_success(&[("kai-no-such-program-xyz", &[])]), None);
    }
}
