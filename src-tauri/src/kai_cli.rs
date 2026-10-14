//! Bundled `kai` CLI first-run installer.
//!
//! Problem: the desktop `.exe`/`.msi` installer ships the terminal UI only,
//! so typing `kai` in any terminal afterwards fails with
//! `kai: command not found`. The npm path (`npm run setup:cli`) fixes PATH,
//! but installer-only users on Windows never run it.
//!
//! Fix: the app carries its own CLI bundle (`dist/cli/index.js`, declared in
//! `tauri.conf.json > bundle > resources`) and, on every startup, ensures a
//! user-level `kai` launcher exists plus that its directory is on the
//! persistent per-user PATH:
//! - Windows: `%USERPROFILE%\.kai\bin\kai.cmd` (+ `kai.ps1`), User PATH
//!   registry entry via PowerShell, `WM_SETTINGCHANGE` broadcast.
//! - Linux/macOS: `~/.local/bin/kai` shim, marked line in shell rc files.
//!
//! Idempotent, never touches system dirs (no admin), never blocks startup
//! (callers must run it on a background thread), and never panics (release
//! builds use `panic = "abort"`).
//!
//! The launcher still needs Node.js 20+ at *call* time; when Node is missing
//! the shim prints where to get it instead of failing cryptically.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
#[cfg(target_os = "windows")]
use std::time::{Duration, Instant};

/// Status of the bundled CLI install, surfaced to the frontend.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct KaiCliStatus {
    pub installed: bool,
    pub bin_dir: String,
    pub shim_path: String,
    pub on_path: bool,
    pub node_found: bool,
    pub resource_found: bool,
    pub message: String,
}

/// User-level bin directory holding the `kai` launcher.
pub fn kai_bin_dir() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        let base = std::env::var("USERPROFILE")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("."));
        base.join(".kai").join("bin")
    }
    #[cfg(not(target_os = "windows"))]
    {
        if let Ok(home) = std::env::var("HOME") {
            if !home.trim().is_empty() {
                return PathBuf::from(home).join(".local").join("bin");
            }
        }
        PathBuf::from(".")
    }
}

/// Candidate layouts of the bundled CLI inside the Tauri resource dir.
///
/// `..`-relative resource entries are stored by Tauri with an `_up_` prefix
/// (v1 behaviour kept in v2), while plain entries keep their relative path,
/// so every plausible layout is probed instead of assuming one.
pub fn find_bundled_cli(resource_dir: &Path) -> Option<PathBuf> {
    const CANDIDATES: &[&str] = &[
        "dist/cli/index.js",
        "_up_/dist/cli/index.js",
        "_up_/_up_/dist/cli/index.js",
        "cli/index.js",
        "index.js",
    ];
    for rel in CANDIDATES {
        let p = resource_dir.join(rel);
        if is_file(&p) {
            return Some(p);
        }
    }
    None
}

fn is_file(p: &Path) -> bool {
    std::fs::metadata(p).map(|m| m.is_file()).unwrap_or(false)
}

/// Well-known Node.js locations probed when `PATH` misses (desktop GUI
/// launches inherit a minimal PATH).
fn node_search_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    #[cfg(target_os = "windows")]
    {
        for key in ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"] {
            if let Ok(base) = std::env::var(key) {
                if !base.trim().is_empty() {
                    dirs.push(PathBuf::from(base).join("nodejs"));
                }
            }
        }
        if let Ok(pf) = std::env::var("ProgramFiles") {
            if !pf.trim().is_empty() {
                dirs.push(PathBuf::from(pf).join("node"));
            }
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        for abs in ["/usr/local/bin", "/opt/homebrew/bin", "/opt/local/bin"] {
            dirs.push(PathBuf::from(abs));
        }
        if let Ok(home) = std::env::var("HOME") {
            if !home.trim().is_empty() {
                let h = PathBuf::from(home);
                dirs.push(h.join(".nvm/versions/node"));
                for rel in [".local/bin", ".volta/bin", ".fnm/node-versions"] {
                    dirs.push(h.join(rel));
                }
            }
        }
    }
    dirs
}

/// Resolve a `node` executable: live `PATH` first, then well-known spots.
pub fn find_node_exe() -> Option<String> {
    if let Some(p) = find_on_path("node") {
        return Some(p);
    }
    #[cfg(target_os = "windows")]
    {
        for dir in node_search_dirs() {
            let c = dir.join("node.exe");
            if is_file(&c) {
                return Some(c.to_string_lossy().to_string());
            }
        }
        None
    }
    #[cfg(not(target_os = "windows"))]
    {
        for dir in node_search_dirs() {
            let c = dir.join("node");
            if is_file(&c) {
                return Some(c.to_string_lossy().to_string());
            }
        }
        None
    }
}

fn find_on_path(cmd: &str) -> Option<String> {
    let path_env = std::env::var("PATH").unwrap_or_default();
    for dir in std::env::split_paths(&path_env) {
        if dir.as_os_str().is_empty() {
            continue;
        }
        #[cfg(target_os = "windows")]
        {
            let lower = cmd.to_lowercase();
            // Exact match first (covers `kai.cmd`-style callers passing ext).
            let exact = dir.join(cmd);
            if is_file(&exact) {
                return Some(exact.to_string_lossy().to_string());
            }
            if !lower.ends_with(".exe") && !lower.ends_with(".cmd") && !lower.ends_with(".bat") {
                for ext in [".exe", ".cmd", ".bat"] {
                    let c = dir.join(format!("{cmd}{ext}"));
                    if is_file(&c) {
                        return Some(c.to_string_lossy().to_string());
                    }
                }
            }
        }
        #[cfg(not(target_os = "windows"))]
        {
            let c = dir.join(cmd);
            if is_file(&c) {
                return Some(c.to_string_lossy().to_string());
            }
        }
    }
    None
}

/// `kai.cmd` shim body. `node_exe` may be a full path or bare `node` (PATH
/// lookup at call time, so installing Node later just works).
pub fn build_cmd_shim(node_exe: &str, cli_js: &Path) -> String {
    let node = if node_exe.contains(' ') && !node_exe.starts_with('"') {
        format!("\"{node_exe}\"")
    } else {
        node_exe.to_string()
    };
    format!(
        "@echo off\r\n{node} \"{}\" %*\r\n",
        cli_js.to_string_lossy()
    )
}

/// `kai.ps1` shim body (PowerShell callers).
pub fn build_ps1_shim(node_exe: &str, cli_js: &Path) -> String {
    format!(
        "& {} \"{}\" @args\r\nexit $LASTEXITCODE\r\n",
        node_exe,
        cli_js.to_string_lossy()
    )
}

/// POSIX `kai` shim body.
pub fn build_sh_shim(node_exe: &str, cli_js: &Path) -> String {
    format!(
        "#!/bin/sh\nexec {} \"{}\" \"$@\"\n",
        node_exe,
        cli_js.to_string_lossy()
    )
}

/// True when `dir` is already an entry of a PATH-style variable value.
pub fn path_contains_dir(path_var: &str, dir: &str) -> bool {
    let needle = dir.trim().trim_end_matches(['/', '\\']).to_lowercase();
    if needle.is_empty() {
        return false;
    }
    for sep in [';', ':'] {
        for entry in path_var.split(sep) {
            let e = entry.trim().trim_end_matches(['/', '\\']).to_lowercase();
            if e == needle {
                return true;
            }
        }
    }
    false
}

/// Append `dir` to a PATH-style value (idempotent).
pub fn append_dir_to_path_var(path_var: &str, dir: &str) -> String {
    if path_var.trim().is_empty() {
        return dir.to_string();
    }
    if path_contains_dir(path_var, dir) {
        return path_var.to_string();
    }
    #[cfg(target_os = "windows")]
    let sep = ';';
    #[cfg(not(target_os = "windows"))]
    let sep = ':';
    format!("{}{sep}{dir}", path_var.trim_end_matches(sep))
}

/// Current-process PATH check (shells spawned later inherit this process).
pub fn current_process_path_contains(dir: &Path) -> bool {
    let cur = std::env::var("PATH").unwrap_or_default();
    path_contains_dir(&cur, &dir.to_string_lossy())
}

/// Prepend `dir` to this process's PATH so PTY children spawned after
/// startup resolve `kai` even before the user restarts the terminal.
pub fn prepend_current_process_path(dir: &Path) {
    if current_process_path_contains(dir) {
        return;
    }
    let cur = std::env::var("PATH").unwrap_or_default();
    let dir_s = dir.to_string_lossy().to_string();
    #[cfg(target_os = "windows")]
    let next = if cur.trim().is_empty() {
        dir_s
    } else {
        format!("{dir_s};{cur}")
    };
    #[cfg(not(target_os = "windows"))]
    let next = if cur.trim().is_empty() {
        dir_s
    } else {
        format!("{dir_s}:{cur}")
    };
    std::env::set_var("PATH", next);
}

#[cfg(target_os = "windows")]
fn powershell_exe() -> &'static str {
    "powershell"
}

/// Run a PowerShell snippet with a hard timeout. Returns trimmed stdout, or
/// `None` when PowerShell is missing, blocked, or hung — callers degrade to
/// manual instructions instead of freezing startup. Uses inbox Windows
/// PowerShell (always present); no `pwsh` dependency.
#[cfg(target_os = "windows")]
fn run_powershell(script: &str, timeout: Duration) -> Option<String> {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    // Probing for pwsh first doubles cold-start cost; a single `powershell`
    // call with a bounded wait is enough on a background thread.
    let mut child = Command::new(powershell_exe())
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .ok()?;
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(_) => return None,
        }
    }
    let out = child.wait_with_output().ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

#[cfg(target_os = "windows")]
fn escape_ps_single(s: &str) -> String {
    s.replace('\'', "''")
}

/// Persistent per-user PATH check (registry), not just this process.
#[cfg(target_os = "windows")]
fn persisted_user_path_contains(dir: &str) -> bool {
    match run_powershell(
        "[Environment]::GetEnvironmentVariable('Path','User')",
        Duration::from_secs(15),
    ) {
        Some(v) => path_contains_dir(&v, dir),
        None => current_process_path_contains(Path::new(dir)),
    }
}

/// Append `dir` to the persistent User PATH. Returns true when the value
/// changed (caller should tell the user to restart the terminal).
#[cfg(target_os = "windows")]
fn ensure_persisted_user_path(dir: &str) -> bool {
    if persisted_user_path_contains(dir) {
        return false;
    }
    let safe = escape_ps_single(dir);
    let script = format!(
        "$p=[Environment]::GetEnvironmentVariable('Path','User');\
         if(($p -split ';') -notcontains '{safe}'){{\
         [Environment]::SetEnvironmentVariable('Path',($p.TrimEnd(';')+';{safe}'),'User');'CHANGED'}}\
         else{{'PRESENT'}}"
    );
    match run_powershell(&script, Duration::from_secs(20)) {
        Some(out) => out.contains("CHANGED"),
        None => false,
    }
}

/// Best-effort `WM_SETTINGCHANGE` broadcast so new terminals pick up the
/// PATH without a reboot. Failures are silent by design.
#[cfg(target_os = "windows")]
fn broadcast_env_change() {
    let script = "Add-Type -Namespace Win32 -Name Env -MemberDefinition \
        '[DllImport(\"user32.dll\", SetLastError=$true, CharSet=CharSet.Auto)] \
         public static extern IntPtr SendMessageTimeout( \
         IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, \
         uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);' | Out-Null; \
         [UIntPtr]$r = 0; \
         [Win32.Env]::SendMessageTimeout([IntPtr]0xffff, 0x1a, \
         [UIntPtr]::Zero, 'Environment', 0x0002, 5000, [ref]$r) | Out-Null";
    let _ = run_powershell(script, Duration::from_secs(20));
}

#[cfg(not(target_os = "windows"))]
const KAI_RC_MARK: &str = "# kai-terminal: kai CLI on PATH";

/// Append `~/.local/bin` to shell rc files (idempotent). Returns true when a
/// terminal restart is needed to pick it up.
#[cfg(not(target_os = "windows"))]
fn ensure_rc_path(dir: &Path) -> bool {
    let home = match std::env::var("HOME") {
        Ok(h) if !h.trim().is_empty() => PathBuf::from(h),
        _ => return false,
    };
    let line = "export PATH=\"$HOME/.local/bin:$PATH\"";
    let shell = std::env::var("SHELL").unwrap_or_default().to_lowercase();
    let targets: Vec<PathBuf> = if shell.contains("fish") {
        vec![home.join(".config").join("fish").join("config.fish")]
    } else {
        vec![
            home.join(".bashrc"),
            home.join(".zshrc"),
            home.join(".profile"),
        ]
    };
    for rc in &targets {
        let cur = std::fs::read_to_string(rc).unwrap_or_default();
        if cur.contains(KAI_RC_MARK) || cur.contains("$HOME/.local/bin") {
            continue;
        }
        let block = if rc.ends_with("config.fish") {
            format!("\n{KAI_RC_MARK}\nfish_add_path ~/.local/bin\n")
        } else {
            format!("\n{KAI_RC_MARK}\n{line}\n")
        };
        if let Some(parent) = rc.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(rc)
            .and_then(|mut f| {
                use std::io::Write;
                f.write_all(block.as_bytes())
            })
            .is_err()
        {
            // Unwritable rc file: fall through to the restart hint.
        }
    }
    !current_process_path_contains(dir)
}

fn write_file(path: &Path, content: &str) -> bool {
    if let Some(parent) = path.parent() {
        if std::fs::create_dir_all(parent).is_err() {
            return false;
        }
    }
    // Skip the write when the content is already current (keeps mtime
    // stable across restarts).
    if let Ok(cur) = std::fs::read_to_string(path) {
        if cur == content {
            return true;
        }
    }
    std::fs::write(path, content).is_ok()
}

/// Install the launcher shims for a bundled CLI file. Returns the primary
/// shim path on success.
pub fn install_shims(cli_js: &Path) -> Option<PathBuf> {
    let bin_dir = kai_bin_dir();
    if std::fs::create_dir_all(&bin_dir).is_err() {
        return None;
    }
    let node = find_node_exe().unwrap_or_else(|| "node".to_string());
    #[cfg(target_os = "windows")]
    {
        let cmd_path = bin_dir.join("kai.cmd");
        let ps1_path = bin_dir.join("kai.ps1");
        if !write_file(&cmd_path, &build_cmd_shim(&node, cli_js)) {
            return None;
        }
        let _ = write_file(&ps1_path, &build_ps1_shim(&node, cli_js));
        Some(cmd_path)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let link = bin_dir.join("kai");
        if !write_file(&link, &build_sh_shim(&node, cli_js)) {
            return None;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&link, std::fs::Permissions::from_mode(0o755));
        }
        Some(link)
    }
}

/// Full first-run repair given an optional Tauri resource directory.
///
/// Never panics, never blocks longer than the bounded PowerShell probes
/// (callers still run it off the UI thread).
pub fn ensure_kai_cli(resource_dir: Option<PathBuf>) -> KaiCliStatus {
    let bin_dir = kai_bin_dir();
    let bin_s = bin_dir.to_string_lossy().to_string();
    let node = find_node_exe();
    let bundled = resource_dir.as_deref().and_then(find_bundled_cli);

    let mut message: String;
    let mut shim_path = bin_dir.join(if cfg!(target_os = "windows") {
        "kai.cmd"
    } else {
        "kai"
    });

    match bundled {
        Some(cli_js) => {
            let resource_found = true;
            match install_shims(&cli_js) {
                Some(p) => {
                    shim_path = p;
                    message = format!(
                        "kai CLI launcher installed at {}",
                        shim_path.to_string_lossy()
                    );
                }
                None => {
                    message = format!("Could not write kai launcher into {bin_s}.");
                    return KaiCliStatus {
                        installed: false,
                        bin_dir: bin_s,
                        shim_path: shim_path.to_string_lossy().to_string(),
                        on_path: current_process_path_contains(&bin_dir),
                        node_found: node.is_some(),
                        resource_found,
                        message,
                    };
                }
            }
            // Persistent PATH (registry / rc files) + this process.
            #[cfg(target_os = "windows")]
            {
                let changed = ensure_persisted_user_path(&bin_s);
                prepend_current_process_path(&bin_dir);
                if changed {
                    broadcast_env_change();
                    message.push_str(
                        "; added to user PATH — restart the terminal, then run: kai --version",
                    );
                }
            }
            #[cfg(not(target_os = "windows"))]
            {
                let restart = ensure_rc_path(&bin_dir);
                prepend_current_process_path(&bin_dir);
                if restart {
                    message.push_str(
                        "; added to PATH — restart the terminal, then run: kai --version",
                    );
                }
            }
            if node.is_none() {
                message.push_str(
                    " (Node.js 20+ not detected — install Node LTS from https://nodejs.org so the launcher can run.)",
                );
            }
            KaiCliStatus {
                installed: true,
                bin_dir: bin_s,
                shim_path: shim_path.to_string_lossy().to_string(),
                on_path: current_process_path_contains(&bin_dir),
                node_found: node.is_some(),
                resource_found,
                message,
            }
        }
        None => {
            // No bundled CLI (dev checkout without `npm run build:cli`):
            // leave any npm-installed shim alone and just report.
            message =
                "Bundled kai CLI not found (run `npm run build:cli` in dev checkouts).".to_string();
            if is_file(&shim_path) {
                message.push_str(" An existing launcher is already present.");
                KaiCliStatus {
                    installed: true,
                    bin_dir: bin_s,
                    shim_path: shim_path.to_string_lossy().to_string(),
                    on_path: current_process_path_contains(&bin_dir),
                    node_found: node.is_some(),
                    resource_found: false,
                    message,
                }
            } else {
                message.push_str(
                    " Install Node.js 20+ and run `npm run setup:cli`, then restart the terminal.",
                );
                KaiCliStatus {
                    installed: false,
                    bin_dir: bin_s,
                    shim_path: shim_path.to_string_lossy().to_string(),
                    on_path: false,
                    node_found: node.is_some(),
                    resource_found: false,
                    message,
                }
            }
        }
    }
}

/// Tauri command: report bundled-CLI status (writes nothing).
#[cfg(feature = "tauri")]
#[tauri::command]
pub fn get_kai_cli_status_cmd(app: tauri::AppHandle) -> KaiCliStatus {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|_| ())
        .and_then(|d| if d.is_dir() { Ok(d) } else { Err(()) })
        .ok();
    let bin_dir = kai_bin_dir();
    let shim = bin_dir.join(if cfg!(target_os = "windows") {
        "kai.cmd"
    } else {
        "kai"
    });
    let resource_found = resource_dir.as_deref().and_then(find_bundled_cli).is_some();
    KaiCliStatus {
        installed: is_file(&shim),
        bin_dir: bin_dir.to_string_lossy().to_string(),
        shim_path: shim.to_string_lossy().to_string(),
        on_path: current_process_path_contains(&bin_dir),
        node_found: find_node_exe().is_some(),
        resource_found,
        message: if is_file(&shim) {
            "kai launcher present.".to_string()
        } else {
            "kai launcher missing — run the installer repair.".to_string()
        },
    }
}

/// Tauri command: run the first-run repair (idempotent).
#[cfg(feature = "tauri")]
#[tauri::command]
pub fn ensure_kai_cli_cmd(app: tauri::AppHandle) -> KaiCliStatus {
    let resource_dir = app.path().resource_dir().ok();
    ensure_kai_cli(resource_dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_path_contains_matches_whole_entries_only() {
        assert!(path_contains_dir("C:\\a\\b;C:\\c", "c:\\A\\B"));
        assert!(path_contains_dir("C:\\a\\b;C:\\c", "C:\\c"));
        // Bare prefix must NOT match.
        assert!(!path_contains_dir("C:\\a\\bc;C:\\c", "C:\\a\\b"));
        assert!(!path_contains_dir("", "C:\\a"));
        assert!(!path_contains_dir("C:\\a", ""));
        // Unix-style separator also handled.
        assert!(path_contains_dir("/a/b:/c", "/a/b"));
        assert!(!path_contains_dir("/a/bc:/c", "/a/b"));
    }

    #[test]
    fn test_append_is_idempotent_and_handles_empty() {
        // PATH entries are platform-native: drive-letter paths contain a
        // colon, which is the Unix separator, so cross-style inputs would
        // be ambiguous there. Each platform tests its own shape.
        #[cfg(target_os = "windows")]
        let (existing, add) = ("C:\\a", "C:\\x");
        #[cfg(not(target_os = "windows"))]
        let (existing, add) = ("/opt/a", "/opt/x");
        assert_eq!(append_dir_to_path_var("", add), add);
        let once = append_dir_to_path_var(existing, add);
        assert!(path_contains_dir(&once, add));
        let twice = append_dir_to_path_var(&once, add);
        assert_eq!(once, twice);
    }

    #[test]
    fn test_cmd_shim_delegates_all_args() {
        let s = build_cmd_shim("node", Path::new("C:\\app\\cli\\index.js"));
        assert!(s.contains("node"));
        assert!(s.contains("index.js"));
        assert!(s.contains("%*"));
    }

    #[test]
    fn test_cmd_shim_quotes_spaced_node() {
        let s = build_cmd_shim(
            "C:\\Program Files\\nodejs\\node.exe",
            Path::new("C:\\app\\index.js"),
        );
        assert!(s.contains("\"C:\\Program Files\\nodejs\\node.exe\""));
    }

    #[test]
    fn test_ps1_shim_propagates_exit_code() {
        let s = build_ps1_shim("node", Path::new("C:\\app\\index.js"));
        assert!(s.contains("@args"));
        assert!(s.contains("$LASTEXITCODE"));
    }

    #[test]
    fn test_sh_shim_is_executable_script() {
        let s = build_sh_shim("/usr/bin/node", Path::new("/app/cli/index.js"));
        assert!(s.starts_with("#!/bin/sh"));
        assert!(s.contains("\"$@\""));
    }

    #[test]
    fn test_find_bundled_cli_probes_layouts() {
        let base = std::env::temp_dir().join(format!("kai-cli-res-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        assert!(find_bundled_cli(&base).is_none());
        let nested = base.join("dist").join("cli");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(nested.join("index.js"), "cli").unwrap();
        let found = find_bundled_cli(&base).expect("layout dist/cli/index.js");
        assert!(found.ends_with("index.js"));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn test_ensure_without_resource_never_panics() {
        let missing = std::env::temp_dir().join(format!("kai-cli-nores-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&missing);
        let _ = std::fs::create_dir_all(&missing);
        let st = ensure_kai_cli(Some(missing.clone()));
        assert!(!st.resource_found);
        assert!(!st.message.is_empty());
        let _ = std::fs::remove_dir_all(&missing);
    }
}
