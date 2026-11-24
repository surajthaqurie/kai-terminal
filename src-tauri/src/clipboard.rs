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

/// Clipboard text is handed to the frontend in pieces of at most this many
/// bytes, so one IPC response stays small however big the paste is. There is
/// no cap on the total.
pub const CLIPBOARD_CHUNK_MAX: usize = 4 * 1024 * 1024;

fn decode(bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(bytes);
    text.strip_prefix('\u{feff}').unwrap_or(&text).to_string()
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
// Text handed over in pieces
// ---------------------------------------------------------------------------
//
// A paste can be hundreds of megabytes. Instead of one giant IPC response the
// frontend opens a session (the backend reads the clipboard once and holds the
// text), pulls it piece by piece, then closes it. A session id stops a second
// paste from mixing its text into a read that is still in progress.

#[derive(serde::Serialize)]
pub struct ClipboardSession {
    pub id: u64,
    /// Total size in bytes.
    pub len: usize,
}

#[derive(serde::Serialize, Debug, PartialEq, Eq)]
pub struct ClipboardChunk {
    pub text: String,
    /// Byte offset to ask for next; equals the total length when finished.
    pub next: usize,
}

/// The text of a clipboard read in progress: session id, the text, and when it was read.
type HeldClipboard = Option<(u64, String, std::time::Instant)>;

static CLIPBOARD_SESSION: std::sync::Mutex<HeldClipboard> = std::sync::Mutex::new(None);

/// How long a read may stay held. A paste takes well under a second; the text can be a password,
/// so a frontend that crashes between `begin` and `end` must not leave it in memory (SEC-13).
const CLIPBOARD_HOLD: std::time::Duration = std::time::Duration::from_secs(60);

/// Drops the held text when it is older than `max_age` at `now`. Returns whether none is held.
fn sweep_held_clipboard(
    held: &mut HeldClipboard,
    now: std::time::Instant,
    max_age: std::time::Duration,
) -> bool {
    if held
        .as_ref()
        .is_some_and(|(_, _, at)| now.saturating_duration_since(*at) >= max_age)
    {
        *held = None;
    }
    held.is_none()
}

/// Starts (at most one) background sweeper that clears an expired held text. It sleeps while
/// nothing is held and ends when the hold is empty, so an idle app has no timer running.
fn schedule_clipboard_expiry() {
    use std::sync::atomic::{AtomicBool, Ordering};
    static RUNNING: AtomicBool = AtomicBool::new(false);
    if RUNNING.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(|| loop {
        std::thread::sleep(CLIPBOARD_HOLD);
        let empty = {
            let mut guard = CLIPBOARD_SESSION.lock().unwrap_or_else(|e| e.into_inner());
            sweep_held_clipboard(&mut guard, std::time::Instant::now(), CLIPBOARD_HOLD)
        };
        if empty {
            RUNNING.store(false, Ordering::SeqCst);
            // A read may have started between the check and the store: take over if so.
            let again = CLIPBOARD_SESSION
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .is_some();
            if again && !RUNNING.swap(true, Ordering::SeqCst) {
                continue;
            }
            break;
        }
    });
}
static CLIPBOARD_SESSION_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// One piece of `text` starting at byte `offset` (moved forward to a character
/// boundary), at most `max` bytes (cut back to a boundary, but never empty
/// while text remains).
fn chunk_of(text: &str, offset: usize, max: usize) -> ClipboardChunk {
    let mut start = offset.min(text.len());
    while !text.is_char_boundary(start) {
        start += 1;
    }
    let mut end = start.saturating_add(max.max(1)).min(text.len());
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    if end == start && start < text.len() {
        // `max` is smaller than one character: take that character whole.
        end = start + 1;
        while !text.is_char_boundary(end) {
            end += 1;
        }
    }
    ClipboardChunk {
        text: text[start..end].to_string(),
        next: end,
    }
}

/// Read the clipboard text once and hold it for `clipboard_text_chunk`.
pub fn clipboard_text_begin() -> Result<ClipboardSession, TerminalError> {
    let text = read_clipboard_text()?;
    let id = CLIPBOARD_SESSION_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
    let len = text.len();
    *CLIPBOARD_SESSION.lock().unwrap_or_else(|e| e.into_inner()) =
        Some((id, text, std::time::Instant::now()));
    schedule_clipboard_expiry();
    Ok(ClipboardSession { id, len })
}

/// The next piece of the held clipboard text for session `id`.
pub fn clipboard_text_chunk(
    id: u64,
    offset: usize,
    max: usize,
) -> Result<ClipboardChunk, TerminalError> {
    let guard = CLIPBOARD_SESSION.lock().unwrap_or_else(|e| e.into_inner());
    match guard.as_ref() {
        Some((held, text, _)) if *held == id => {
            Ok(chunk_of(text, offset, max.min(CLIPBOARD_CHUNK_MAX)))
        }
        _ => Err(TerminalError::IoError(
            "Clipboard read was replaced by a newer one".into(),
        )),
    }
}

/// Drop the held text (only if it still belongs to session `id`).
pub fn clipboard_text_end(id: u64) {
    let mut guard = CLIPBOARD_SESSION.lock().unwrap_or_else(|e| e.into_inner());
    if guard.as_ref().is_some_and(|(held, _, _)| *held == id) {
        *guard = None;
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
    fn a_held_clipboard_text_expires() {
        use std::time::{Duration, Instant};
        let t0 = Instant::now();
        let mut held: HeldClipboard = Some((7, "hunter2".to_string(), t0));
        // Fresh: kept.
        assert!(!sweep_held_clipboard(
            &mut held,
            t0 + Duration::from_secs(5),
            CLIPBOARD_HOLD
        ));
        assert!(held.is_some());
        // Past the limit: gone, whatever session it was.
        assert!(sweep_held_clipboard(
            &mut held,
            t0 + CLIPBOARD_HOLD + Duration::from_millis(1),
            CLIPBOARD_HOLD
        ));
        assert!(held.is_none());
        // Nothing held is simply "empty".
        assert!(sweep_held_clipboard(&mut held, t0, CLIPBOARD_HOLD));
    }

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
    fn decode_has_no_size_cap() {
        let big = "世".repeat(12 * 1024 * 1024 / 3);
        assert_eq!(decode(big.as_bytes()).len(), big.len());
    }

    #[test]
    fn chunks_reassemble_to_the_exact_text() {
        let text = "héllo 世界 😀 end\r\n".repeat(50);
        for max in [1, 2, 3, 4, 5, 7, 64, 1000] {
            let mut out = String::new();
            let mut offset = 0;
            while offset < text.len() {
                let c = chunk_of(&text, offset, max);
                assert!(!c.text.is_empty(), "must always make progress (max {max})");
                assert!(c.next > offset);
                out.push_str(&c.text);
                offset = c.next;
            }
            assert_eq!(out, text, "max {max}");
        }
    }

    #[test]
    fn chunk_past_the_end_is_empty() {
        let c = chunk_of("abc", 99, 10);
        assert_eq!(
            c,
            ClipboardChunk {
                text: String::new(),
                next: 3
            }
        );
        assert_eq!(chunk_of("", 0, 10).next, 0);
    }

    #[test]
    fn a_newer_session_invalidates_an_older_one() {
        *CLIPBOARD_SESSION.lock().unwrap() = Some((7, "old".into(), std::time::Instant::now()));
        assert_eq!(clipboard_text_chunk(7, 0, 10).unwrap().text, "old");
        assert!(clipboard_text_chunk(6, 0, 10).is_err());
        clipboard_text_end(6);
        assert!(
            clipboard_text_chunk(7, 0, 10).is_ok(),
            "wrong id must not close it"
        );
        clipboard_text_end(7);
        assert!(clipboard_text_chunk(7, 0, 10).is_err());
    }

    #[test]
    fn first_success_skips_missing_programs() {
        assert_eq!(first_success(&[("kai-no-such-program-xyz", &[])]), None);
    }
}
