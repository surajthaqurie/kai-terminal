use crate::error::TerminalError;
use std::path::{Path, PathBuf};
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
pub struct UpdateLaunchResult {
    pub message: String,
    /// True when a background helper installs after Kai exits and reopens it.
    /// False when the installer was opened for the user to finish by hand.
    pub unattended: bool,
}

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

/// True when `path` is exactly where `download_update_asset_cmd` writes an
/// installer: a safe, prefixed filename directly inside the OS temp dir.
///
/// Compares whole path components, not strings: on Windows `temp_dir()`
/// keeps a trailing `\` while `Path::parent()` drops it, so a string
/// `starts_with` check rejected every freshly downloaded installer with
/// "Update installer not found".
#[cfg(feature = "tauri")]
fn is_update_download_path(path: &Path) -> bool {
    let name = match path.file_name().and_then(|n| n.to_str()) {
        Some(name) => name,
        None => return false,
    };
    match sanitize_update_filename(name) {
        Ok(safe) => safe.starts_with(UPDATE_TEMP_PREFIX) && path == update_temp_path(&safe),
        Err(_) => false,
    }
}

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

/// Unattended install helper: a detached process that outlives Kai.
///
/// Kai cannot overwrite itself while running (Windows locks the `.exe`, a
/// macOS bundle must not be swapped under a live process), so the update is
/// applied by a short-lived helper that (1) waits for Kai to exit, (2)
/// installs, (3) deletes the downloaded installer — the only moment it is
/// guaranteed to be finished with — and (4) reopens Kai, so the new version
/// comes up with no manual close/reopen.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstallHelper {
    pub program: String,
    pub args: Vec<String>,
}

/// Windows: wait for Kai, run the NSIS (`/S`) or MSI (`/passive`) installer
/// to completion, delete it, reopen Kai. Nothing is shown except Windows' own
/// UAC consent for the per-machine MSI; progress lives in Kai's UI. Arguments arrive as bound
/// parameters (`-File`), never spliced into the script text. Always reopens
/// Kai, even after a cancelled/failed install, so the user is never left
/// without a running app. ASCII only: PowerShell 5.1 reads BOM-less files as
/// ANSI.
#[cfg(target_os = "windows")]
const WINDOWS_INSTALL_SCRIPT: &str = r#"param([int]$AppPid, [string]$Installer, [string]$AppExe, [string]$Mode)
$ErrorActionPreference = 'SilentlyContinue'
try { Wait-Process -Id $AppPid -Timeout 120 } catch {}
if ($Mode -eq 'msi') {
  Start-Process -FilePath 'msiexec.exe' -Verb RunAs -ArgumentList @('/i', ('"' + $Installer + '"'), '/qn', '/norestart') -Wait | Out-Null
} else {
  Start-Process -FilePath $Installer -ArgumentList '/S' -Wait | Out-Null
}
for ($i = 0; $i -lt 20 -and (Test-Path -LiteralPath $Installer); $i++) {
  Remove-Item -LiteralPath $Installer -Force
  if (Test-Path -LiteralPath $Installer) { Start-Sleep -Milliseconds 500 }
}
if (Test-Path -LiteralPath $AppExe) {
  Start-Process -FilePath $AppExe -WorkingDirectory (Split-Path -Parent $AppExe)
}
Remove-Item -LiteralPath $PSCommandPath -Force
"#;

/// macOS: wait for Kai, mount the `.dmg`, swap the running `.app` bundle for
/// the new one (rolled back on failure), unmount, delete the `.dmg`, reopen.
/// Positional args: `$1` Kai pid, `$2` dmg, `$3` current `.app` bundle.
#[cfg(target_os = "macos")]
const MACOS_INSTALL_SCRIPT: &str = r#"APP_PID="$1"; DMG="$2"; BUNDLE="$3"
i=0
while kill -0 "$APP_PID" 2>/dev/null && [ "$i" -lt 240 ]; do sleep 0.5; i=$((i+1)); done
MNT="$(mktemp -d "${TMPDIR:-/tmp}/kai-update-mnt.XXXXXX")"
if hdiutil attach -nobrowse -noautoopen -readonly -mountpoint "$MNT" "$DMG" >/dev/null 2>&1; then
  SRC="$(find "$MNT" -maxdepth 1 -name '*.app' -print | head -n 1)"
  if [ -n "$SRC" ] && ditto "$SRC" "$BUNDLE.kai-new"; then
    xattr -dr com.apple.quarantine "$BUNDLE.kai-new" 2>/dev/null
    if mv "$BUNDLE" "$BUNDLE.kai-old"; then
      if mv "$BUNDLE.kai-new" "$BUNDLE"; then rm -rf "$BUNDLE.kai-old"
      else mv "$BUNDLE.kai-old" "$BUNDLE"; rm -rf "$BUNDLE.kai-new"; fi
    else rm -rf "$BUNDLE.kai-new"; fi
  else rm -rf "$BUNDLE.kai-new"; fi
  hdiutil detach "$MNT" -quiet || hdiutil detach "$MNT" -force -quiet
fi
rmdir "$MNT" 2>/dev/null
rm -f "$DMG"
open "$BUNDLE"
"#;

/// Linux `.deb`: wait for Kai, install through polkit (`pkexec`, one GUI
/// password prompt), delete the package, reopen Kai.
/// Positional args: `$1` Kai pid, `$2` deb, `$3` Kai executable.
#[cfg(all(unix, not(target_os = "macos")))]
const LINUX_DEB_INSTALL_SCRIPT: &str = r#"APP_PID="$1"; PKG="$2"; APP="$3"
i=0
while kill -0 "$APP_PID" 2>/dev/null && [ "$i" -lt 240 ]; do sleep 0.5; i=$((i+1)); done
pkexec sh -c 'DEBIAN_FRONTEND=noninteractive apt-get install -y "$1" || dpkg -i "$1"' kai-update "$PKG"
rm -f "$PKG"
nohup "$APP" >/dev/null 2>&1 &
"#;

/// Linux AppImage: wait for Kai, replace the running AppImage file in place,
/// reopen it. The downloaded file is moved over the old one (nothing left to
/// delete) and removed if the move fails.
/// Positional args: `$1` Kai pid, `$2` new AppImage, `$3` current AppImage.
#[cfg(all(unix, not(target_os = "macos")))]
const LINUX_APPIMAGE_INSTALL_SCRIPT: &str = r#"APP_PID="$1"; NEW="$2"; TARGET="$3"
i=0
while kill -0 "$APP_PID" 2>/dev/null && [ "$i" -lt 240 ]; do sleep 0.5; i=$((i+1)); done
chmod +x "$NEW"
mv -f "$NEW" "$TARGET" || rm -f "$NEW"
nohup "$TARGET" >/dev/null 2>&1 &
"#;

/// True when a file can be created in `dir` (the swap/replace would work).
pub fn dir_is_writable(dir: &Path) -> bool {
    let probe = dir.join(format!(".kai-update-write-test-{}", std::process::id()));
    match std::fs::File::create(&probe) {
        Ok(_) => {
            let _ = std::fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

/// True when an executable called `name` exists in one of the `PATH` dirs.
pub fn find_in_path(name: &str) -> bool {
    std::env::var_os("PATH")
        .map(|paths| std::env::split_paths(&paths).any(|dir| dir.join(name).is_file()))
        .unwrap_or(false)
}

/// The `.app` bundle containing `exe` (`/Applications/kai.app/Contents/MacOS/kai`
/// → `/Applications/kai.app`). `None` for a dev build running outside a bundle.
pub fn app_bundle_of(exe: &Path) -> Option<PathBuf> {
    exe.ancestors()
        .find(|p| p.extension().and_then(|e| e.to_str()) == Some("app"))
        .map(Path::to_path_buf)
}

/// Which installer flavour matches how this copy of Kai was installed, when
/// that differs from the OS default pick (`"appimage"`: running from an
/// AppImage, so a `.deb` would add a second system copy; `"msi"`: installed
/// under Program Files by the MSI, so the per-user NSIS `.exe` would add a
/// second copy). `None` keeps the default selection.
pub fn install_hint(
    exe: &Path,
    appimage_env: Option<&str>,
    program_dirs: &[String],
) -> Option<&'static str> {
    if appimage_env.map(|a| !a.is_empty()).unwrap_or(false) {
        return Some("appimage");
    }
    let exe_lower = exe.to_string_lossy().replace('/', "\\").to_lowercase();
    let under_program_files = program_dirs.iter().any(|dir| {
        let dir_lower = dir.replace('/', "\\").trim_end_matches('\\').to_lowercase();
        !dir_lower.is_empty() && exe_lower.starts_with(&format!("{dir_lower}\\"))
    });
    if under_program_files {
        return Some("msi");
    }
    None
}

/// Builds the helper that will install `installer` once Kai (`app_pid`) has
/// exited and reopen `current_exe`. `None` means no unattended path exists
/// here (unsupported package type, no `pkexec`, read-only install dir, dev
/// build outside a bundle…) and the caller falls back to the manual flow.
pub fn prepare_unattended_install(
    installer: &Path,
    app_pid: u32,
    current_exe: &Path,
) -> Option<InstallHelper> {
    let ext = installer
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    let pid = app_pid.to_string();
    let installer_s = installer.to_str()?.to_string();

    #[cfg(target_os = "windows")]
    {
        let exe_s = current_exe.to_str()?.to_string();
        let mode = match ext.as_str() {
            "msi" => "msi",
            "exe" => "exe",
            _ => return None,
        };
        let script = std::env::temp_dir().join(format!("{UPDATE_TEMP_PREFIX}run-{app_pid}.ps1"));
        std::fs::write(&script, WINDOWS_INSTALL_SCRIPT).ok()?;
        return Some(InstallHelper {
            program: "powershell.exe".to_string(),
            args: [
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-WindowStyle",
                "Hidden",
                "-File",
                script.to_str()?,
                "-AppPid",
                pid.as_str(),
                "-Installer",
                installer_s.as_str(),
                "-AppExe",
                exe_s.as_str(),
                "-Mode",
                mode,
            ]
            .iter()
            .map(|s| s.to_string())
            .collect(),
        });
    }

    #[cfg(target_os = "macos")]
    {
        if ext != "dmg" {
            return None;
        }
        let bundle = app_bundle_of(current_exe)?;
        if !dir_is_writable(bundle.parent()?) {
            return None;
        }
        return Some(InstallHelper {
            program: "/bin/sh".to_string(),
            args: vec![
                "-c".to_string(),
                MACOS_INSTALL_SCRIPT.to_string(),
                "kai-update".to_string(),
                pid,
                installer_s,
                bundle.to_str()?.to_string(),
            ],
        });
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let exe_s = current_exe.to_str()?.to_string();
        let (script, target) = match ext.as_str() {
            "deb" => {
                if !find_in_path("pkexec") || !(find_in_path("apt-get") || find_in_path("dpkg")) {
                    return None;
                }
                (LINUX_DEB_INSTALL_SCRIPT, exe_s)
            }
            "appimage" => {
                let current =
                    PathBuf::from(std::env::var_os("APPIMAGE").filter(|a| !a.is_empty())?);
                if !current.is_file() || !dir_is_writable(current.parent()?) {
                    return None;
                }
                (LINUX_APPIMAGE_INSTALL_SCRIPT, current.to_str()?.to_string())
            }
            _ => return None,
        };
        return Some(InstallHelper {
            program: "sh".to_string(),
            args: vec![
                "-c".to_string(),
                script.to_string(),
                "kai-update".to_string(),
                pid,
                installer_s,
                target,
            ],
        });
    }

    #[allow(unreachable_code)]
    None
}

/// Starts the helper fully detached (own process group / no console window)
/// so it keeps running after Kai exits.
pub fn spawn_install_helper(helper: &InstallHelper) -> std::io::Result<()> {
    use std::process::{Command, Stdio};

    let mut cmd = Command::new(&helper.program);
    cmd.args(&helper.args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP
        cmd.creation_flags(0x08000000 | 0x00000200);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    cmd.spawn().map(|_| ())
}

/// Quits Kai shortly after the command returns, so the "installing" message
/// can paint and the helper (waiting on this pid) can take over.
#[cfg(feature = "tauri")]
fn schedule_app_exit(app: AppHandle) {
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(2000));
        crate::shutdown_app(&app);
    });
}

/// Reports how this copy of Kai was installed so the frontend can pick the
/// matching installer (see [`install_hint`]).
#[cfg(feature = "tauri")]
#[tauri::command]
pub fn get_update_install_hint_cmd() -> Option<String> {
    let exe = std::env::current_exe().ok()?;
    let appimage = std::env::var("APPIMAGE").ok();
    let program_dirs: Vec<String> = ["ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"]
        .iter()
        .filter_map(|k| std::env::var(k).ok())
        .collect();
    install_hint(&exe, appimage.as_deref(), &program_dirs).map(str::to_string)
}

/// Installs a previously downloaded installer and returns a short
/// human-readable status for the UI.
///
/// Preferred path: a detached helper installs after Kai exits, deletes the
/// installer once finished and reopens the new version (see
/// [`InstallHelper`]); Kai quits itself a moment after this returns. When no
/// unattended path exists, the installer is opened for the user instead
/// (UAC / Gatekeeper / polkit prompts still apply) and Kai keeps running
/// where the OS allows it; those leftovers are swept on the next start.
#[cfg(feature = "tauri")]
#[tauri::command]
pub fn launch_update_installer_cmd(
    app: AppHandle,
    path: String,
) -> Result<UpdateLaunchResult, TerminalError> {
    let p = Path::new(&path);
    if !is_update_download_path(p) || !p.is_file() {
        return Err(TerminalError::IoError(
            "Update installer not found. Please download it again.".to_string(),
        ));
    }

    let current_exe = std::env::current_exe()
        .map_err(|e| TerminalError::IoError(format!("Failed to locate the running app: {e}")))?;
    if let Some(helper) = prepare_unattended_install(p, std::process::id(), &current_exe) {
        spawn_install_helper(&helper)
            .map_err(|e| TerminalError::IoError(format!("Failed to start the installer: {e}")))?;
        schedule_app_exit(app);
        return Ok(UpdateLaunchResult {
            message: "Installing the update in the background. Kai will restart by itself."
                .to_string(),
            unattended: true,
        });
    }
    open_installer_manually(app, p)
}

/// Fallback when no unattended install is possible: hand the installer to the
/// OS and tell the user the remaining step.
#[cfg(feature = "tauri")]
#[allow(unused_variables)]
fn open_installer_manually(app: AppHandle, p: &Path) -> Result<UpdateLaunchResult, TerminalError> {
    let path = p.to_string_lossy().to_string();
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
        } else {
            std::process::Command::new(&path)
                .spawn()
                .map_err(|e| TerminalError::IoError(format!("Failed to launch installer: {e}")))?;
        }
        // The interactive installer cannot overwrite a running Kai.
        schedule_app_exit(app);
        return Ok(UpdateLaunchResult {
            message:
                "Windows installer launched. Complete setup to finish the update, then reopen Kai."
                    .to_string(),
            unattended: false,
        });
    }

    #[cfg(target_os = "macos")]
    {
        // Not installed from a writable bundle: mount the .dmg so the user
        // can drag Kai to /Applications.
        std::process::Command::new("open")
            .arg(&path)
            .spawn()
            .map_err(|e| TerminalError::IoError(format!("Failed to open disk image: {e}")))?;
        return Ok(UpdateLaunchResult {
            message: "Disk image opened. Drag Kai to Applications to finish the update."
                .to_string(),
            unattended: false,
        });
    }

    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    {
        // No pkexec / not an AppImage run: reveal via the default handler.
        std::process::Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|e| {
                TerminalError::IoError(format!(
                    "Failed to open update file (is xdg-open installed?): {e}"
                ))
            })?;
        return Ok(UpdateLaunchResult {
            message: if ext == "deb" {
                "Installer opened. Complete setup to finish the update.".to_string()
            } else {
                "Update file opened. Run it to finish the update.".to_string()
            },
            unattended: false,
        });
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

    #[cfg(feature = "tauri")]
    #[test]
    fn download_path_check_matches_download_location() {
        let _env = crate::test_support::lock_test_env();
        // Exactly what the download command returns (temp_dir may end in a
        // separator on Windows) must be accepted.
        let dest = update_temp_path("kai_0.1.5_x64-setup.exe");
        assert!(is_update_download_path(&dest));
        // Other files in temp, other dirs and non-prefixed names are refused.
        assert!(!is_update_download_path(
            &std::env::temp_dir().join("kai_0.1.5_x64-setup.exe")
        ));
        assert!(!is_update_download_path(
            &std::env::temp_dir()
                .join("sub")
                .join("kai-update-kai_0.1.5_x64-setup.exe")
        ));
        assert!(!is_update_download_path(Path::new("kai-update-x.exe")));
    }

    #[test]
    fn finds_the_app_bundle_of_a_macos_executable() {
        let _env = crate::test_support::lock_test_env();
        assert_eq!(
            app_bundle_of(Path::new("/Applications/kai.app/Contents/MacOS/kai")),
            Some(PathBuf::from("/Applications/kai.app"))
        );
        // Dev build outside a bundle: no unattended swap.
        assert_eq!(app_bundle_of(Path::new("/work/target/debug/kai")), None);
    }

    #[test]
    fn install_hint_follows_how_kai_was_installed() {
        let _env = crate::test_support::lock_test_env();
        let pf = vec![r"C:\Program Files".to_string()];
        let msi = Path::new(r"C:\Program Files\kai\kai.exe");
        let nsis = Path::new(r"C:\Users\me\AppData\Local\kai\kai.exe");
        assert_eq!(install_hint(msi, None, &pf), Some("msi"));
        assert_eq!(
            install_hint(Path::new(r"c:\program files\kai\kai.exe"), None, &pf),
            Some("msi")
        );
        assert_eq!(install_hint(nsis, None, &pf), None);
        // Sibling dir with the same prefix must not match.
        assert_eq!(
            install_hint(Path::new(r"C:\Program Files Extra\kai.exe"), None, &pf),
            None
        );
        assert_eq!(
            install_hint(
                Path::new("/tmp/.mount_kai/usr/bin/kai"),
                Some("/x/kai.AppImage"),
                &[]
            ),
            Some("appimage")
        );
        assert_eq!(install_hint(nsis, Some(""), &[]), None);
    }

    #[test]
    fn dir_is_writable_probes_and_cleans_up() {
        let _env = crate::test_support::lock_test_env();
        let dir = std::env::temp_dir();
        assert!(dir_is_writable(&dir));
        assert!(!dir_is_writable(
            &dir.join("kai-no-such-dir-for-update-test")
        ));
    }

    #[test]
    fn unattended_install_refuses_unsupported_files() {
        let _env = crate::test_support::lock_test_env();
        let exe = std::env::current_exe().unwrap();
        // Not an installer type on any OS: always falls back to manual.
        assert_eq!(
            prepare_unattended_install(Path::new("payload.sh"), 1, &exe),
            None
        );
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
