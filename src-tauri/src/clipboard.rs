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

// ---------------------------------------------------------------------------
// Files and images on the clipboard
// ---------------------------------------------------------------------------
//
// A terminal can only receive text, so "paste a file / an image" means pasting
// its PATH: files copied in Explorer / Finder / a file manager paste as their
// paths, and a copied image (a screenshot, "Copy image" in a browser) is saved
// to a PNG in the temp folder and pasted as that path. AI CLIs and `kai teams`
// recognise an image path and attach the picture.

/// Most paths handed back for one paste.
#[cfg_attr(target_os = "macos", allow(dead_code))]
const MAX_PASTE_PATHS: usize = 20;
/// Saved clipboard images older than this are deleted on the next paste.
const PASTE_KEEP_SECS: u64 = 24 * 60 * 60;

/// Folder for pasted clipboard images (created on demand).
///
/// On macOS and Linux the temp folder is shared, so a fixed name there would
/// let another user plant a symlink or a folder first. The folder is per user
/// (`$XDG_RUNTIME_DIR` when there is one), created `0700`, and refused unless it
/// is a plain folder nobody else can enter. Windows temp folders are per user.
fn paste_dir() -> Result<std::path::PathBuf, TerminalError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
        let base = std::env::var_os("XDG_RUNTIME_DIR")
            .map(std::path::PathBuf::from)
            .filter(|p| p.is_dir())
            .unwrap_or_else(std::env::temp_dir);
        let user = std::env::var("USER").unwrap_or_default();
        let name = if user.is_empty() || user.contains(['/', '\\']) {
            "kai-paste".to_string()
        } else {
            format!("kai-paste-{user}")
        };
        let dir = base.join(name);
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&dir)
            .map_err(|e| TerminalError::IoError(format!("Cannot create paste folder: {e}")))?;
        let meta = std::fs::symlink_metadata(&dir)
            .map_err(|e| TerminalError::IoError(format!("Cannot check paste folder: {e}")))?;
        if !meta.is_dir() || meta.permissions().mode() & 0o077 != 0 {
            return Err(TerminalError::IoError(
                "The paste folder is not private to you; refusing to use it".into(),
            ));
        }
        Ok(dir)
    }
    #[cfg(not(unix))]
    {
        let dir = std::env::temp_dir().join("kai-paste");
        std::fs::create_dir_all(&dir)
            .map_err(|e| TerminalError::IoError(format!("Cannot create paste folder: {e}")))?;
        Ok(dir)
    }
}

/// Delete saved pastes older than a day. Best effort: errors are ignored.
fn prune_old_pastes(dir: &std::path::Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let now = std::time::SystemTime::now();
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !(name.starts_with("paste-") && name.ends_with(".png")) {
            continue;
        }
        let old = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| now.duration_since(t).ok())
            .is_some_and(|age| age.as_secs() > PASTE_KEEP_SECS);
        if old {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// Decode `%XX` escapes (invalid escapes are kept as they are).
#[cfg_attr(any(not(unix), target_os = "macos"), allow(dead_code))]
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok();
            if let Some(v) = hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Absolute local paths from a `text/uri-list` clipboard payload. Comments,
/// non-`file:` entries and relative paths are skipped.
#[cfg_attr(any(not(unix), target_os = "macos"), allow(dead_code))]
fn parse_uri_list(text: &str) -> Vec<String> {
    text.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .filter_map(|l| {
            let rest = l
                .strip_prefix("file://localhost")
                .or_else(|| l.strip_prefix("file://"))?;
            let path = percent_decode(rest);
            path.starts_with('/').then_some(path)
        })
        .take(MAX_PASTE_PATHS)
        .collect()
}

#[cfg(all(unix, not(target_os = "macos")))]
fn run_bytes(program: &str, args: &[&str]) -> Option<Vec<u8>> {
    let out = std::process::Command::new(program)
        .args(args)
        .output()
        .ok()?;
    out.status.success().then_some(out.stdout)
}

/// Paths of files on the clipboard, or of a PNG saved from a clipboard image.
/// Empty when the clipboard holds neither (plain text, nothing).
pub fn read_clipboard_attachments() -> Result<Vec<String>, TerminalError> {
    let dir = paste_dir()?;
    prune_old_pastes(&dir);
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let png = dir.join(format!("paste-{millis}.png"));

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        // -STA: the Windows clipboard API needs a single-threaded apartment.
        // The PNG path travels in an environment variable, not the command
        // line, so odd characters in the temp path can never be misparsed.
        let out = std::process::Command::new("powershell")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-STA",
                "-Command",
                "Add-Type -AssemblyName System.Windows.Forms,System.Drawing;\
                 [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);\
                 $cb=[System.Windows.Forms.Clipboard];\
                 if($cb::ContainsFileDropList()){\
                   foreach($f in $cb::GetFileDropList()){[Console]::Out.WriteLine($f)}\
                 } elseif($cb::ContainsImage()){\
                   $cb::GetImage().Save($env:KAI_PASTE_PNG,[System.Drawing.Imaging.ImageFormat]::Png);\
                   [Console]::Out.WriteLine($env:KAI_PASTE_PNG)\
                 }",
            ])
            .env("KAI_PASTE_PNG", &png)
            .creation_flags(0x08000000)
            .output()
            .map_err(|e| TerminalError::IoError(format!("Cannot read clipboard: {e}")))?;
        if !out.status.success() {
            return Err(TerminalError::IoError("Cannot read clipboard".into()));
        }
        Ok(String::from_utf8_lossy(&out.stdout)
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .take(MAX_PASTE_PATHS)
            .map(str::to_string)
            .collect())
    }
    #[cfg(target_os = "macos")]
    {
        let osa = |args: &[&str]| {
            std::process::Command::new("osascript")
                .args(args)
                .output()
                .ok()
                .filter(|o| o.status.success())
        };
        if let Some(o) = osa(&["-e", "POSIX path of (the clipboard as «class furl»)"]) {
            let p = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if p.starts_with('/') {
                return Ok(vec![p]);
            }
        }
        let png_str = png.to_string_lossy().into_owned();
        let saved = osa(&[
            "-e",
            "on run argv",
            "-e",
            "set d to (the clipboard as «class PNGf»)",
            "-e",
            "set f to open for access (POSIX file (item 1 of argv)) with write permission",
            "-e",
            "set eof f to 0",
            "-e",
            "write d to f",
            "-e",
            "close access f",
            "-e",
            "end run",
            &png_str,
        ]);
        Ok(if saved.is_some() && png.exists() {
            vec![png_str]
        } else {
            Vec::new()
        })
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        /// How to ask one clipboard tool what it holds and for each kind of content.
        struct Tool {
            program: &'static str,
            list_args: &'static [&'static str],
            uri_args: &'static [&'static str],
            image_args: &'static [&'static str],
        }
        let tools = [
            Tool {
                program: "wl-paste",
                list_args: &["--list-types"],
                uri_args: &["--type", "text/uri-list"],
                image_args: &["--type", "image/png"],
            },
            Tool {
                program: "xclip",
                list_args: &["-selection", "clipboard", "-t", "TARGETS", "-o"],
                uri_args: &["-selection", "clipboard", "-t", "text/uri-list", "-o"],
                image_args: &["-selection", "clipboard", "-t", "image/png", "-o"],
            },
        ];
        for Tool {
            program,
            list_args,
            uri_args,
            image_args,
        } in tools
        {
            let Some(types) = run_bytes(program, list_args) else {
                continue; // tool missing or clipboard empty: try the next one
            };
            let types = String::from_utf8_lossy(&types).into_owned();
            let has = |t: &str| types.lines().any(|l| l.trim() == t);
            if has("text/uri-list") {
                if let Some(bytes) = run_bytes(program, uri_args) {
                    let paths = parse_uri_list(&String::from_utf8_lossy(&bytes));
                    if !paths.is_empty() {
                        return Ok(paths);
                    }
                }
            }
            if has("image/png") {
                if let Some(bytes) = run_bytes(program, image_args) {
                    if !bytes.is_empty() && std::fs::write(&png, &bytes).is_ok() {
                        return Ok(vec![png.to_string_lossy().into_owned()]);
                    }
                }
            }
            return Ok(Vec::new());
        }
        Ok(Vec::new())
    }
    #[cfg(not(any(unix, target_os = "windows")))]
    {
        let _ = png;
        Ok(Vec::new())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uri_list_gives_decoded_absolute_paths() {
        let text = "# copied\r\nfile:///home/a/My%20Shot.png\r\nfile://localhost/tmp/b.txt\r\nhttps://example.com/x\r\nfile://relative.png\r\n\r\n";
        assert_eq!(
            parse_uri_list(text),
            vec!["/home/a/My Shot.png".to_string(), "/tmp/b.txt".to_string()]
        );
    }

    #[test]
    fn uri_list_caps_the_number_of_paths() {
        let text: String = (0..50).map(|i| format!("file:///tmp/f{i}\n")).collect();
        assert_eq!(parse_uri_list(&text).len(), MAX_PASTE_PATHS);
    }

    #[test]
    fn percent_decode_keeps_bad_escapes_and_unicode() {
        assert_eq!(percent_decode("a%20b"), "a b");
        assert_eq!(percent_decode("100%"), "100%");
        assert_eq!(percent_decode("%zz%4"), "%zz%4");
        assert_eq!(percent_decode("%E4%B8%96"), "世");
    }

    #[test]
    fn prune_removes_only_old_paste_pngs() {
        let dir = std::env::temp_dir().join(format!("kai-paste-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let fresh = dir.join("paste-1.png");
        let other = dir.join("keep.txt");
        std::fs::write(&fresh, b"x").unwrap();
        std::fs::write(&other, b"x").unwrap();
        prune_old_pastes(&dir);
        assert!(fresh.exists(), "a fresh paste must survive");
        assert!(other.exists(), "unrelated files must never be deleted");
        let _ = std::fs::remove_dir_all(&dir);
    }

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
