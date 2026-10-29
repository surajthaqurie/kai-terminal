use crate::error::TerminalError;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::env;
use std::path::Path;
use std::sync::OnceLock;

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
///
/// Result is cached per process: every scan walks the filesystem across all
/// PATH entries (including slow network / OneDrive-synced locations), and
/// previously every new tab paid that cost synchronously during launch —
/// a classic first-tab stall on Windows. Restart the app to pick up a
/// newly installed shell. Use `detect_available_shells_uncached` to force
/// a rescan (tests, future refresh UI).
pub fn detect_available_shells() -> Vec<ShellProfile> {
    static SHELLS_CACHE: OnceLock<Vec<ShellProfile>> = OnceLock::new();
    SHELLS_CACHE
        .get_or_init(detect_available_shells_uncached)
        .clone()
}

/// Uncached filesystem scan for installed shells (see
/// `detect_available_shells` for why callers should prefer the cache).
pub fn detect_available_shells_uncached() -> Vec<ShellProfile> {
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
                    // -NoLogo skips the banner print (faster paint, less
                    // PTY flood). Profile still loads; use -NoProfile only
                    // for diagnostics, never as the default.
                    args: Some(vec!["-NoLogo".to_string()]),
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
                // -NoLogo skips the banner print (faster paint, less PTY
                // flood on slow disks where .NET JIT already stalls).
                args: Some(vec!["-NoLogo".to_string()]),
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
/// On Windows, queries the current build number ONCE per process (cached in
/// a `OnceLock`) and rejects unsupported hosts with an actionable error
/// instead of a cryptic ConPTY failure. Caching matters: every PTY spawn
/// previously ran `cmd /c ver` synchronously, adding seconds to session open.
/// On Unix/macOS this is a no-op (native `openpty` is always present).
/// Applies `CREATE_NO_WINDOW` on Windows so helper spawns (`reg`,
/// `cmd`, editors) never flash a `conhost.exe` window behind the main
/// window and never steal focus. No-op on other OSes.
#[cfg(target_os = "windows")]
fn hide_console(cmd: &mut std::process::Command) {
    use std::os::windows::process::CommandExt;
    // 0x08000000 == CREATE_NO_WINDOW: spawn without a visible console.
    cmd.creation_flags(0x08000000);
}

/// Environment variables a Chromium/Electron parent (WebView2, VS Code, Edge)
/// leaves behind for the processes it starts.
///
/// `CHROME_CRASHPAD_PIPE_NAME` names the crash-reporter pipe of that parent.
/// A shell or tool that inherits it and is itself Chromium-based tries to
/// register with a pipe that is not its own and prints
/// `registration_protocol_win.cc: CreateFile: The system cannot find the file
/// specified. (0x2)`. Nothing Kai starts on the user's behalf should carry it.
pub const LEAKED_CHROMIUM_ENV: &[&str] = &["CHROME_CRASHPAD_PIPE_NAME"];

/// Removes [`LEAKED_CHROMIUM_ENV`] from a child about to be spawned.
pub fn scrub_chromium_env(cmd: &mut std::process::Command) {
    for key in LEAKED_CHROMIUM_ENV {
        cmd.env_remove(key);
    }
}

/// Warms the cached Windows build number off the hot path (background
/// thread, runs once per process). Called at app startup so the first
/// `create_pty` below never pays `reg` + `cmd /c ver` synchronously.
#[cfg(target_os = "windows")]
pub fn warm_host_pty_cache() {
    static WARM_ONCE: std::sync::Once = std::sync::Once::new();
    WARM_ONCE.call_once(|| {
        std::thread::spawn(|| {
            let build = current_windows_build();
            let _ = BUILD_CACHE.set(build);
        });
    });
}

#[cfg(target_os = "windows")]
static BUILD_CACHE: OnceLock<Option<u32>> = OnceLock::new();

pub fn check_host_pty_support() -> Result<(), TerminalError> {
    #[cfg(target_os = "windows")]
    {
        let cached = BUILD_CACHE.get_or_init(current_windows_build);
        match *cached {
            Some(b) => check_windows_build_supported(b),
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

/// Runs a Windows helper process with a hard timeout, killing it on expiry.
/// Console-host spawns (`cmd`, `reg`, `powershell`) can stall for tens of
/// seconds on loaded machines (AV hooks, syncing disks) — without a timeout
/// the first PTY creation hangs and the OS flags the window "Not Responding".
#[cfg(target_os = "windows")]
fn run_bounded_windows(cmd: &str, args: &[&str], timeout_secs: u64) -> Option<String> {
    use std::io::Read;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};
    let mut command = Command::new(cmd);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    hide_console(&mut command);
    let mut child = command.spawn().ok()?;
    // Take the pipe up front so no output is lost after reaping.
    let mut piped = child.stdout.take();
    let deadline = Instant::now() + Duration::from_secs(timeout_secs);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            Err(_) => return None,
        }
    }
    let _ = child.wait();
    // Helper outputs (`ver`, `reg query`) are < 1 KB — far below the 64 KB
    // pipe buffer, so the child can never block on a full pipe here.
    let mut text = String::new();
    if let Some(ref mut out) = piped {
        let _ = out.read_to_string(&mut text);
    }
    if text.trim().is_empty() {
        None
    } else {
        Some(text)
    }
}

/// Best-effort query of the current Windows build number without extra deps.
///
/// Tries the registry first (locale-independent, no console host), then
/// falls back to parsing `cmd /c ver` output (e.g.
/// `... [Version 10.0.22631.4169]`). Both helpers run under a hard timeout.
/// Returns `None` when the version cannot be determined.
#[cfg(target_os = "windows")]
fn current_windows_build() -> Option<u32> {
    // 1. Registry: CurrentBuildNumber (e.g. "22631").
    if let Some(out) = run_bounded_windows(
        "reg",
        &[
            "query",
            r"HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion",
            "/v",
            "CurrentBuildNumber",
        ],
        5,
    ) {
        for line in out.lines() {
            if line.contains("CurrentBuildNumber") {
                if let Some(token) = line.split_whitespace().last() {
                    if let Ok(build) = token.trim().parse::<u32>() {
                        return Some(build);
                    }
                }
            }
        }
    }
    // 2. Fallback: `cmd /c ver`.
    let text = run_bounded_windows("cmd", &["/c", "ver"], 5)?;
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
///
/// Accepts a directory OR a file path: when `requested_cwd` points at a
/// file, its parent directory is used (so pasting a file path or an editor
/// buffer path still opens the containing project). When the path does not
/// exist, a single parent-directory fallback is attempted before erroring.
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
                }
                // File path -> use its parent directory ("proper parent path").
                if p.is_file() {
                    if let Some(parent) = p.parent() {
                        let parent_str = parent.to_string_lossy().to_string();
                        if !parent_str.is_empty() && Path::new(&parent_str).is_dir() {
                            return Ok(parent_str);
                        }
                    }
                    return Err(TerminalError::InvalidDirectory(format!(
                        "Working directory path '{}' is a file, not a directory",
                        trimmed
                    )));
                }
                return Err(TerminalError::InvalidDirectory(format!(
                    "Working directory path '{}' is not a directory",
                    trimmed
                )));
            } else {
                // Non-existent path: try the parent (handles trailing
                // filenames / not-yet-created subpaths pasted from elsewhere).
                // Never fall back to a filesystem root: a top-level miss like
                // "/non_existent_xyz" (parent "/") must still error instead of
                // silently opening "/" (root has no parent, so `par.parent()`
                // is `None` there on all OSes).
                let parent = p.parent();
                if let Some(par) = parent {
                    let parent_str = par.to_string_lossy().to_string();
                    if !parent_str.is_empty()
                        && par.parent().is_some()
                        && Path::new(&parent_str).is_dir()
                    {
                        return Ok(parent_str);
                    }
                }
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
        #[cfg(target_os = "windows")]
        let pathext = env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string());
        for dir in env::split_paths(&path_env) {
            let full_path = dir.join(cmd);
            #[cfg(not(target_os = "windows"))]
            if full_path.exists() && is_executable(&full_path) {
                return Ok(full_path.to_string_lossy().to_string());
            }

            // Windows: an extensionless file is never launchable via
            // CreateProcess. Editors ship a bash shim named exactly `code` /
            // `cursor` next to `code.cmd` / `cursor.cmd`; returning the bare
            // shim made every launch fail with "not a valid Win32
            // application". Accept an exact match only when it already has a
            // PATHEXT extension, otherwise try each PATHEXT extension.
            #[cfg(target_os = "windows")]
            {
                let has_exec_ext = Path::new(cmd)
                    .extension()
                    .map(|e| {
                        let dotted = format!(".{}", e.to_string_lossy());
                        pathext
                            .split(';')
                            .any(|x| !x.trim().is_empty() && x.trim().eq_ignore_ascii_case(&dotted))
                    })
                    .unwrap_or(false);
                if has_exec_ext && full_path.is_file() {
                    return Ok(full_path.to_string_lossy().to_string());
                }
                for ext in pathext.split(';') {
                    let ext_trimmed = ext.trim();
                    if !ext_trimmed.is_empty() {
                        let path_with_ext =
                            dir.join(format!("{}{}", cmd, ext_trimmed.to_lowercase()));
                        if path_with_ext.is_file() {
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

/// Installed code editor discovered on the host.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EditorInfo {
    pub id: String,
    pub name: String,
    pub binary: String,
    pub path: String,
}

/// Candidate editors with display names. `binary` is the primary PATH lookup
/// name; `aliases` covers alternate binary names for the same editor
/// (e.g. VSCodium ships as `codium` or `vscodium` depending on install).
fn editor_candidates() -> Vec<(&'static str, &'static str, Vec<&'static str>)> {
    vec![
        ("vscode", "Visual Studio Code", vec!["code"]),
        ("cursor", "Cursor", vec!["cursor"]),
        ("windsurf", "Windsurf", vec!["windsurf"]),
        ("vscodium", "VSCodium", vec!["codium", "vscodium"]),
        ("sublime", "Sublime Text", vec!["subl", "sublime_text"]),
        ("zed", "Zed", vec!["zed"]),
        ("atom", "Atom", vec!["atom"]),
        ("idea", "IntelliJ IDEA", vec!["idea"]),
        ("fleet", "JetBrains Fleet", vec!["fleet"]),
        ("webstorm", "WebStorm", vec!["webstorm"]),
        ("clion", "CLion", vec!["clion"]),
    ]
}

/// PATH lookup trying each alias in order. Returns the first resolved path.
fn which_editor_alias(aliases: &[&str]) -> Option<String> {
    for a in aliases {
        if let Ok(p) = which_path(a) {
            return Some(p);
        }
    }
    None
}

/// Detects installed code editors without spawning shells: PATH lookup plus
/// well-known install locations per OS. Never fails — returns an empty vec
/// when nothing is found so the frontend can show "No editors found".
///
/// Result is cached per process: every scan walks PATH plus well-known
/// `Program Files` / `LOCALAPPDATA` locations and `canonicalize()`s each hit.
/// On Windows (Defender/AV + spinning disks) that costs hundreds of ms, and
/// the frontend used to pay it during startup *and* on every reopen of the
/// picker. Restart the app to pick up a newly installed editor. Use
/// `detect_installed_editors_uncached` to force a rescan (tests).
pub fn detect_installed_editors() -> Vec<EditorInfo> {
    static EDITORS_CACHE: OnceLock<Vec<EditorInfo>> = OnceLock::new();
    EDITORS_CACHE
        .get_or_init(detect_installed_editors_uncached)
        .clone()
}

/// Uncached filesystem scan for installed editors (see
/// `detect_installed_editors` for why callers should prefer the cache).
pub fn detect_installed_editors_uncached() -> Vec<EditorInfo> {
    let mut out: Vec<EditorInfo> = Vec::new();
    let mut seen_paths: Vec<String> = Vec::new();
    // Dedup key: canonicalized path. Case-insensitive only on
    // case-insensitive filesystems (Windows/macOS); Linux paths are
    // case-sensitive so `Code` and `code` are distinct files there.
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    let normalize_key = |s: &str| s.to_lowercase();
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    let normalize_key = |s: &str| s.to_string();
    let mut push_unique = |id: &str, name: &str, binary: &str, path: String| {
        let canon = Path::new(&path)
            .canonicalize()
            .ok()
            .map(|p| normalize_key(&p.to_string_lossy()))
            .unwrap_or_else(|| normalize_key(&path));
        if seen_paths.contains(&canon) {
            return;
        }
        seen_paths.push(canon);
        out.push(EditorInfo {
            id: id.to_string(),
            name: name.to_string(),
            binary: binary.to_string(),
            path,
        });
    };

    for (id, name, aliases) in editor_candidates() {
        let binary = aliases[0];
        if let Some(p) = which_editor_alias(&aliases) {
            push_unique(id, name, binary, p);
            continue;
        }
        // Fall back to well-known absolute locations (not on PATH).
        #[cfg(target_os = "windows")]
        {
            let pf = env::var("ProgramFiles").unwrap_or_else(|_| "C:\\Program Files".into());
            let pf86 =
                env::var("ProgramFiles(x86)").unwrap_or_else(|_| "C:\\Program Files (x86)".into());
            let local = env::var("LOCALAPPDATA").unwrap_or_default();
            let guesses: Vec<String> = match id {
                "vscode" => vec![
                    format!("{}\\Programs\\Microsoft VS Code\\Code.exe", local),
                    format!("{}\\Programs\\Microsoft VS Code\\bin\\code.cmd", local),
                    format!("{}\\Microsoft VS Code\\Code.exe", pf),
                    format!("{}\\Microsoft VS Code\\bin\\code.cmd", pf),
                    format!("{}\\Microsoft VS Code\\Code.exe", pf86),
                ],
                "cursor" => vec![
                    format!("{}\\Programs\\cursor\\Cursor.exe", local),
                    format!("{}\\Programs\\Cursor\\Cursor.exe", local),
                    format!("{}\\Cursor\\Cursor.exe", local),
                ],
                "windsurf" => vec![
                    format!("{}\\Programs\\Windsurf\\Windsurf.exe", local),
                    format!("{}\\Windsurf\\Windsurf.exe", local),
                    format!("{}\\Windsurf\\Windsurf.exe", pf),
                ],
                "vscodium" => vec![
                    format!("{}\\Programs\\VSCodium\\VSCodium.exe", local),
                    format!("{}\\Programs\\VSCodium\\bin\\codium.cmd", local),
                    format!("{}\\VSCodium\\VSCodium.exe", pf),
                ],
                "sublime" => vec![
                    format!("{}\\Sublime Text\\sublime_text.exe", pf),
                    format!("{}\\Sublime Text\\sublime_text.exe", pf86),
                ],
                "zed" => vec![
                    format!("{}\\Programs\\Zed\\zed.exe", local),
                    format!("{}\\Zed\\zed.exe", pf),
                ],
                _ => vec![],
            };
            for g in guesses {
                if Path::new(&g).exists() {
                    push_unique(id, name, binary, g);
                    break;
                }
            }
        }
        #[cfg(target_os = "macos")]
        {
            // Prefer the CLI shim (`bin/code`); fall back to the .app bundle
            // itself, which `open_in_editor` launches via `open -a`.
            // (The shim only exists after "Install 'code' command in PATH".)
            let guesses: Vec<(String, String)> = match id {
                "vscode" => vec![
                    (
                        "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code".into(),
                        "/Applications/Visual Studio Code.app".into(),
                    ),
                    (
                        "/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code-insiders".into(),
                        "/Applications/Visual Studio Code - Insiders.app".into(),
                    ),
                ],
                "cursor" => vec![(
                    "/Applications/Cursor.app/Contents/Resources/app/bin/cursor".into(),
                    "/Applications/Cursor.app".into(),
                )],
                "sublime" => vec![(
                    "/Applications/Sublime Text.app/Contents/SharedSupport/bin/subl".into(),
                    "/Applications/Sublime Text.app".into(),
                )],
                "zed" => vec![(
                    "/Applications/Zed.app/Contents/MacOS/zed".into(),
                    "/Applications/Zed.app".into(),
                )],
                _ => vec![],
            };
            for (shim, bundle) in guesses {
                if Path::new(&shim).exists() {
                    push_unique(id, name, binary, shim);
                    break;
                }
                if Path::new(&bundle).exists() {
                    push_unique(id, name, binary, bundle);
                    break;
                }
            }
        }
        #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
        {
            let guesses: Vec<String> = match id {
                "vscode" => vec!["/usr/bin/code".into(), "/snap/bin/code".into()],
                "cursor" => vec!["/usr/bin/cursor".into()],
                "sublime" => vec![
                    "/usr/bin/subl".into(),
                    "/opt/sublime_text/sublime_text".into(),
                ],
                "zed" => vec!["/usr/bin/zed".into()],
                _ => vec![],
            };
            for g in guesses {
                if Path::new(&g).exists() {
                    push_unique(id, name, binary, g);
                    break;
                }
            }
        }
    }
    out
}

/// Opens a project directory in a configured editor (Phase D).
///
/// Auto-detect order matches `editor_candidates` (VS Code first, then
/// Cursor, Windsurf, VSCodium, Sublime, Zed, terminal editors, JetBrains).
/// Cross-platform launch notes:
/// - Windows `.cmd`/`.bat`/`.ps1` shims (e.g. `code.cmd` on PATH) cannot be
///   spawned directly via `CreateProcess`; they run through `cmd /c`.
/// - macOS `.app` bundles (recorded when the CLI shim is not installed)
///   open via `open -a <bundle> <dir>`.
/// - Unix binaries spawn directly with `[cwd]` as argv[1].
///
/// Never uses shell string interpolation; argv arrays only.
pub fn open_in_editor(requested_editor: Option<&str>, cwd: &str) -> Result<String, TerminalError> {
    let valid_cwd = validate_and_resolve_cwd(Some(cwd))?;

    // Flattened alias order from `editor_candidates` — single source of
    // truth for auto-detect priority on every OS.
    let candidate_editors = [
        "code",
        "cursor",
        "windsurf",
        "codium",
        "vscodium",
        "subl",
        "sublime_text",
        "zed",
        "atom",
        "idea",
        "fleet",
        "webstorm",
        "clion",
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
            let installed = detect_installed_editors();
            if let Some(ed) = installed.iter().find(|e| {
                e.id.eq_ignore_ascii_case(trimmed)
                    || e.binary.eq_ignore_ascii_case(trimmed)
                    || e.name.eq_ignore_ascii_case(trimmed)
            }) {
                ed.path.clone()
            } else {
                return Err(TerminalError::ShellNotFound(format!(
                    "Editor binary '{}' not found on system PATH",
                    trimmed
                )));
            }
        }
    } else {
        let mut found = None;
        for cand in candidate_editors {
            if let Ok(p) = which_path(cand) {
                found = Some(p);
                break;
            }
        }
        if found.is_none() {
            let installed = detect_installed_editors();
            if let Some(first) = installed.into_iter().next() {
                found = Some(first.path);
            }
        }
        found.ok_or_else(|| {
            TerminalError::ShellNotFound(
                "No supported code editor (e.g. code, cursor, vscodium, subl) found on PATH".into(),
            )
        })?
    };

    // A path recorded without a launchable extension (e.g. the bash shim
    // `...\bin\code` a user pasted or an older scan stored) is mapped to its
    // `.cmd`/`.exe` sibling before anything is spawned.
    #[cfg(target_os = "windows")]
    let editor_bin = windows_launchable_path(&editor_bin);

    // Cross-platform spawn (argv arrays only, no shell interpolation):
    #[cfg(target_os = "windows")]
    {
        let exe_candidate = if is_windows_script_shim(&editor_bin) {
            windows_gui_exe_for_shim(Path::new(&editor_bin))
        } else {
            None
        };

        if let Some(exe_path) = exe_candidate {
            let mut c = std::process::Command::new(exe_path);
            c.arg(&valid_cwd);
            scrub_chromium_env(&mut c);
            hide_console(&mut c);
            c.spawn().map_err(|e| {
                TerminalError::IoError(format!("Failed to launch editor '{}': {}", editor_bin, e))
            })?;
            return Ok(editor_bin);
        }

        if is_windows_script_shim(&editor_bin) {
            // No GUI exe found next to the shim: run it through `cmd`. The
            // whole command line is passed raw, wrapped in an extra pair of
            // quotes (`/s` strips exactly that pair), so paths containing
            // spaces survive cmd's quote-stripping rules. `"` is not a legal
            // path character on Windows, so no escaping is needed.
            use std::os::windows::process::CommandExt;
            if editor_bin.contains('"') || valid_cwd.contains('"') {
                return Err(TerminalError::IoError(
                    "Editor or project path contains an invalid quote character".into(),
                ));
            }
            let mut c = std::process::Command::new("cmd");
            c.raw_arg(format!("/d /s /c \"\"{}\" \"{}\"\"", editor_bin, valid_cwd));
            scrub_chromium_env(&mut c);
            hide_console(&mut c);
            c.spawn().map_err(|e| {
                TerminalError::IoError(format!("Failed to launch editor '{}': {}", editor_bin, e))
            })?;
            return Ok(editor_bin);
        }
    }
    #[cfg(target_os = "macos")]
    {
        if editor_bin.ends_with(".app") {
            std::process::Command::new("open")
                .args(["-a", &editor_bin, &valid_cwd])
                .spawn()
                .map_err(|e| {
                    TerminalError::IoError(format!(
                        "Failed to launch editor '{}': {}",
                        editor_bin, e
                    ))
                })?;
            return Ok(editor_bin);
        }
    }
    // Generic spawn path: hide the console host on Windows so launching a
    // console-subsystem editor never flashes a ghost conhost window behind
    // the main window (same CREATE_NO_WINDOW treatment as the branches above).
    let mut editor_cmd = std::process::Command::new(&editor_bin);
    editor_cmd.arg(&valid_cwd);
    scrub_chromium_env(&mut editor_cmd);
    #[cfg(target_os = "windows")]
    hide_console(&mut editor_cmd);
    editor_cmd.spawn().map_err(|e| {
        TerminalError::IoError(format!("Failed to launch editor '{}': {}", editor_bin, e))
    })?;

    Ok(editor_bin)
}

/// Allow-listed base for external URLs opened from the UI.
///
/// `window.open` cannot reach the OS browser from the Tauri WebView (no
/// opener plugin shipped), so "View release" and friends go through this
/// backend command instead. Only our own releases page (and release URLs
/// under it) and three exact YouTube link shapes (the music player's
/// "Open in browser") and Azure DevOps' own token page (the Integrations
/// panel's "Create a token") may be opened — never arbitrary user input.
pub const EXTERNAL_URL_BASE: &str = "https://github.com/surajthaqurie/kai-terminal/";
pub const EXTERNAL_URL_FALLBACK: &str =
    "https://github.com/surajthaqurie/kai-terminal/releases/latest";

const YOUTUBE_URL_BASE: &str = "https://www.youtube.com/";

/// True only for `watch?v=<11-char id>`, `playlist?list=<id>` and
/// `results?search_query=<words>` on www.youtube.com.
///
/// On Windows the URL goes through `cmd /c start`, so the allowed alphabet is
/// deliberately free of every cmd metacharacter (`& | ^ % < > "`, all ASCII):
/// ids are `[A-Za-z0-9_-]`, and search words are ASCII letters/digits, any
/// non-ASCII character (so every script and combining mark works without
/// percent-encoding), and `+ . _ ~ -`. Any other ASCII is refused, not escaped.
fn is_allowed_youtube_url(url: &str) -> bool {
    let Some(rest) = url.strip_prefix(YOUTUBE_URL_BASE) else {
        return false;
    };
    let id_ok = |s: &str, min: usize, max: usize| {
        (min..=max).contains(&s.len())
            && s.chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    };
    if let Some(v) = rest.strip_prefix("watch?v=") {
        return id_ok(v, 11, 11);
    }
    if let Some(l) = rest.strip_prefix("playlist?list=") {
        return id_ok(l, 10, 64);
    }
    if let Some(q) = rest.strip_prefix("results?search_query=") {
        return !q.is_empty()
            && q.chars().all(|c| {
                !c.is_ascii()
                    || c.is_ascii_alphanumeric()
                    || matches!(c, '+' | '.' | '_' | '~' | '-')
            });
    }
    false
}

const AZURE_DEVOPS_URL_BASE: &str = "https://dev.azure.com/";

/// True only for `https://dev.azure.com/` and
/// `https://dev.azure.com/<org>/_usersSettings/tokens`, where `<org>` is
/// `[A-Za-z0-9._-]` (no cmd metacharacter, no leading dot).
fn is_allowed_azure_devops_url(url: &str) -> bool {
    let Some(rest) = url.strip_prefix(AZURE_DEVOPS_URL_BASE) else {
        return false;
    };
    if rest.is_empty() {
        return true;
    }
    let Some(org) = rest.strip_suffix("/_usersSettings/tokens") else {
        return false;
    };
    (1..=64).contains(&org.len())
        && !org.starts_with('.')
        && org
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

/// Pure validation for external URLs (unit-tested; no process is spawned).
pub fn validate_external_url(url: &str) -> Result<(), TerminalError> {
    if url.is_empty() || url.len() > 512 {
        return Err(TerminalError::IoError(
            "Refusing to open an invalid URL.".to_string(),
        ));
    }
    if url.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(TerminalError::IoError(
            "Refusing to open a URL with whitespace or control characters.".to_string(),
        ));
    }
    if !(url == EXTERNAL_URL_FALLBACK
        || url.starts_with(EXTERNAL_URL_BASE)
        || is_allowed_youtube_url(url)
        || is_allowed_azure_devops_url(url))
    {
        return Err(TerminalError::IoError(
            "Refusing to open a URL outside the Kai Terminal releases page, a YouTube link or the Azure DevOps token page."
                .to_string(),
        ));
    }
    Ok(())
}

/// Open an allow-listed https URL in the OS default browser (all OSes).
///
/// Detached spawn: returns once the launcher starts, never blocks the UI
/// thread. Validation runs first — the URL reaches a native launcher, so
/// arbitrary input must never get here.
pub fn open_external_url(url: &str) -> Result<(), TerminalError> {
    validate_external_url(url)?;
    #[cfg(target_os = "windows")]
    {
        let mut c = std::process::Command::new("cmd");
        // `start` treats the first quoted arg as a window title: the empty
        // `""` keeps the URL in the right slot. Argv-only, no shell string.
        c.args(["/c", "start", "", url]);
        scrub_chromium_env(&mut c);
        hide_console(&mut c);
        c.spawn()
            .map_err(|e| TerminalError::IoError(format!("Failed to open URL: {e}")))?;
        Ok(())
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(url)
            .spawn()
            .map_err(|e| TerminalError::IoError(format!("Failed to open URL: {e}")))?;
        Ok(())
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let mut c = std::process::Command::new("xdg-open");
        c.arg(url);
        scrub_chromium_env(&mut c);
        c.spawn().map_err(|e| {
            TerminalError::IoError(format!("Failed to open URL (is xdg-open installed?): {e}"))
        })?;
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct YouTubeVideoItem {
    pub video_id: String,
    pub title: String,
}

/// Byte-range slice that can NEVER panic: returns None when start/end are
/// out of bounds or land inside a multi-byte UTF-8 character. YouTube's
/// result pages embed raw non-ASCII text, so fixed byte offsets routinely
/// hit char-boundary crossings — a plain `&s[a..b]` would panic, and with
/// the release profile's `panic = "abort"` that closes the whole app.
fn try_slice(s: &str, start: usize, end: usize) -> Option<&str> {
    if start <= end
        && start <= s.len()
        && end <= s.len()
        && s.is_char_boundary(start)
        && s.is_char_boundary(end)
    {
        Some(&s[start..end])
    } else {
        None
    }
}

/// Extracts YouTube videos (videoId and title) from search results HTML.
pub fn extract_videos_from_search_html(html: &str, limit: usize) -> Vec<YouTubeVideoItem> {
    let mut items = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let vid_renderer_pattern = "\"videoRenderer\":{\"videoId\":\"";
    let fallback_vid_pattern = "\"videoId\":\"";
    let title_pattern = "\"title\":{\"runs\":[{\"text\":\"";

    let pattern = if html.contains(vid_renderer_pattern) {
        vid_renderer_pattern
    } else {
        fallback_vid_pattern
    };

    let mut offset = 0;
    while let Some(idx) = html[offset..].find(pattern) {
        let vid_start = offset + idx + pattern.len();
        let search_chunk_end = (vid_start + 1500).min(html.len());
        let (Some(candidate_id), Some(chunk)) = (
            try_slice(html, vid_start, vid_start + 11),
            try_slice(html, vid_start, search_chunk_end),
        ) else {
            // Char-boundary crossing (non-ASCII content) or near-end-of-page:
            // stop parsing rather than ever risking a panic.
            break;
        };
        if candidate_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        {
            let raw_title = if let Some(t_idx) = chunk.find(title_pattern) {
                let t_start = t_idx + title_pattern.len();
                if let Some(t_end) = chunk[t_start..].find('"') {
                    &chunk[t_start..t_start + t_end]
                } else {
                    candidate_id
                }
            } else {
                candidate_id
            };

            let clean_title = raw_title
                .replace("\\u0026", "&")
                .replace("\\\"", "\"")
                .replace("\\'", "'");

            if !seen.contains(candidate_id) {
                seen.insert(candidate_id.to_string());
                items.push(YouTubeVideoItem {
                    video_id: candidate_id.to_string(),
                    title: if clean_title.trim().is_empty() {
                        candidate_id.to_string()
                    } else {
                        clean_title
                    },
                });
                if items.len() >= limit {
                    break;
                }
            }
        }
        offset = vid_start;
    }
    items
}

/// Extracts the first 11-char YouTube videoId from search results HTML.
pub fn extract_video_id_from_search_html(html: &str) -> Option<String> {
    extract_videos_from_search_html(html, 1)
        .first()
        .map(|v| v.video_id.clone())
}

/// `application/x-www-form-urlencoded` encoding for a search query: every
/// byte except unreserved ones becomes `%XX` (UTF-8 bytes included), spaces
/// become `+`. The previous `replace(' ', "+")` left `&`, `#`, `/`, etc. raw,
/// so queries like "AC/DC & Friends" truncated the parameter or broke the
/// request entirely.
#[cfg(any(feature = "tauri", test))]
fn encode_search_query(q: &str) -> String {
    let mut out = String::with_capacity(q.len() + 8);
    for &b in q.as_bytes() {
        match b {
            b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'*' => {
                out.push(b as char)
            }
            b' ' => out.push('+'),
            _ => {
                const HEX: &[u8; 16] = b"0123456789ABCDEF";
                out.push('%');
                out.push(HEX[usize::from(b >> 4)] as char);
                out.push(HEX[usize::from(b & 0x0F)] as char);
            }
        }
    }
    out
}

/// Searches YouTube for a query and extracts multiple matching videos (videoId and title).
#[cfg(feature = "tauri")]
pub async fn search_youtube_videos(
    query: &str,
    limit: usize,
) -> Result<Vec<YouTubeVideoItem>, TerminalError> {
    let clean = query.trim();
    if clean.is_empty() || clean.len() > 200 {
        return Err(TerminalError::IoError("Invalid search query".to_string()));
    }
    let url = format!(
        "https://www.youtube.com/results?search_query={}",
        encode_search_query(clean)
    );
    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
        .timeout(std::time::Duration::from_secs(8))
        .build()
        .map_err(|e| TerminalError::IoError(format!("Search client error: {e}")))?;

    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| TerminalError::IoError(format!("Search request failed: {e}")))?;
    let html = resp
        .text()
        .await
        .map_err(|e| TerminalError::IoError(format!("Failed to read search response: {e}")))?;

    let results = extract_videos_from_search_html(&html, limit.clamp(1, 20));
    if results.is_empty() {
        return Err(TerminalError::IoError(
            "No video found for search query".to_string(),
        ));
    }
    Ok(results)
}

/// Searches YouTube for a query and extracts the first matching videoId.
/// Performs request via backend reqwest client to avoid browser CORS limitations.
#[cfg(feature = "tauri")]
pub async fn search_youtube_video(query: &str) -> Result<String, TerminalError> {
    let videos = search_youtube_videos(query, 1).await?;
    Ok(videos[0].video_id.clone())
}

/// Validates a YouTube playlist id (`list=` value): 10-64 chars of
/// [A-Za-z0-9_-]. Covers `PL…`, `OL…`, `LL…`, `RD…`, `UULF…` and similar.
pub fn is_valid_playlist_id(id: &str) -> bool {
    let len = id.len();
    (10..=64).contains(&len)
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// Extracts playlist videos (videoId + title) IN PLAYLIST ORDER from a
/// `playlist?list=…` page. Repeat entries (the same videoId appears multiple
/// times in the JSON) keep only their first occurrence.
pub fn extract_videos_from_playlist_html(html: &str, limit: usize) -> Vec<YouTubeVideoItem> {
    let mut items = Vec::new();
    let renderer_pattern = "\"playlistVideoRenderer\":{\"videoId\":\"";
    let fallback_vid_pattern = "\"videoId\":\"";
    let title_pattern = "\"title\":{\"runs\":[{\"text\":\"";

    let pattern = if html.contains(renderer_pattern) {
        renderer_pattern
    } else {
        fallback_vid_pattern
    };

    let mut offset = 0;
    while let Some(idx) = html[offset..].find(pattern) {
        let vid_start = offset + idx + pattern.len();
        let chunk_end = (vid_start + 1500).min(html.len());
        let (Some(candidate_id), Some(chunk)) = (
            try_slice(html, vid_start, vid_start + 11),
            try_slice(html, vid_start, chunk_end),
        ) else {
            // Never panic on a char-boundary crossing (see try_slice).
            break;
        };
        if candidate_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
            && !items
                .iter()
                .any(|v: &YouTubeVideoItem| v.video_id.as_str() == candidate_id)
        {
            let raw_title = if let Some(t_idx) = chunk.find(title_pattern) {
                let t_start = t_idx + title_pattern.len();
                if let Some(t_end) = chunk[t_start..].find('"') {
                    &chunk[t_start..t_start + t_end]
                } else {
                    candidate_id
                }
            } else {
                candidate_id
            };

            let clean_title = raw_title
                .replace("\\u0026", "&")
                .replace("\\\"", "\"")
                .replace("\\'", "'");

            items.push(YouTubeVideoItem {
                video_id: candidate_id.to_string(),
                title: if clean_title.trim().is_empty() {
                    candidate_id.to_string()
                } else {
                    clean_title
                },
            });
            if items.len() >= limit {
                break;
            }
        }
        offset = vid_start;
    }
    items
}

/// Fetches the ordered video list of a YouTube playlist (videoId + title)
/// via the backend reqwest client, avoiding browser CORS limitations.
#[cfg(feature = "tauri")]
pub async fn fetch_youtube_playlist(
    playlist_id: &str,
    limit: usize,
) -> Result<Vec<YouTubeVideoItem>, TerminalError> {
    let clean = playlist_id.trim();
    if !is_valid_playlist_id(clean) {
        return Err(TerminalError::IoError("Invalid playlist id".to_string()));
    }
    let url = format!("https://www.youtube.com/playlist?list={clean}");
    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
        .timeout(std::time::Duration::from_secs(8))
        .build()
        .map_err(|e| TerminalError::IoError(format!("Playlist client error: {e}")))?;

    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| TerminalError::IoError(format!("Playlist request failed: {e}")))?;
    let html = resp
        .text()
        .await
        .map_err(|e| TerminalError::IoError(format!("Failed to read playlist response: {e}")))?;

    let results = extract_videos_from_playlist_html(&html, limit.clamp(1, 500));
    if results.is_empty() {
        return Err(TerminalError::IoError(
            "No playlist videos found (playlist may be empty or private)".to_string(),
        ));
    }
    Ok(results)
}

/// Returns true for Windows script shims that `CreateProcess` cannot run
/// directly (`.cmd`, `.bat`, `.ps1` — e.g. VS Code's `code.cmd` on PATH).
#[cfg(target_os = "windows")]
fn is_windows_script_shim(path: &str) -> bool {
    let lower = path.to_lowercase();
    lower.ends_with(".cmd") || lower.ends_with(".bat") || lower.ends_with(".ps1")
}

/// Maps an existing extensionless file (the bash shim editors ship beside
/// `code.cmd`) to its launchable `.exe` / `.cmd` / `.bat` sibling. Paths that
/// already have an extension, or have no launchable sibling, are returned
/// unchanged so the spawn error stays honest.
#[cfg(any(target_os = "windows", test))]
fn windows_launchable_path(path: &str) -> String {
    let p = Path::new(path);
    if p.extension().is_some() {
        return path.to_string();
    }
    for ext in ["exe", "cmd", "bat"] {
        let sibling = p.with_extension(ext);
        if sibling.is_file() {
            return sibling.to_string_lossy().to_string();
        }
    }
    path.to_string()
}

/// Finds the real GUI executable that a `<install>\bin\<name>.cmd` shim
/// wraps. Spawning it directly skips `cmd.exe` (faster, no quoting hazards, no
/// console flash). VS Code / VSCodium / Windsurf keep it one level above
/// `bin`; Cursor keeps it two levels up (`resources\app\bin`). Only an exe
/// whose file stem matches a known editor name is accepted, so an unrelated
/// binary in a parent directory is never launched.
#[cfg(any(target_os = "windows", test))]
fn windows_gui_exe_for_shim(shim: &Path) -> Option<std::path::PathBuf> {
    const GUI_EXES: [&str; 7] = [
        "Code.exe",
        "Code - Insiders.exe",
        "Cursor.exe",
        "Windsurf.exe",
        "VSCodium.exe",
        "Zed.exe",
        "sublime_text.exe",
    ];
    let bin_dir = shim.parent()?;
    for root in bin_dir.ancestors().skip(1).take(3) {
        for name in GUI_EXES {
            let candidate = root.join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

/// Host system terminal configuration detected from terminal emulators or desktop environment.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SystemTerminalConfig {
    pub font_family: String,
    pub font_size: u16,
    pub theme: String,
    pub cursor_blink: bool,
    pub cursor_style: String,
    pub opacity: f64,
    pub default_shell: Option<String>,
}

/// Detects host terminal settings and preferences (e.g. Kali Linux QTerminal / XFCE terminal / system font).
pub fn detect_system_terminal_config() -> SystemTerminalConfig {
    let font_size = 12u16;
    let default_shell = env::var("SHELL").ok();

    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    let (font_family, theme, cursor_blink, cursor_style, opacity) = {
        let mut font_family = "'Fira Code', 'FiraCode', 'DejaVu Sans Mono', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace".to_string();
        let mut theme = "kali".to_string();
        let mut cursor_blink = false;
        let mut cursor_style = "block".to_string();
        let mut opacity = 1.0f64;

        if let Ok(home) = env::var("HOME") {
            // 1. Try reading QTerminal config (~/.config/qterminal.org/qterminal.ini)
            let qterm_path = Path::new(&home).join(".config/qterminal.org/qterminal.ini");
            if let Ok(contents) = std::fs::read_to_string(&qterm_path) {
                for line in contents.lines() {
                    let line = line.trim();
                    if let Some(val) = line.strip_prefix("fontFamily=") {
                        let trimmed = val.trim();
                        if !trimmed.is_empty() {
                            font_family =
                                format!("'{}', 'Fira Code', 'FiraCode', monospace", trimmed);
                        }
                    } else if let Some(val) = line.strip_prefix("colorScheme=") {
                        let trimmed = val.trim();
                        if trimmed.eq_ignore_ascii_case("Kali-Dark")
                            || trimmed.to_lowercase().contains("kali")
                        {
                            theme = "kali".to_string();
                        } else if trimmed.to_lowercase().contains("solarized")
                            && trimmed.to_lowercase().contains("light")
                        {
                            theme = "solarized-light".to_string();
                        } else if trimmed.to_lowercase().contains("solarized") {
                            theme = "solarized-dark".to_string();
                        } else if trimmed.to_lowercase().contains("dracula") {
                            theme = "dracula".to_string();
                        } else if trimmed.to_lowercase().contains("nord") {
                            theme = "nord".to_string();
                        } else if trimmed.to_lowercase().contains("one") {
                            theme = "one-dark".to_string();
                        }
                    } else if let Some(val) = line.strip_prefix("KeyboardCursorBlink=") {
                        cursor_blink = val.trim().eq_ignore_ascii_case("true");
                    } else if let Some(val) = line.strip_prefix("KeyboardCursorShape=") {
                        cursor_style = match val.trim() {
                            "1" => "underline".to_string(),
                            "2" => "bar".to_string(),
                            _ => "block".to_string(),
                        };
                    } else if let Some(val) = line.strip_prefix("TerminalTransparency=") {
                        if let Ok(trans) = val.trim().parse::<f64>() {
                            let op = 1.0 - (trans / 100.0);
                            opacity = (op * 100.0).round() / 100.0;
                            if opacity < 0.2 || opacity > 1.0 {
                                opacity = 1.0;
                            }
                        }
                    }
                }
            }

            // 2. Fallback to XFCE terminal config (~/.config/xfce4/terminal/terminalrc)
            let xfce_path = Path::new(&home).join(".config/xfce4/terminal/terminalrc");
            if let Ok(contents) = std::fs::read_to_string(&xfce_path) {
                for line in contents.lines() {
                    let line = line.trim();
                    if let Some(val) = line.strip_prefix("FontName=") {
                        let trimmed = val.trim();
                        if !trimmed.is_empty() {
                            let mut parts: Vec<&str> = trimmed.split_whitespace().collect();
                            if parts.len() > 1 && parts.last().unwrap().parse::<f64>().is_ok() {
                                parts.pop();
                            }
                            let family = parts.join(" ");
                            if !family.is_empty() {
                                font_family = format!("'{}', 'Fira Code', monospace", family);
                            }
                        }
                    }
                }
            }

            // 3. Fallback: check desktop monospace font via fc-match if not already set
            if !font_family.contains("FiraCode") && !font_family.contains("Fira Code") {
                if let Ok(output) = std::process::Command::new("fc-match")
                    .args(["monospace", "-f", "%{family}\n"])
                    .output()
                {
                    let out_str = String::from_utf8_lossy(&output.stdout);
                    let detected = out_str.trim();
                    if !detected.is_empty() {
                        font_family =
                            format!("'{}', 'Fira Code', 'DejaVu Sans Mono', monospace", detected);
                    }
                }
            }
        }

        (font_family, theme, cursor_blink, cursor_style, opacity)
    };

    #[cfg(target_os = "macos")]
    let (font_family, theme, cursor_blink, cursor_style, opacity) = (
        "Menlo, Monaco, 'Courier New', monospace".to_string(),
        // Must match the frontend DEFAULT_SETTINGS.theme ("Kali (Default)"):
        // the app applies host sync on top of an untouched default, so any
        // other value here silently unselects the default appearance on
        // fresh installs.
        "kali".to_string(),
        false,
        "block".to_string(),
        1.0f64,
    );

    #[cfg(target_os = "windows")]
    let (font_family, theme, cursor_blink, cursor_style, opacity) = (
        "Consolas, 'Cascadia Code', 'Lucida Console', monospace".to_string(),
        // Same contract as macOS above: keep the frontend default selected.
        "kali".to_string(),
        false,
        "block".to_string(),
        1.0f64,
    );

    SystemTerminalConfig {
        font_family,
        font_size,
        theme,
        cursor_blink,
        cursor_style,
        opacity,
        default_shell,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::{self, File};

    #[test]
    fn test_extract_search_html_with_multibyte_char_never_panics() {
        // Regression: a raw byte slice at a fixed offset panicked ("byte index
        // is not a char boundary") when YouTube's page carried raw non-ASCII
        // text — and with panic=abort the entire app closed. The extractor
        // must parse or bail, never panic.
        let html = concat!(
            r#"<script>ytInitialData = {"contents":[{"videoRenderer":{"videoId":"dQw4w9WgXcQ","#,
            r#"“title”":{"runs":[{"text":"Rick “Astley” — Never Gonna Give You Up ツ 🎤"}]}}]}"#,
        );
        // Must not panic regardless of where the multi-byte text falls.
        let _ = extract_videos_from_search_html(html, 8);
        let _ = extract_video_id_from_search_html(html);
        let _ = extract_videos_from_playlist_html(html, 8);
        // A videoId embedded before multi-byte bytes still parses when the
        // offsets stay on char boundaries.
        let clean = r#"{"videoRenderer":{"videoId":"dQw4w9WgXcQ","title":{"runs":[{"text":"Never Gonna Give You Up"}]}}}"#;
        let got = extract_videos_from_search_html(clean, 4);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].video_id, "dQw4w9WgXcQ");
        assert_eq!(got[0].title, "Never Gonna Give You Up");
    }

    #[test]
    fn test_extract_search_html_multibyte_inside_1500_byte_window() {
        // The title chunk slice spans 1500 bytes; a multi-byte char must not
        // cross its end boundary (previously panicked).
        let mut html =
            String::from(r#"{"videoRenderer":{"videoId":"dQw4w9WgXcQ","title":{"runs":[{"text":"#);
        html.push_str(&"в".repeat(800)); // Cyrillic, 2 bytes each
        html.push_str(r#"}}]}"#);
        let got = extract_videos_from_search_html(&html, 4);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].video_id, "dQw4w9WgXcQ");
    }

    #[test]
    fn test_encode_search_query_keeps_special_and_unicode_chars() {
        assert_eq!(encode_search_query("lofi hip hop"), "lofi+hip+hop");
        assert_eq!(encode_search_query("AC/DC"), "AC%2FDC");
        assert_eq!(encode_search_query("a & b"), "a+%26+b");
        assert_eq!(encode_search_query("çé ñ"), "%C3%A7%C3%A9+%C3%B1");
        assert_eq!(encode_search_query("#hash"), "%23hash");
        assert_eq!(
            encode_search_query("the-convenient_2.0~*"),
            "the-convenient_2.0~*"
        );
    }

    #[test]
    fn test_extract_playlist_html_multibyte_never_panics() {
        let html = concat!(
            r#"{"playlistVideoRenderer":{"videoId":"dQw4w9WgXcQ","#,
            r#""title":{"runs":[{"text":"Rick \u00c5stley"}]},"someé":"…"},"#,
        );
        let _ = extract_videos_from_playlist_html(html, 8);
        let clean = r#"{"playlistVideoRenderer":{"videoId":"jfKfPfyJRdk","title":{"runs":[{"text":"Lofi"}]}}}"#;
        let got = extract_videos_from_playlist_html(clean, 4);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].video_id, "jfKfPfyJRdk");
    }

    #[test]
    fn test_detect_available_shells() {
        let _env = crate::test_support::lock_test_env();
        let shells = detect_available_shells();
        assert!(!shells.is_empty(), "Should detect at least one shell");
        assert!(
            shells.iter().any(|s| s.is_default),
            "At least one shell should be marked default"
        );
    }

    #[test]
    fn test_shell_detection_cache_is_stable() {
        let _env = crate::test_support::lock_test_env();
        // Repeated spawns must not re-walk PATH/the filesystem every time.
        let first = detect_available_shells();
        let second = detect_available_shells();
        assert_eq!(first, second);
        let uncached = detect_available_shells_uncached();
        assert_eq!(first, uncached);
    }

    #[test]
    fn test_validate_and_resolve_shell_default() {
        let _env = crate::test_support::lock_test_env();
        let shell = validate_and_resolve_shell(None);
        assert!(shell.is_ok());
    }

    #[test]
    fn test_validate_and_resolve_shell_invalid_message() {
        let _env = crate::test_support::lock_test_env();
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
        let _env = crate::test_support::lock_test_env();
        assert!(validate_and_resolve_shell(Some("bad\0path")).is_err());
        assert!(validate_and_resolve_cwd(Some("bad\0dir")).is_err());
        assert!(validate_and_resolve_shell(Some(&"x".repeat(5000))).is_err());
    }

    #[test]
    fn test_validate_and_resolve_shell_with_spaces_in_path() {
        let _env = crate::test_support::lock_test_env();
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
        let _env = crate::test_support::lock_test_env();
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
    fn test_validate_cwd_nested_missing_resolves_to_existing_parent() {
        let _env = crate::test_support::lock_test_env();
        // Single-level fallback: "<existing-dir>/<missing-child>" resolves to
        // the existing parent, but a top-level miss must never resolve to "/".
        let dir = std::env::temp_dir();
        let parent = dir.join("kai_nested_probe_xyz_9999");
        let _ = fs::create_dir_all(&parent);
        let nested = parent.join("not_yet_created_child.tmp");
        let resolved = validate_and_resolve_cwd(Some(nested.to_str().unwrap()));
        let _ = fs::remove_dir_all(&parent);
        assert_eq!(resolved.unwrap(), parent.to_string_lossy().to_string());
    }

    #[test]
    fn test_custom_shell_profile_serialization() {
        let _env = crate::test_support::lock_test_env();
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
        let _env = crate::test_support::lock_test_env();
        assert!(open_in_editor(Some("/non_existent_editor_xyz_99"), "/tmp").is_err());
        assert!(open_in_editor(Some("invalid\0editor"), "/tmp").is_err());
        assert!(open_in_editor(Some(""), "/tmp").is_err());
    }

    /// Lays out `<root>/<install>/bin/{code, code.cmd}` the way VS Code does
    /// on Windows, plus the GUI exe at `exe_rel`.
    fn fake_editor_install(tag: &str, bin_rel: &str, exe_rel: &str) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!("kai_editor_{}_{}", tag, std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let bin = root.join(bin_rel);
        fs::create_dir_all(&bin).unwrap();
        File::create(bin.join("code")).unwrap();
        File::create(bin.join("code.cmd")).unwrap();
        let exe = root.join(exe_rel);
        fs::create_dir_all(exe.parent().unwrap()).unwrap();
        File::create(exe).unwrap();
        root
    }

    #[test]
    fn test_windows_launchable_path_prefers_cmd_over_bare_shim() {
        let root = fake_editor_install("shim", "bin", "Code.exe");
        let bare = root.join("bin").join("code");
        let fixed = windows_launchable_path(&bare.to_string_lossy());
        assert!(fixed.ends_with("code.cmd"), "got {fixed}");
        // Already-launchable and unknown paths are left untouched.
        let cmd = root
            .join("bin")
            .join("code.cmd")
            .to_string_lossy()
            .to_string();
        assert_eq!(windows_launchable_path(&cmd), cmd);
        let missing = root.join("bin").join("nope").to_string_lossy().to_string();
        assert_eq!(windows_launchable_path(&missing), missing);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn test_windows_gui_exe_found_for_vscode_and_cursor_layouts() {
        // VS Code: <root>\Code.exe next to <root>\bin\code.cmd
        let vs = fake_editor_install("vs", "bin", "Code.exe");
        let found = windows_gui_exe_for_shim(&vs.join("bin").join("code.cmd")).unwrap();
        assert!(found.ends_with("Code.exe"));
        let _ = fs::remove_dir_all(&vs);

        // Cursor: <root>\Cursor.exe, shim at <root>\resources\app\bin\cursor.cmd
        let cur = fake_editor_install("cur", "resources/app/bin", "Cursor.exe");
        let found = windows_gui_exe_for_shim(&cur.join("resources/app/bin/code.cmd")).unwrap();
        assert!(found.ends_with("Cursor.exe"));
        let _ = fs::remove_dir_all(&cur);
    }

    #[test]
    fn test_windows_gui_exe_none_without_known_editor_exe() {
        let root = fake_editor_install("none", "bin", "Unrelated.exe");
        assert!(windows_gui_exe_for_shim(&root.join("bin").join("code.cmd")).is_none());
        let _ = fs::remove_dir_all(&root);
    }

    /// Regression: PATH lookup must skip the extensionless bash shim that
    /// editors ship beside `code.cmd` — it cannot be spawned on Windows.
    #[cfg(target_os = "windows")]
    #[test]
    fn test_which_path_skips_extensionless_shim_on_windows() {
        let _env = crate::test_support::lock_test_env();
        let root = fake_editor_install("which", "bin", "Code.exe");
        let bin = root.join("bin");
        let old = env::var_os("PATH");
        env::set_var("PATH", &bin);
        let found = which_path("code");
        match old {
            Some(v) => env::set_var("PATH", v),
            None => env::remove_var("PATH"),
        }
        let _ = fs::remove_dir_all(&root);
        let found = found.expect("code.cmd should resolve");
        assert!(found.to_lowercase().ends_with("code.cmd"), "got {found}");
    }

    #[test]
    fn test_system_terminal_config_theme_is_a_known_id() {
        // The frontend applies host sync over an untouched default and the
        // Appearance panel only marks known ids selected: an unknown default
        // here would leave "no appearance selected" on fresh installs.
        // Must mirror `ThemeName` in src/types/terminal.ts.
        const KNOWN: &[&str] = &[
            "kali",
            "catppuccin-mocha",
            "one-dark",
            "dracula",
            "solarized-dark",
            "solarized-light",
            "nord",
            "tokyo-night",
        ];
        let cfg = detect_system_terminal_config();
        assert!(
            KNOWN.contains(&cfg.theme.as_str()),
            "unknown default theme from host sync: {}",
            cfg.theme
        );
        assert!(!cfg.font_family.trim().is_empty());
        // Fresh-install contract: Windows/macOS keep the frontend default.
        #[cfg(any(target_os = "windows", target_os = "macos"))]
        assert_eq!(cfg.theme, "kali");
    }

    #[test]
    fn test_scrub_chromium_env_removes_the_leaked_crashpad_pipe() {
        let mut c = std::process::Command::new("tool");
        c.env("CHROME_CRASHPAD_PIPE_NAME", "crashpad_1_X");
        scrub_chromium_env(&mut c);
        for key in LEAKED_CHROMIUM_ENV {
            assert!(
                c.get_envs().any(|(k, v)| k == *key && v.is_none()),
                "{key} must be explicitly removed from the child"
            );
        }
    }

    #[test]
    fn test_validate_external_url_allowlists_releases_only() {
        // Our own releases page and children pass (spawn is NOT tested here).
        assert!(validate_external_url(EXTERNAL_URL_FALLBACK).is_ok());
        assert!(validate_external_url(
            "https://github.com/surajthaqurie/kai-terminal/releases/tag/v0.1.3"
        )
        .is_ok());
        // Everything else is refused: other hosts, other repos, non-https,
        // whitespace/control smuggling, empty, oversized.
        assert!(validate_external_url("https://github.com/other/repo/releases").is_err());
        assert!(validate_external_url("https://example.com/").is_err());
        assert!(validate_external_url("http://github.com/surajthaqurie/kai-terminal/").is_err());
        assert!(validate_external_url("https://github.com/surajthaqurie/kai-terminal/ x").is_err());
        assert!(validate_external_url("").is_err());
    }

    #[test]
    fn test_validate_external_url_allows_only_the_azure_devops_token_page() {
        assert!(validate_external_url("https://dev.azure.com/").is_ok());
        assert!(
            validate_external_url("https://dev.azure.com/contoso/_usersSettings/tokens").is_ok()
        );
        for bad in [
            "https://dev.azure.com/contoso",
            "https://dev.azure.com/contoso/_usersSettings/tokens?x=1",
            "https://dev.azure.com//_usersSettings/tokens",
            "https://dev.azure.com/../_usersSettings/tokens",
            "https://dev.azure.com/a&calc/_usersSettings/tokens",
            "https://dev.azure.com/a/b/_usersSettings/tokens",
            "http://dev.azure.com/contoso/_usersSettings/tokens",
            "https://dev.azure.com.evil.com/contoso/_usersSettings/tokens",
        ] {
            assert!(validate_external_url(bad).is_err(), "should refuse {bad}");
        }
    }

    #[test]
    fn test_validate_external_url_allows_only_exact_youtube_shapes() {
        assert!(validate_external_url("https://www.youtube.com/watch?v=dQw4w9WgXcQ").is_ok());
        assert!(
            validate_external_url("https://www.youtube.com/playlist?list=PLabcdefghij").is_ok()
        );
        assert!(
            validate_external_url("https://www.youtube.com/results?search_query=lofi+beats")
                .is_ok()
        );
        // non-ASCII words are fine (no percent-encoding needed)
        assert!(
            validate_external_url("https://www.youtube.com/results?search_query=गीत+songs").is_ok()
        );
        // cmd metacharacters and extra params are refused
        for bad in [
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLabcdefghij",
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ&calc",
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ|calc",
            "https://www.youtube.com/results?search_query=a%20b",
            "https://www.youtube.com/results?search_query=a&b",
            "https://www.youtube.com/results?search_query=a^b",
            "https://www.youtube.com/results?search_query=a\"b",
            "https://www.youtube.com/results?search_query=",
            "https://www.youtube.com/watch?v=short",
            "https://www.youtube.com/playlist?list=x",
            "https://www.youtube.com/channel/abc",
            "https://www.youtube.com.evil.com/watch?v=dQw4w9WgXcQ",
            "https://music.youtube.com/watch?v=dQw4w9WgXcQ",
            "http://www.youtube.com/watch?v=dQw4w9WgXcQ",
        ] {
            assert!(validate_external_url(bad).is_err(), "should refuse {bad}");
        }
        assert!(validate_external_url(
            &"https://github.com/surajthaqurie/kai-terminal/a".repeat(20)
        )
        .is_err());
    }

    #[test]
    fn test_detect_installed_editors_never_fails_and_dedups() {
        let _env = crate::test_support::lock_test_env();
        // Must not panic on any OS — returns empty vec when nothing found.
        let editors = detect_installed_editors();
        let paths: Vec<String> = editors.iter().map(|e| e.path.clone()).collect();
        #[cfg(any(target_os = "windows", target_os = "macos"))]
        let paths: Vec<String> = paths.iter().map(|p| p.to_lowercase()).collect();
        let mut deduped = paths.clone();
        deduped.sort();
        deduped.dedup();
        assert_eq!(paths.len(), deduped.len(), "editor paths must be unique");
        for e in &editors {
            assert!(!e.id.is_empty() && !e.name.is_empty() && !e.binary.is_empty());
            assert!(!e.path.is_empty());
        }
    }

    #[test]
    fn test_validate_cwd_file_resolves_to_parent_dir() {
        let _env = crate::test_support::lock_test_env();
        // A file path must resolve to its containing directory on every OS
        // ("proper parent path" for pasted file paths).
        // Compare as `Path`s: `std::env::temp_dir()` may carry a trailing
        // separator (e.g. macOS `/var/.../T/`, Windows `...\Temp\`) while
        // `parent()` normalizes it away.
        let dir = std::env::temp_dir();
        let file = dir.join("kai_cwd_parent_probe.tmp");
        let _ = File::create(&file);
        let file_str = file.to_string_lossy().to_string();
        let resolved = validate_and_resolve_cwd(Some(&file_str));
        let _ = fs::remove_file(&file);
        assert_eq!(Path::new(&resolved.unwrap()), file.parent().unwrap());
    }

    #[test]
    fn test_windows_build_gate_accepts_supported_builds() {
        let _env = crate::test_support::lock_test_env();
        assert!(check_windows_build_supported(17763).is_ok());
        assert!(check_windows_build_supported(18362).is_ok());
        assert!(check_windows_build_supported(22631).is_ok());
    }

    #[test]
    fn test_windows_build_gate_rejects_legacy_builds_with_actionable_error() {
        let _env = crate::test_support::lock_test_env();
        for legacy in [10240u32, 14393, 15063, 16299, 17134] {
            let err = check_windows_build_supported(legacy).expect_err("legacy must fail");
            let msg = err.to_string();
            assert!(msg.contains("17763"), "must name minimum build: {}", msg);
            assert!(msg.contains("ConPTY"), "must mention ConPTY: {}", msg);
        }
    }

    #[test]
    fn test_wsl_shell_path_detection() {
        let _env = crate::test_support::lock_test_env();
        assert!(is_wsl_shell_path("wsl.exe"));
        assert!(is_wsl_shell_path("C:\\Windows\\System32\\wsl.exe"));
        // Forward-slash form (same binary, different separator style).
        assert!(is_wsl_shell_path("C:/Windows/System32/wsl.exe"));
        assert!(is_wsl_shell_path("WSL"));
        assert!(!is_wsl_shell_path("C:\\Windows\\System32\\cmd.exe"));
        assert!(!is_wsl_shell_path("/bin/bash"));
        // Exact file-name match only: wslhost/lxss siblings must not match.
        assert!(!is_wsl_shell_path("C:\\Windows\\System32\\wslhost.exe"));
        assert!(!is_wsl_shell_path("wslconfig.exe"));
        assert!(!wsl_failure_hint().is_empty());
    }

    #[test]
    fn test_detect_system_terminal_config() {
        let _env = crate::test_support::lock_test_env();
        let config = detect_system_terminal_config();
        assert_eq!(config.font_size, 12);
        assert!(!config.font_family.is_empty());
        assert!(!config.theme.is_empty());
        assert!(config.opacity >= 0.2 && config.opacity <= 1.0);
    }

    #[test]
    fn test_extract_video_id_from_search_html() {
        let sample = r#"{"responseContext":{},"contents":[{"item":{"videoId":"dQw4w9WgXcQ","title":"Test"}}]}"#;
        assert_eq!(
            extract_video_id_from_search_html(sample),
            Some("dQw4w9WgXcQ".to_string())
        );
        assert_eq!(extract_video_id_from_search_html("no matches here"), None);
        assert_eq!(
            extract_video_id_from_search_html(r#""videoId":"short""#),
            None
        );
    }

    #[test]
    fn test_extract_videos_from_playlist_html_keeps_order_and_dedups() {
        // Two playlist entries with titles, plus a repeat of the first video
        // id that must be dropped (first occurrence wins).
        let sample = concat!(
            "\"playlistVideoRenderer\":{\"videoId\":\"AAAAAAAAAAA\",\"thumbnail\":{},\"title\":{\"runs\":[{\"text\":\"First Song\"}]}}",
            "\"playlistVideoRenderer\":{\"videoId\":\"BBBBBBBBBBB\",\"thumbnail\":{},\"title\":{\"runs\":[{\"text\":\"Second Song\"}]}}",
            "\"playlistVideoRenderer\":{\"videoId\":\"AAAAAAAAAAA\",\"thumbnail\":{},\"title\":{\"runs\":[{\"text\":\"First Song\"}]}}",
        );
        let videos = extract_videos_from_playlist_html(sample, 10);
        assert_eq!(videos.len(), 2);
        assert_eq!(videos[0].video_id, "AAAAAAAAAAA");
        assert_eq!(videos[0].title, "First Song");
        assert_eq!(videos[1].video_id, "BBBBBBBBBBB");
        assert_eq!(videos[1].title, "Second Song");

        // limit is respected
        assert_eq!(extract_videos_from_playlist_html(sample, 1).len(), 1);
        // garbage ids (short) are skipped
        assert!(extract_videos_from_playlist_html(
            "\"playlistVideoRenderer\":{\"videoId\":\"ab\"",
            10
        )
        .is_empty());
    }
}
