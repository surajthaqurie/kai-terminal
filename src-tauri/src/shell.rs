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
/// On Windows, queries the current build number ONCE per process (cached in
/// a `OnceLock`) and rejects unsupported hosts with an actionable error
/// instead of a cryptic ConPTY failure. Caching matters: every PTY spawn
/// previously ran `cmd /c ver` synchronously, adding seconds to session open.
/// On Unix/macOS this is a no-op (native `openpty` is always present).
pub fn check_host_pty_support() -> Result<(), TerminalError> {
    #[cfg(target_os = "windows")]
    {
        use std::sync::OnceLock;
        static BUILD_CACHE: OnceLock<Option<u32>> = OnceLock::new();
        let build = *BUILD_CACHE.get_or_init(current_windows_build);
        match build {
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
                let parent = p.parent();
                if let Some(par) = parent {
                    let parent_str = par.to_string_lossy().to_string();
                    if !parent_str.is_empty() && Path::new(&parent_str).is_dir() {
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
        ("neovim", "Neovim", vec!["nvim"]),
        ("vim", "Vim", vec!["vim", "vi"]),
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
pub fn detect_installed_editors() -> Vec<EditorInfo> {
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
        if seen_paths.iter().any(|s| *s == canon) {
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
                    format!("{}\\Microsoft VS Code\\Code.exe", pf),
                    format!("{}\\Microsoft VS Code\\bin\\code.cmd", pf),
                ],
                "cursor" => vec![format!("{}\\Cursor\\Cursor.exe", local)],
                "sublime" => vec![
                    format!("{}\\Sublime Text\\sublime_text.exe", pf),
                    format!("{}\\Sublime Text\\sublime_text.exe", pf86),
                ],
                "zed" => vec![format!("{}\\Zed\\zed.exe", pf)],
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
                "sublime" => vec!["/usr/bin/subl".into(), "/opt/sublime_text/sublime_text".into()],
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
/// Never uses shell string interpolation; argv arrays only.
pub fn open_in_editor(requested_editor: Option<&str>, cwd: &str) -> Result<String, TerminalError> {
    let valid_cwd = validate_and_resolve_cwd(Some(cwd))?;

    // Flattened alias order from `editor_candidates` — single source of
    // truth for auto-detect priority on every OS.
    let candidate_editors = [
        "code", "cursor", "windsurf", "codium", "vscodium", "subl", "sublime_text", "zed",
        "nvim", "vim", "vi", "atom", "idea", "fleet", "webstorm", "clion",
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

    // Cross-platform spawn (argv arrays only, no shell interpolation):
    #[cfg(target_os = "windows")]
    {
        if is_windows_script_shim(&editor_bin) {
            std::process::Command::new("cmd")
                .args(["/c", &editor_bin, &valid_cwd])
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
    std::process::Command::new(&editor_bin)
        .arg(&valid_cwd)
        .spawn()
        .map_err(|e| {
            TerminalError::IoError(format!("Failed to launch editor '{}': {}", editor_bin, e))
        })?;

    Ok(editor_bin)
}

/// Returns true for Windows script shims that `CreateProcess` cannot run
/// directly (`.cmd`, `.bat`, `.ps1` — e.g. VS Code's `code.cmd` on PATH).
#[cfg(target_os = "windows")]
fn is_windows_script_shim(path: &str) -> bool {
    let lower = path.to_lowercase();
    lower.ends_with(".cmd") || lower.ends_with(".bat") || lower.ends_with(".ps1")
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
    fn test_detect_installed_editors_never_fails_and_dedups() {
        // Must not panic on any OS — returns empty vec when nothing found.
        let editors = detect_installed_editors();
        let mut paths: Vec<String> = editors.iter().map(|e| e.path.clone()).collect();
        #[cfg(any(target_os = "windows", target_os = "macos"))]
        {
            paths = paths.iter().map(|p| p.to_lowercase()).collect();
        }
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
        // A file path must resolve to its containing directory on every OS
        // ("proper parent path" for pasted file paths).
        let dir = std::env::temp_dir();
        let file = dir.join("kai_cwd_parent_probe.tmp");
        let _ = File::create(&file);
        let file_str = file.to_string_lossy().to_string();
        let resolved = validate_and_resolve_cwd(Some(&file_str));
        let _ = fs::remove_file(&file);
        assert_eq!(resolved.unwrap(), dir.to_string_lossy().to_string());
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
