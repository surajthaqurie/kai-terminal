use crate::error::TerminalError;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::env;
use std::path::Path;

/// Shell profile configuration for host OS or user configuration.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ShellProfile {
    pub id: String,
    pub name: String,
    pub path: String,
    pub args: Option<Vec<String>>,
    pub env: Option<HashMap<String, String>>,
    pub is_default: bool,
    pub is_wsl: bool,
}

/// Detects installed available shell profiles on the host operating system.
pub fn detect_available_shells() -> Vec<ShellProfile> {
    let mut profiles = Vec::new();
    let mut default_set = false;

    #[cfg(target_os = "windows")]
    {
        let sys_root = env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".to_string());

        // 1. PowerShell Core / PowerShell 7 (pwsh.exe)
        let pwsh_candidates = [
            which_path("pwsh.exe").ok(),
            env::var("ProgramFiles")
                .ok()
                .map(|p| format!("{}\\PowerShell\\7\\pwsh.exe", p)),
            env::var("ProgramFiles(x86)")
                .ok()
                .map(|p| format!("{}\\PowerShell\\7\\pwsh.exe", p)),
        ];
        for cand in pwsh_candidates.into_iter().flatten() {
            if Path::new(&cand).exists()
                && !profiles
                    .iter()
                    .any(|p: &ShellProfile| p.path.eq_ignore_ascii_case(&cand))
            {
                profiles.push(ShellProfile {
                    id: "pwsh".into(),
                    name: "PowerShell Core".into(),
                    path: cand,
                    args: None,
                    env: None,
                    is_default: !default_set,
                    is_wsl: false,
                });
                default_set = true;
                break;
            }
        }

        // 2. Windows PowerShell (powershell.exe)
        let win_pwsh = format!(
            r"{}\System32\WindowsPowerShell\v1.0\powershell.exe",
            sys_root
        );
        if Path::new(&win_pwsh).exists() {
            let is_def = !default_set;
            if is_def {
                default_set = true;
            }
            profiles.push(ShellProfile {
                id: "powershell".into(),
                name: "Windows PowerShell".into(),
                path: win_pwsh,
                args: None,
                env: None,
                is_default: is_def,
                is_wsl: false,
            });
        }

        // 3. Command Prompt (cmd.exe)
        let cmd_path = format!(r"{}\System32\cmd.exe", sys_root);
        if Path::new(&cmd_path).exists() {
            let is_def = !default_set;
            profiles.push(ShellProfile {
                id: "cmd".into(),
                name: "Command Prompt".into(),
                path: cmd_path,
                args: None,
                env: None,
                is_default: is_def,
                is_wsl: false,
            });
        }

        // 4. Windows Subsystem for Linux (wsl.exe) - Separate execution environment
        let wsl_path = format!(r"{}\System32\wsl.exe", sys_root);
        let actual_wsl = if Path::new(&wsl_path).exists() {
            Some(wsl_path)
        } else {
            which_path("wsl.exe").ok()
        };

        if let Some(wsl_bin) = actual_wsl {
            profiles.push(ShellProfile {
                id: "wsl".into(),
                name: "WSL (Linux)".into(),
                path: wsl_bin,
                args: None,
                env: None,
                is_default: false,
                is_wsl: true,
            });
        }
    }

    #[cfg(target_os = "macos")]
    {
        let candidate_shells = [
            ("zsh", "Zsh", "/bin/zsh"),
            ("zsh-brew", "Zsh (Homebrew)", "/opt/homebrew/bin/zsh"),
            ("zsh-local", "Zsh (Local)", "/usr/local/bin/zsh"),
            ("bash", "Bash", "/bin/bash"),
            ("bash-brew", "Bash (Homebrew)", "/opt/homebrew/bin/bash"),
            ("fish", "Fish", "/opt/homebrew/bin/fish"),
            ("sh", "Sh", "/bin/sh"),
        ];

        let default_shell_env = env::var("SHELL").ok();

        // Respect user's configured $SHELL environment variable
        if let Some(ref env_sh) = default_shell_env {
            let p = Path::new(env_sh);
            if p.exists() && is_executable(p) {
                let name = p
                    .file_name()
                    .and_then(|s| s.to_str())
                    .unwrap_or("Default Shell");

                profiles.push(ShellProfile {
                    id: name.to_lowercase(),
                    name: format!("{} (System Default)", name),
                    path: env_sh.clone(),
                    args: None,
                    env: None,
                    is_default: true,
                    is_wsl: false,
                });
                default_set = true;
            }
        }

        for (id, name, std_path) in candidate_shells.iter() {
            let p = Path::new(std_path);
            let path_to_use = if p.exists() && is_executable(p) {
                Some((*std_path).to_string())
            } else {
                which_path(id).ok()
            };

            if let Some(path) = path_to_use {
                let canonical_target = Path::new(&path).canonicalize().ok();
                let already_present = profiles.iter().any(|p| {
                    p.id == *id
                        || p.path == path
                        || (canonical_target.is_some()
                            && Path::new(&p.path).canonicalize().ok() == canonical_target)
                });
                if !already_present {
                    let is_def = !default_set;
                    if is_def {
                        default_set = true;
                    }
                    profiles.push(ShellProfile {
                        id: (*id).to_string(),
                        name: (*name).to_string(),
                        path,
                        args: None,
                        env: None,
                        is_default: is_def,
                        is_wsl: false,
                    });
                }
            }
        }
    }

    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    {
        let candidate_shells = [
            ("zsh", "Zsh", "/bin/zsh"),
            ("bash", "Bash", "/bin/bash"),
            ("fish", "Fish", "/usr/bin/fish"),
            ("sh", "Sh", "/bin/sh"),
        ];

        let default_shell_env = env::var("SHELL").ok();

        // Respect user's configured $SHELL environment variable
        if let Some(ref env_sh) = default_shell_env {
            let p = Path::new(env_sh);
            if p.exists() && is_executable(p) {
                let name = p
                    .file_name()
                    .and_then(|s| s.to_str())
                    .unwrap_or("Default Shell");

                profiles.push(ShellProfile {
                    id: name.to_lowercase(),
                    name: format!("{} (System Default)", name),
                    path: env_sh.clone(),
                    args: None,
                    env: None,
                    is_default: true,
                    is_wsl: false,
                });
                default_set = true;
            }
        }

        for (id, name, std_path) in candidate_shells.iter() {
            let p = Path::new(std_path);
            let path_to_use = if p.exists() && is_executable(p) {
                Some((*std_path).to_string())
            } else {
                which_path(id).ok()
            };

            if let Some(path) = path_to_use {
                let canonical_target = Path::new(&path).canonicalize().ok();
                let already_present = profiles.iter().any(|p| {
                    p.id == *id
                        || p.path == path
                        || (canonical_target.is_some()
                            && Path::new(&p.path).canonicalize().ok() == canonical_target)
                });
                if !already_present {
                    let is_def = !default_set;
                    if is_def {
                        default_set = true;
                    }
                    profiles.push(ShellProfile {
                        id: (*id).to_string(),
                        name: (*name).to_string(),
                        path,
                        args: None,
                        env: None,
                        is_default: is_def,
                        is_wsl: false,
                    });
                }
            }
        }
    }

    // Safety fallback
    if profiles.is_empty() {
        #[cfg(target_os = "windows")]
        profiles.push(ShellProfile {
            id: "cmd".into(),
            name: "Command Prompt".into(),
            path: r"C:\Windows\System32\cmd.exe".into(),
            args: None,
            env: None,
            is_default: true,
            is_wsl: false,
        });

        #[cfg(not(target_os = "windows"))]
        profiles.push(ShellProfile {
            id: "sh".into(),
            name: "Sh".into(),
            path: "/bin/sh".into(),
            args: None,
            env: None,
            is_default: true,
            is_wsl: false,
        });
    }

    profiles
}

/// Minimum supported Windows build for ConPTY-based PTY sessions.
///
/// Aligned with INSTALL.md: Windows 10 version 1809 (build 17763) or later,
/// or Windows 11. Builds older than this predate the ConPTY infrastructure
/// (`portable-pty` delegates to ConPTY on Windows) and cannot host a native
/// PTY. There is intentionally no Win7/8 or pre-ConPTY fallback: claiming
/// legacy support without a tested legacy backend would be unsafe.
pub const MIN_SUPPORTED_WINDOWS_BUILD: u32 = 17763;

/// Pure, cross-platform-checkable gate for a Windows build number.
/// Returns `Ok(())` when ConPTY can be expected, or an actionable error
/// naming the minimum supported version. Non-Windows callers never reach
/// here via `check_host_pty_support`, but the gate itself is platform
/// independent so it can be unit tested on any OS.
pub fn check_windows_build_supported(build: u32) -> Result<(), TerminalError> {
    if build >= MIN_SUPPORTED_WINDOWS_BUILD {
        Ok(())
    } else {
        Err(TerminalError::PtyCreationFailed(format!(
            "Unsupported Windows build {}: Kai requires Windows 10 version 1809 (build {}) or later / Windows 11 with ConPTY. Please update Windows, then reinstall WebView2 if prompted.",
            build, MIN_SUPPORTED_WINDOWS_BUILD
        )))
    }
}

/// Verifies host PTY support before attempting `openpty`/ConPTY creation.
/// On Windows, queries the current build number and rejects unsupported
/// hosts with an actionable error instead of a cryptic ConPTY failure.
/// On Unix/macOS this is a no-op (native `openpty` is always present).
pub fn check_host_pty_support() -> Result<(), TerminalError> {
    #[cfg(target_os = "windows")]
    {
        match current_windows_build() {
            Some(build) => check_windows_build_supported(build),
            None => Err(TerminalError::PtyCreationFailed(
                "Unable to determine Windows version: Kai requires Windows 10 version 1809 (build 17763) or later / Windows 11 with ConPTY and the WebView2 runtime. Update Windows and reinstall if this persists.".to_string(),
            )),
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        Ok(())
    }
}

/// Best-effort query of the current Windows build number without extra deps.
/// Parses `cmd /c ver` output (e.g. `... [Version 10.0.22631.4169]`).
/// Returns `None` when the version cannot be determined.
#[cfg(target_os = "windows")]
fn current_windows_build() -> Option<u32> {
    let out = std::process::Command::new("cmd")
        .args(["/c", "ver"])
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    // Find last dotted group like 10.0.22631.4169 and take the third component.
    let version_token = text.split_whitespace().find_map(|tok| {
        let t = tok.trim_matches(|c| c == '[' || c == ']');
        let parts: Vec<&str> = t.split('.').collect();
        if parts.len() >= 3 && parts.iter().all(|p| p.chars().all(|c| c.is_ascii_digit())) {
            Some(parts)
        } else {
            None
        }
    })?;
    version_token.get(2)?.parse::<u32>().ok()
}

/// Returns true when a shell path refers to WSL (`wsl.exe`).
/// Used to distinguish WSL service failures from general PTY failures.
pub fn is_wsl_shell_path(shell_path: &str) -> bool {
    let lower = shell_path.to_lowercase();
    let file = lower.rsplit(['/', '\\']).next().unwrap_or(&lower);
    file == "wsl" || file == "wsl.exe"
}

/// Actionable hint appended to PTY creation errors when the target is WSL.
pub fn wsl_failure_hint() -> &'static str {
    "WSL launch failed: ensure the Windows Subsystem for Linux optional feature and a Linux distribution are installed (`wsl --list --verbose` in an elevated prompt), the LxssManager service is running, and try `wsl --update`. This is distinct from a general PTY failure."
}
/// Validates requested shell executable path or resolves to default profile.
/// Never spawns a shell for resolution; uses direct filesystem checks only.
/// Rejects NUL bytes and over-long inputs (Phase E IPC hardening).
pub fn validate_and_resolve_shell(requested_path: Option<&str>) -> Result<String, TerminalError> {
    if let Some(path_str) = requested_path {
        if path_str.contains('\0') {
            return Err(TerminalError::ShellNotFound(
                "Shell path contains NUL byte".into(),
            ));
        }
        if path_str.len() > 4096 {
            return Err(TerminalError::ShellNotFound(
                "Shell path exceeds 4096 bytes".into(),
            ));
        }
        let trimmed = path_str.trim().trim_matches('"').trim_matches('\'');
        if trimmed.is_empty() {
            let default_profile = detect_available_shells()
                .into_iter()
                .find(|p| p.is_default)
                .ok_or_else(|| {
                    TerminalError::ShellNotFound("No default shell profile found on system".into())
                })?;
            return Ok(default_profile.path);
        }

        let p = Path::new(trimmed);
        if p.exists() {
            #[cfg(not(target_os = "windows"))]
            if !is_executable(p) {
                return Err(TerminalError::ShellNotFound(format!(
                    "Shell executable path '{}' exists but lacks execution permissions",
                    trimmed
                )));
            }
            return Ok(trimmed.to_string());
        }

        if let Ok(resolved_path) = which_path(trimmed) {
            return Ok(resolved_path);
        }

        Err(TerminalError::ShellNotFound(format!(
            "Shell binary '{}' does not exist or is not executable on system path",
            trimmed
        )))
    } else {
        let default_profile = detect_available_shells()
            .into_iter()
            .find(|p| p.is_default)
            .ok_or_else(|| {
                TerminalError::ShellNotFound("No default shell profile found on system".into())
            })?;
        Ok(default_profile.path)
    }
}

/// Validates working directory path. Rejects NUL bytes and over-long inputs.
pub fn validate_and_resolve_cwd(requested_cwd: Option<&str>) -> Result<String, TerminalError> {
    if let Some(cwd_str) = requested_cwd {
        if cwd_str.contains('\0') {
            return Err(TerminalError::InvalidDirectory(
                "Working directory contains NUL byte".into(),
            ));
        }
        if cwd_str.len() > 4096 {
            return Err(TerminalError::InvalidDirectory(
                "Working directory path exceeds 4096 bytes".into(),
            ));
        }
        let trimmed = cwd_str.trim().trim_matches('"').trim_matches('\'');
        if !trimmed.is_empty() {
            let p = Path::new(trimmed);
            if p.exists() {
                if p.is_dir() {
                    return Ok(trimmed.to_string());
                } else {
                    return Err(TerminalError::InvalidDirectory(format!(
                        "Working directory path '{}' is a file, not a directory",
                        trimmed
                    )));
                }
            } else {
                return Err(TerminalError::InvalidDirectory(format!(
                    "Working directory '{}' does not exist",
                    trimmed
                )));
            }
        }
    }

    // Default to HOME or USERPROFILE directory
    if let Ok(home) = env::var("HOME").or_else(|_| env::var("USERPROFILE")) {
        if Path::new(&home).is_dir() {
            return Ok(home);
        }
    }

    env::current_dir()
        .map(|p| p.to_string_lossy().to_string())
        .map_err(|e| TerminalError::IoError(format!("Failed to query current working dir: {}", e)))
}

/// Helper function searching executable binary in system PATH without invoking shell commands.
fn which_path(cmd: &str) -> Result<String, ()> {
    if let Ok(path_env) = env::var("PATH") {
        for dir in env::split_paths(&path_env) {
            let full_path = dir.join(cmd);
            if full_path.exists() {
                #[cfg(not(target_os = "windows"))]
                if !is_executable(&full_path) {
                    continue;
                }
                return Ok(full_path.to_string_lossy().to_string());
            }

            #[cfg(target_os = "windows")]
            {
                let pathext =
                    env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string());
                let extensions: Vec<&str> = pathext.split(';').collect();

                for ext in &extensions {
                    let ext_trimmed = ext.trim();
                    if !ext_trimmed.is_empty() {
                        let path_with_ext =
                            dir.join(format!("{}{}", cmd, ext_trimmed.to_lowercase()));
                        if path_with_ext.exists() {
                            return Ok(path_with_ext.to_string_lossy().to_string());
                        }
                    }
                }
            }
        }
    }
    Err(())
}

/// Helper checking if file mode permissions include execution bits on Unix platforms.
#[cfg(not(target_os = "windows"))]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    if let Ok(metadata) = path.metadata() {
        metadata.is_file() && (metadata.permissions().mode() & 0o111 != 0)
    } else {
        false
    }
}

/// Opens a project directory in a configured editor (Phase D).
///
/// Supported default editor binaries checked on PATH: `code`, `cursor`, `vscodium`, `subl`, `zed`.
/// Does not use shell string interpolation; launches binary directly with `[cwd]` arg.
pub fn open_in_editor(requested_editor: Option<&str>, cwd: &str) -> Result<String, TerminalError> {
    let valid_cwd = validate_and_resolve_cwd(Some(cwd))?;

    let candidate_editors = [
        "code", "cursor", "vscodium", "subl", "zed", "atom", "idea", "clion",
    ];

    let editor_bin = if let Some(req) = requested_editor {
        let trimmed = req.trim().trim_matches('"').trim_matches('\'');
        if trimmed.is_empty() {
            return Err(TerminalError::ShellNotFound(
                "Editor binary path is empty".into(),
            ));
        }
        if trimmed.contains('\0') || trimmed.len() > 4096 {
            return Err(TerminalError::ShellNotFound(
                "Editor binary path is invalid".into(),
            ));
        }
        if Path::new(trimmed).exists() {
            trimmed.to_string()
        } else if let Ok(p) = which_path(trimmed) {
            p
        } else {
            return Err(TerminalError::ShellNotFound(format!(
                "Editor binary '{}' not found on system PATH",
                trimmed
            )));
        }
    } else {
        let mut found = None;
        for cand in candidate_editors {
            if let Ok(p) = which_path(cand) {
                found = Some(p);
                break;
            }
        }
        found.ok_or_else(|| {
            TerminalError::ShellNotFound(
                "No supported code editor (e.g. code, cursor, vscodium, subl) found on PATH".into(),
            )
        })?
    };

    std::process::Command::new(&editor_bin)
        .arg(&valid_cwd)
        .spawn()
        .map_err(|e| {
            TerminalError::IoError(format!("Failed to launch editor '{}': {}", editor_bin, e))
        })?;

    Ok(editor_bin)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::{self, File};

    #[test]
    fn test_detect_available_shells() {
        let shells = detect_available_shells();
        assert!(!shells.is_empty(), "Should detect at least one shell");
        assert!(
            shells.iter().any(|s| s.is_default),
            "At least one shell should be marked default"
        );
    }

    #[test]
    fn test_validate_and_resolve_shell_default() {
        let shell = validate_and_resolve_shell(None);
        assert!(shell.is_ok());
    }

    #[test]
    fn test_validate_and_resolve_shell_invalid_message() {
        let res = validate_and_resolve_shell(Some("/non_existent_binary_xyz_123"));
        assert!(res.is_err());
        match res {
            Err(TerminalError::ShellNotFound(msg)) => {
                assert!(msg.contains("/non_existent_binary_xyz_123"));
            }
            _ => panic!("Expected ShellNotFound error with path message"),
        }
    }

    #[test]
    fn test_validate_rejects_nul_and_oversize() {
        assert!(validate_and_resolve_shell(Some("bad\0path")).is_err());
        assert!(validate_and_resolve_cwd(Some("bad\0dir")).is_err());
        assert!(validate_and_resolve_shell(Some(&"x".repeat(5000))).is_err());
    }

    #[test]
    fn test_validate_and_resolve_shell_with_spaces_in_path() {
        let temp_dir = std::env::temp_dir().join("terminal space test dir");
        let _ = fs::create_dir_all(&temp_dir);

        #[cfg(target_os = "windows")]
        let fake_bin = temp_dir.join("fake_shell.exe");
        #[cfg(not(target_os = "windows"))]
        let fake_bin = temp_dir.join("fake_shell.sh");

        let file_res = File::create(&fake_bin);
        if let Ok(_file) = file_res {
            #[cfg(not(target_os = "windows"))]
            {
                use std::os::unix::fs::PermissionsExt;
                let mut perms = _file.metadata().unwrap().permissions();
                perms.set_mode(0o755);
                let _ = fs::set_permissions(&fake_bin, perms);
            }

            let path_str = fake_bin.to_string_lossy().to_string();
            let resolved = validate_and_resolve_shell(Some(&path_str));
            assert!(
                resolved.is_ok(),
                "Should resolve valid shell path containing spaces"
            );
            assert_eq!(resolved.unwrap(), path_str);

            let _ = fs::remove_file(&fake_bin);
        }
        let _ = fs::remove_dir(&temp_dir);
    }

    #[test]
    fn test_validate_and_resolve_cwd_valid_and_invalid() {
        let temp_dir = std::env::temp_dir();
        let valid_res = validate_and_resolve_cwd(Some(temp_dir.to_str().unwrap()));
        assert!(valid_res.is_ok());

        let invalid_res = validate_and_resolve_cwd(Some("/non_existent_dir_xyz_9999"));
        assert!(invalid_res.is_err());
        match invalid_res {
            Err(TerminalError::InvalidDirectory(msg)) => {
                assert!(msg.contains("non_existent_dir_xyz_9999"));
            }
            _ => panic!("Expected InvalidDirectory error"),
        }
    }

    #[test]
    fn test_custom_shell_profile_serialization() {
        let mut env_map = HashMap::new();
        env_map.insert("CUSTOM_VAR".to_string(), "VALUE".to_string());

        let profile = ShellProfile {
            id: "custom-wsl".into(),
            name: "Custom WSL".into(),
            path: "wsl.exe".into(),
            args: Some(vec!["-d".into(), "Ubuntu".into()]),
            env: Some(env_map),
            is_default: false,
            is_wsl: true,
        };

        let json = serde_json::to_string(&profile).expect("Serialization failed");
        assert!(json.contains("custom-wsl"));
        assert!(json.contains("is_wsl"));
    }

    #[test]
    fn test_open_in_editor_validation() {
        assert!(open_in_editor(Some("/non_existent_editor_xyz_99"), "/tmp").is_err());
        assert!(open_in_editor(Some("invalid\0editor"), "/tmp").is_err());
        assert!(open_in_editor(Some(""), "/tmp").is_err());
    }

    #[test]
    fn test_windows_build_gate_accepts_supported_builds() {
        assert!(check_windows_build_supported(17763).is_ok());
        assert!(check_windows_build_supported(18362).is_ok());
        assert!(check_windows_build_supported(22631).is_ok());
    }

    #[test]
    fn test_windows_build_gate_rejects_legacy_builds_with_actionable_error() {
        for legacy in [10240u32, 14393, 15063, 16299, 17134] {
            let err = check_windows_build_supported(legacy).expect_err("legacy must fail");
            let msg = err.to_string();
            assert!(msg.contains("17763"), "must name minimum build: {}", msg);
            assert!(msg.contains("ConPTY"), "must mention ConPTY: {}", msg);
        }
    }

    #[test]
    fn test_wsl_shell_path_detection() {
        assert!(is_wsl_shell_path("wsl.exe"));
        assert!(is_wsl_shell_path("C:\\Windows\\System32\\wsl.exe"));
        assert!(is_wsl_shell_path("WSL"));
        assert!(!is_wsl_shell_path("C:\\Windows\\System32\\cmd.exe"));
        assert!(!is_wsl_shell_path("/bin/bash"));
        assert!(!wsl_failure_hint().is_empty());
    }
}
