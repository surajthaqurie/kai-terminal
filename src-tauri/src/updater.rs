use crate::error::TerminalError;
#[cfg(feature = "tauri")]
use std::path::Path;
#[cfg(feature = "tauri")]
use std::path::PathBuf;
#[cfg(feature = "tauri")]
use tauri::{AppHandle, Emitter};

/// Allow-listed hosts for update installer downloads.
///
/// `browser_download_url` values from the GitHub Releases API are
/// `https://github.com/<owner>/<repo>/releases/download/<tag>/<file>`
/// which redirect to `objects.githubusercontent.com` (via
/// `release-assets.githubusercontent.com`). Only these hosts may ever be
/// fetched — never arbitrary user input.
const ALLOWED_UPDATE_HOSTS: &[&str] = &[
    "github.com",
    "objects.githubusercontent.com",
    "release-assets.githubusercontent.com",
];

const UPDATE_RELEASE_PREFIX: &str =
    "https://github.com/surajthaqurie/kai-terminal/releases/download/";

/// Installer extensions we know how to launch per OS.
const ALLOWED_UPDATE_EXTENSIONS: &[&str] = &["exe", "msi", "dmg", "deb", "AppImage", "appimage"];

#[derive(Debug, Clone, serde::Serialize)]
pub struct UpdateDownloadResult {
    pub path: String,
    pub filename: String,
    pub bytes: u64,
}

#[derive(Debug, Clone, serde::Serialize)]
#[cfg(feature = "tauri")]
struct UpdateProgressEvent {
    received: u64,
    total: Option<u64>,
}

/// Pure validation for an update asset URL (unit-tested, no I/O).
pub fn validate_update_asset_url(url: &str) -> Result<(), TerminalError> {
    if url.is_empty() || url.len() > 2048 {
        return Err(TerminalError::IoError(
            "Refusing to download an update from an invalid URL.".to_string(),
        ));
    }
    if url.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(TerminalError::IoError(
            "Refusing to download an update URL with whitespace or control characters.".to_string(),
        ));
    }
    // Parse host without extra deps.
    let host = url
        .strip_prefix("https://")
        .and_then(|rest| rest.split('/').next())
        .unwrap_or("");
    if host.is_empty() || !ALLOWED_UPDATE_HOSTS.contains(&host.to_lowercase().as_str()) {
        return Err(TerminalError::IoError(
            "Refusing to download an update from an untrusted host.".to_string(),
        ));
    }
    if host == "github.com" && !url.starts_with(UPDATE_RELEASE_PREFIX) {
        return Err(TerminalError::IoError(
            "Refusing to download an update outside the Kai Terminal releases page.".to_string(),
        ));
    }
    Ok(())
}

/// Pure filename guard: no directories, no traversal, known installer ext.
pub fn sanitize_update_filename(filename: &str) -> Result<String, TerminalError> {
    let trimmed = filename.trim();
    if trimmed.is_empty() || trimmed.len() > 256 {
        return Err(TerminalError::IoError(
            "Refusing to download an update with an invalid filename.".to_string(),
        ));
    }
    if trimmed.contains('\0')
        || trimmed.contains('/')
        || trimmed.contains('\\')
        || trimmed.contains("..")
        || trimmed.chars().any(|c| c.is_control())
    {
        return Err(TerminalError::IoError(
            "Refusing to download an update with an unsafe filename.".to_string(),
        ));
    }
    let ext_ok = ALLOWED_UPDATE_EXTENSIONS
        .iter()
        .any(|ext| trimmed.ends_with(&format!(".{ext}")));
    if !ext_ok {
        return Err(TerminalError::IoError(format!(
            "Refusing to download an update file with an unsupported extension: {trimmed}"
        )));
    }
    Ok(trimmed.to_string())
}

#[cfg(feature = "tauri")]
fn update_temp_path(filename: &str) -> PathBuf {
    std::env::temp_dir().join(format!("kai-update-{filename}"))
}

/// Prefix marking files this updater downloaded. Cleanup only ever touches
/// these names — never anything else in the shared temp dir.
const UPDATE_TEMP_PREFIX: &str = "kai-update-";

/// Best-effort sweep of leftover update installers in the OS temp dir.
///
/// Runs on every app start (background thread) and after each install, on
/// every OS. Files younger than `max_age_secs` are kept: the installer may
/// still be running right after launch (Windows locks a running `.exe`, so
/// an immediate delete fails there and the next start finishes the job).
/// Returns the number of files removed. Never fails — I/O errors are simply
/// skipped so a locked or vanishing file can never break startup/update.
pub fn cleanup_stale_update_downloads(max_age_secs: u64) -> usize {
    let dir = std::env::temp_dir();
    let entries = match std::fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(_) => return 0,
    };
    let now = std::time::SystemTime::now();
    let mut removed = 0;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.starts_with(UPDATE_TEMP_PREFIX) {
            continue;
        }
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let old_enough = match path.metadata().and_then(|m| m.modified()) {
            Ok(modified) => now
                .duration_since(modified)
                .map(|age| age.as_secs() >= max_age_secs)
                .unwrap_or(true),
            Err(_) => true,
        };
        if old_enough && std::fs::remove_file(&path).is_ok() {
            removed += 1;
        }
    }
    removed
}

/// Removes one downloaded installer from the OS temp dir after its installer
/// was launched. Same guards as the download path (sanitized name, temp dir
/// only). Returns `true` when the file is gone; `false` when it is still
/// present (e.g. Windows holds a lock while the installer runs) — those
/// leftovers are picked up by the startup sweep. Never fails the update:
///
/// validation errors (untrusted paths) are the only `Err`.
#[cfg(feature = "tauri")]
#[tauri::command]
pub fn cleanup_update_download_cmd(path: String) -> Result<bool, TerminalError> {
    use std::path::Path;

    let file_name = Path::new(&path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_string();
    let safe_name = sanitize_update_filename(&file_name)?;
    if !safe_name.starts_with(UPDATE_TEMP_PREFIX) {
        return Err(TerminalError::IoError(
            "Refusing to delete a file this updater did not download.".to_string(),
        ));
    }
    let expected = update_temp_path(&safe_name);
    if Path::new(&path) != expected {
        return Err(TerminalError::IoError(
            "Refusing to delete a file outside the temp download location.".to_string(),
        ));
    }
    if !expected.exists() {
        return Ok(true);
    }
    match std::fs::remove_file(&expected) {
        Ok(()) => Ok(true),
        Err(_) => Ok(false),
    }
}

/// Downloads a release installer to the OS temp dir.
///
/// Streams via `reqwest` so large installers never sit fully in memory, and
/// emits `kai-update-progress` events (`{ received, total }`) for the
/// frontend progress bar. Validation runs first — the URL reaches a native
/// HTTP client, so arbitrary input must never get here.
#[cfg(feature = "tauri")]
#[tauri::command]
pub async fn download_update_asset_cmd(
    app: AppHandle,
    url: String,
    filename: String,
) -> Result<UpdateDownloadResult, TerminalError> {
    use futures_util::StreamExt;
    use std::io::Write;

    validate_update_asset_url(&url)?;
    let safe_name = sanitize_update_filename(&filename)?;
    let dest = update_temp_path(&safe_name);

    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(10))
        .timeout(std::time::Duration::from_secs(600))
        .build()
        .map_err(|e| TerminalError::IoError(format!("Update download failed to start: {e}")))?;

    let resp = client
        .get(&url)
        .header("User-Agent", "kai-terminal-updater")
        .header("Accept", "application/octet-stream")
        .send()
        .await
        .map_err(|e| TerminalError::IoError(format!("Update download failed: {e}")))?;
    if !resp.status().is_success() {
        return Err(TerminalError::IoError(format!(
            "Update download failed (HTTP {})",
            resp.status().as_u16()
        )));
    }
    let total = resp.content_length();

    let mut file = std::fs::File::create(&dest).map_err(|e| {
        TerminalError::IoError(format!("Update download failed to write file: {e}"))
    })?;
    let mut stream = resp.bytes_stream();
    let mut received: u64 = 0;
    // Throttle progress events: every 256 KB is plenty for a bar.
    let mut since_emit: u64 = 0;

    while let Some(chunk) = stream.next().await {
        let bytes =
            chunk.map_err(|e| TerminalError::IoError(format!("Update download failed: {e}")))?;
        file.write_all(&bytes).map_err(|e| {
            TerminalError::IoError(format!("Update download failed to write file: {e}"))
        })?;
        received += bytes.len() as u64;
        since_emit += bytes.len() as u64;
        if since_emit >= 256 * 1024 {
            since_emit = 0;
            let _ = app.emit(
                "kai-update-progress",
                UpdateProgressEvent { received, total },
            );
        }
    }
    file.flush().map_err(|e| {
        TerminalError::IoError(format!("Update download failed to write file: {e}"))
    })?;
    let _ = app.emit(
        "kai-update-progress",
        UpdateProgressEvent {
            received,
            total: total.or(Some(received)),
        },
    );

    if received == 0 {
        let _ = std::fs::remove_file(&dest);
        return Err(TerminalError::IoError(
            "Update download failed: empty file received.".to_string(),
        ));
    }
    // AppImage must be executable to launch directly after download.
    #[cfg(target_os = "linux")]
    if dest
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("AppImage"))
        .unwrap_or(false)
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = std::fs::metadata(&dest) {
            let mut perms = meta.permissions();
            perms.set_mode(0o755);
            let _ = std::fs::set_permissions(&dest, perms);
        }
    }

    Ok(UpdateDownloadResult {
        path: dest.to_string_lossy().to_string(),
        filename: safe_name,
        bytes: received,
    })
}

/// Launches a previously downloaded installer in a detached process.
///
/// The installer itself stays interactive (UAC / Gatekeeper / polkit prompts
/// still apply) — this command only avoids making the user hunt for the file
/// in Downloads. Returns a short human-readable action for the UI.
#[cfg(feature = "tauri")]
#[allow(unused_variables)]
#[tauri::command]
pub fn launch_update_installer_cmd(path: String) -> Result<String, TerminalError> {
    let p = Path::new(&path);
    let file_name = p
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_string();
    sanitize_update_filename(&file_name)?;

    // Only launch files from the OS temp dir that we downloaded above.
    let expected_dir = std::env::temp_dir().to_string_lossy().to_string();
    let parent_ok = p
        .parent()
        .map(|par| par.to_string_lossy().starts_with(expected_dir.as_str()))
        .unwrap_or(false);
    if !parent_ok || !p.exists() || !p.is_file() {
        return Err(TerminalError::IoError(
            "Update installer not found. Please download it again.".to_string(),
        ));
    }

    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    #[cfg(target_os = "windows")]
    {
        if ext == "msi" {
            std::process::Command::new("msiexec")
                .args(["/i", &path])
                .spawn()
                .map_err(|e| TerminalError::IoError(format!("Failed to launch installer: {e}")))?;
            return Ok("Windows installer launched. Complete setup to finish the update, then restart Kai.".to_string());
        }
        // NSIS .exe (and any other .exe): interactive launch. The app must
        // be closed before NSIS overwrites it — the frontend closes the
        // window right after this returns.
        std::process::Command::new(&path)
            .spawn()
            .map_err(|e| TerminalError::IoError(format!("Failed to launch installer: {e}")))?;
        return Ok(
            "Windows installer launched. Complete setup to finish the update, then restart Kai."
                .to_string(),
        );
    }

    #[cfg(target_os = "macos")]
    {
        // A .dmg cannot silently install: mount it so the user can drag Kai
        // to /Applications. Keep the app running — the user returns to it.
        std::process::Command::new("open")
            .arg(&path)
            .spawn()
            .map_err(|e| TerminalError::IoError(format!("Failed to open disk image: {e}")))?;
        return Ok("Disk image opened. Drag Kai to Applications to finish the update.".to_string());
    }

    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    {
        if ext == "deb" {
            // Opens the software center / installer for the .deb. `dpkg -i`
            // needs sudo, so never run it silently here.
            std::process::Command::new("xdg-open")
                .arg(&path)
                .spawn()
                .map_err(|e| {
                    TerminalError::IoError(format!(
                        "Failed to open installer (is xdg-open installed?): {e}"
                    ))
                })?;
            return Ok("Installer opened. Complete setup to finish the update.".to_string());
        }
        // AppImage / fallback: reveal via the default handler.
        std::process::Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|e| {
                TerminalError::IoError(format!(
                    "Failed to open update file (is xdg-open installed?): {e}"
                ))
            })?;
        return Ok("Update file opened. Run it to finish the update.".to_string());
    }

    #[allow(unreachable_code)]
    Err(TerminalError::IoError(
        "Unsupported installer type on this platform.".to_string(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_untrusted_update_hosts() {
        let _env = crate::test_support::lock_test_env();
        assert!(validate_update_asset_url("https://github.com/surajthaqurie/kai-terminal/releases/download/v0.1.5/kai_0.1.5_x64-setup.exe").is_ok());
        assert!(
            validate_update_asset_url("https://objects.githubusercontent.com/abc/file.exe").is_ok()
        );
        assert!(validate_update_asset_url("https://example.com/evil.exe").is_err());
        assert!(validate_update_asset_url(
            "http://github.com/surajthaqurie/kai-terminal/releases/download/v0.1.5/x.exe"
        )
        .is_err());
        // github.com outside our releases path must not pass.
        assert!(validate_update_asset_url(
            "https://github.com/other/repo/releases/download/v1/x.exe"
        )
        .is_err());
    }

    #[test]
    fn rejects_unsafe_filenames() {
        let _env = crate::test_support::lock_test_env();
        assert!(sanitize_update_filename("kai_0.1.5_x64-setup.exe").is_ok());
        assert!(sanitize_update_filename("kai_0.1.5_amd64.AppImage").is_ok());
        assert!(sanitize_update_filename("../evil.exe").is_err());
        assert!(sanitize_update_filename("a/b.exe").is_err());
        assert!(sanitize_update_filename("payload.sh").is_err());
        assert!(sanitize_update_filename("").is_err());
    }

    #[test]
    fn stale_sweep_removes_only_our_downloads() {
        let _env = crate::test_support::lock_test_env();
        let dir = std::env::temp_dir();
        // Unique names so parallel runs / real leftovers never collide.
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let ours = dir.join(format!("kai-update-sweep-test-{stamp}.exe"));
        let foreign = dir.join(format!("kai-sweep-foreign-{stamp}.exe"));
        std::fs::write(&ours, b"stale installer").unwrap();
        std::fs::write(&foreign, b"not ours").unwrap();
        // max_age 0: everything qualifies by age; the prefix decides.
        let removed = cleanup_stale_update_downloads(0);
        assert!(removed >= 1);
        assert!(!ours.exists());
        assert!(foreign.exists());
        let _ = std::fs::remove_file(&foreign);
    }

    #[test]
    fn stale_sweep_keeps_fresh_downloads() {
        let _env = crate::test_support::lock_test_env();
        let dir = std::env::temp_dir();
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let fresh = dir.join(format!("kai-update-fresh-test-{stamp}.exe"));
        std::fs::write(&fresh, b"installer still running").unwrap();
        // A huge max age keeps a just-written file.
        assert_eq!(cleanup_stale_update_downloads(u64::MAX), 0);
        assert!(fresh.exists());
        let _ = std::fs::remove_file(&fresh);
    }
}
