//! Cross-platform "launch at startup" (autostart) support.
//!
//! OS-native mechanisms, no new dependencies:
//! - Windows: `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` value
//!   `KaiTerminal` (via `reg.exe query/add/delete`, no `winreg` crate needed).
//! - Linux: `~/.config/autostart/com.kai.terminal.desktop` (XDG Autostart,
//!   honors `$XDG_CONFIG_HOME`).
//! - macOS: `~/Library/LaunchAgents/com.kai.terminal.plist` (`RunAtLoad`).
//!
//! All file-based paths resolve the home directory from env at call time so
//! unit tests can redirect them with temp env vars. Mutating the real user
//! registry/autostart entries happens only through the two public entry
//! points below, which are exposed as Tauri commands.

use crate::error::TerminalError;

pub const AUTOSTART_APP_NAME: &str = "KaiTerminal";
pub const AUTOSTART_LINUX_DESKTOP_FILENAME: &str = "com.kai.terminal.desktop";
pub const AUTOSTART_MACOS_PLIST_FILENAME: &str = "com.kai.terminal.plist";

/// Returns true when launch-at-startup is currently enabled for this user.
pub fn is_autostart_enabled() -> bool {
    #[cfg(target_os = "windows")]
    {
        is_windows_autostart_enabled()
    }
    #[cfg(target_os = "linux")]
    {
        linux_autostart_file().is_some_and(|p| p.exists())
    }
    #[cfg(target_os = "macos")]
    {
        macos_autostart_file().is_some_and(|p| p.exists())
    }
    #[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
    {
        false
    }
}

/// Enables or disables launch-at-startup for the current user.
pub fn set_autostart_enabled(enabled: bool) -> Result<(), TerminalError> {
    let exe = std::env::current_exe()
        .map(|p| p.to_string_lossy().to_string())
        .map_err(|e| TerminalError::AutostartFailed(format!("Cannot resolve app path: {}", e)))?;
    set_autostart_enabled_with_exe(enabled, &exe)
}

fn set_autostart_enabled_with_exe(enabled: bool, exe_path: &str) -> Result<(), TerminalError> {
    #[cfg(target_os = "windows")]
    {
        set_windows_autostart(enabled, exe_path)
    }
    #[cfg(target_os = "linux")]
    {
        set_linux_autostart(enabled, exe_path)
    }
    #[cfg(target_os = "macos")]
    {
        set_macos_autostart(enabled, exe_path)
    }
    #[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
    {
        let _ = (enabled, exe_path);
        Err(TerminalError::AutostartFailed(
            "Autostart is not supported on this platform".into(),
        ))
    }
}

// ---------------------------------------------------------------------------
// Windows (reg.exe, zero new crates)
// ---------------------------------------------------------------------------

#[cfg(target_os = "windows")]
const WINDOWS_RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";

#[cfg(target_os = "windows")]
fn is_windows_autostart_enabled() -> bool {
    std::process::Command::new("reg")
        .args(["query", WINDOWS_RUN_KEY, "/v", AUTOSTART_APP_NAME])
        .output()
        .is_ok_and(|out| out.status.success())
}

#[cfg(target_os = "windows")]
fn set_windows_autostart(enabled: bool, exe_path: &str) -> Result<(), TerminalError> {
    if exe_path.contains('\0') {
        return Err(TerminalError::AutostartFailed(
            "App path contains NUL byte".into(),
        ));
    }
    // Quote the path so `C:\Program Files\...` survives the Run key.
    let value = format!("\"{}\"", exe_path.trim_matches('"'));
    let status = if enabled {
        std::process::Command::new("reg")
            .args([
                "add",
                WINDOWS_RUN_KEY,
                "/v",
                AUTOSTART_APP_NAME,
                "/t",
                "REG_SZ",
                "/d",
                &value,
                "/f",
            ])
            .status()
    } else {
        std::process::Command::new("reg")
            .args(["delete", WINDOWS_RUN_KEY, "/v", AUTOSTART_APP_NAME, "/f"])
            .status()
    };
    match status {
        Ok(s) if s.success() => Ok(()),
        // Deleting a value that does not exist exits non-zero; disabling an
        // already-disabled entry is a successful no-op.
        Ok(_) if !enabled => Ok(()),
        Ok(s) => Err(TerminalError::AutostartFailed(format!(
            "reg.exe exited with status {}",
            s
        ))),
        Err(e) => Err(TerminalError::AutostartFailed(format!(
            "Failed to run reg.exe: {}",
            e
        ))),
    }
}

// ---------------------------------------------------------------------------
// Linux (XDG Autostart .desktop file)
// ---------------------------------------------------------------------------

#[cfg(target_os = "linux")]
fn linux_autostart_dir() -> Option<std::path::PathBuf> {
    let base = std::env::var("XDG_CONFIG_HOME")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .map(std::path::PathBuf::from)
        .or_else(|| {
            std::env::var("HOME")
                .ok()
                .filter(|v| !v.trim().is_empty())
                .map(|h| std::path::Path::new(&h).join(".config"))
        })?;
    Some(base.join("autostart"))
}

#[cfg(target_os = "linux")]
fn linux_autostart_file() -> Option<std::path::PathBuf> {
    linux_autostart_dir().map(|d| d.join(AUTOSTART_LINUX_DESKTOP_FILENAME))
}

#[cfg(target_os = "linux")]
fn linux_desktop_contents(exe_path: &str) -> String {
    format!(
        "[Desktop Entry]\nType=Application\nName=Kai Terminal\nComment=Kai Terminal - launch at startup\nExec=\"{}\"\nTerminal=false\nCategories=System;TerminalEmulator;\nX-GNOME-Autostart-enabled=true\n",
        exe_path.replace('"', "")
    )
}

#[cfg(target_os = "linux")]
fn set_linux_autostart(enabled: bool, exe_path: &str) -> Result<(), TerminalError> {
    let file = linux_autostart_file().ok_or_else(|| {
        TerminalError::AutostartFailed("Cannot resolve ~/.config/autostart".into())
    })?;
    if !enabled {
        if file.exists() {
            std::fs::remove_file(&file).map_err(|e| {
                TerminalError::AutostartFailed(format!("Cannot remove {}: {}", file.display(), e))
            })?;
        }
        return Ok(());
    }
    if exe_path.contains('\0') {
        return Err(TerminalError::AutostartFailed(
            "App path contains NUL byte".into(),
        ));
    }
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent).map_err(|e| {
            TerminalError::AutostartFailed(format!("Cannot create {}: {}", parent.display(), e))
        })?;
    }
    std::fs::write(&file, linux_desktop_contents(exe_path)).map_err(|e| {
        TerminalError::AutostartFailed(format!("Cannot write {}: {}", file.display(), e))
    })?;
    Ok(())
}

// ---------------------------------------------------------------------------
// macOS (LaunchAgent plist)
// ---------------------------------------------------------------------------

#[cfg(target_os = "macos")]
fn macos_autostart_file() -> Option<std::path::PathBuf> {
    let home = std::env::var("HOME")
        .ok()
        .filter(|v| !v.trim().is_empty())?;
    Some(
        std::path::Path::new(&home)
            .join("Library")
            .join("LaunchAgents")
            .join(AUTOSTART_MACOS_PLIST_FILENAME),
    )
}

#[cfg(target_os = "macos")]
fn macos_plist_contents(exe_path: &str) -> String {
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist version=\"1.0\">\n<dict>\n\t<key>Label</key>\n\t<string>com.kai.terminal</string>\n\t<key>ProgramArguments</key>\n\t<array>\n\t\t<string>{}</string>\n\t</array>\n\t<key>RunAtLoad</key>\n\t<true/>\n</dict>\n</plist>\n",
        xml_escape(exe_path)
    )
}

#[cfg(target_os = "macos")]
fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

#[cfg(target_os = "macos")]
fn set_macos_autostart(enabled: bool, exe_path: &str) -> Result<(), TerminalError> {
    let file = macos_autostart_file().ok_or_else(|| {
        TerminalError::AutostartFailed("Cannot resolve ~/Library/LaunchAgents".into())
    })?;
    if !enabled {
        if file.exists() {
            std::fs::remove_file(&file).map_err(|e| {
                TerminalError::AutostartFailed(format!("Cannot remove {}: {}", file.display(), e))
            })?;
        }
        return Ok(());
    }
    if exe_path.contains('\0') {
        return Err(TerminalError::AutostartFailed(
            "App path contains NUL byte".into(),
        ));
    }
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent).map_err(|e| {
            TerminalError::AutostartFailed(format!("Cannot create {}: {}", parent.display(), e))
        })?;
    }
    std::fs::write(&file, macos_plist_contents(exe_path)).map_err(|e| {
        TerminalError::AutostartFailed(format!("Cannot write {}: {}", file.display(), e))
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_autostart_entry_points_do_not_panic() {
        // Read-only probe must never panic on any OS.
        let _ = is_autostart_enabled();
    }

    #[test]
    fn test_set_autostart_rejects_nul_path() {
        let err = set_autostart_enabled_with_exe(true, "bad\0path")
            .expect_err("NUL path must be rejected");
        assert!(err.to_string().contains("NUL"));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn test_linux_desktop_roundtrip_in_temp_xdg_home() {
        let tmp = std::env::temp_dir().join(format!("kai-autostart-test-{}", std::process::id()));
        // SAFETY: single-threaded test process env mutation for our own lookup.
        unsafe {
            std::env::set_var("XDG_CONFIG_HOME", &tmp);
        }
        let exe = "/opt/kai/kai";
        set_autostart_enabled_with_exe(true, exe).expect("enable");
        let file = linux_autostart_file().expect("path");
        assert!(file.exists(), "desktop file must exist after enable");
        let body = std::fs::read_to_string(&file).expect("read");
        assert!(body.contains("[Desktop Entry]"));
        assert!(body.contains(exe));
        assert!(is_autostart_enabled());
        set_autostart_enabled_with_exe(false, exe).expect("disable");
        assert!(!file.exists(), "desktop file must be gone after disable");
        assert!(!is_autostart_enabled());
        let _ = std::fs::remove_dir_all(&tmp);
        unsafe {
            std::env::remove_var("XDG_CONFIG_HOME");
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn test_linux_desktop_contents_shape() {
        let body = linux_desktop_contents("/opt/kai/kai");
        assert!(body.starts_with("[Desktop Entry]\n"));
        assert!(body.contains("X-GNOME-Autostart-enabled=true"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn test_macos_plist_contents_shape() {
        let body = macos_plist_contents("/Applications/Kai.app/Contents/MacOS/kai");
        assert!(body.contains("<key>RunAtLoad</key>"));
        assert!(body.contains("<true/>"));
        assert!(body.contains("com.kai.terminal"));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn test_windows_run_key_shape() {
        assert!(WINDOWS_RUN_KEY.contains("CurrentVersion\\Run"));
        assert_eq!(AUTOSTART_APP_NAME, "KaiTerminal");
    }
}
