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
//! The launcher needs Node.js 20+ at *call* time. Release builds ship their own
//! Node.js (see [`register_bundled_node`]) and use it first; a build without one
//! falls back to the Node on `PATH`, and when that is missing the shim prints
//! where to get it instead of failing cryptically.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
#[cfg(feature = "tauri")]
use tauri::Manager;

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

/// Node.js binary shipped inside release builds of the app (`scripts/fetch-node.mjs`
/// puts it in `src-tauri/resources/node/` and `tauri.bundled-node.conf.json` adds it
/// to the bundle's resources). Dev checkouts and source builds do not have one.
static BUNDLED_NODE: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

/// Where the bundled Node.js sits inside the Tauri resource dir, probing the
/// layouts Tauri may use (see [`find_bundled_cli`] for why several).
pub fn find_bundled_node(resource_dir: &Path) -> Option<PathBuf> {
    let exe = if cfg!(target_os = "windows") {
        "node.exe"
    } else {
        "node"
    };
    for rel in ["resources/node", "_up_/resources/node", "node"] {
        let p = resource_dir.join(rel).join(exe);
        if is_file(&p) {
            return Some(p);
        }
    }
    None
}

/// Remembers the app's bundled Node.js (when it ships one) so that
/// [`find_node_exe`] prefers it: the CLI is built for that exact version, and a
/// machine without Node needs no install. Returns whether one was found.
pub fn register_bundled_node(resource_dir: &Path) -> bool {
    match find_bundled_node(resource_dir) {
        Some(p) => BUNDLED_NODE.set(p).is_ok() || BUNDLED_NODE.get().is_some(),
        None => false,
    }
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

/// Resolve a `node` executable: the app's bundled one, then live `PATH`, then
/// well-known spots.
pub fn find_node_exe() -> Option<String> {
    if let Some(p) = BUNDLED_NODE.get().filter(|p| is_file(p)) {
        return Some(p.to_string_lossy().to_string());
    }
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

/// PowerShell single-quoted literal (`'` is doubled; nothing is expanded).
fn ps_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/// POSIX single-quoted literal (`'` becomes `'\''`; nothing is expanded).
fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// `kai.ps1` shim body (PowerShell callers). Paths are quoted: the standard
/// Node location is `C:\Program Files\nodejs\node.exe`, which an unquoted
/// `& C:\Program Files\...` would split at the space.
pub fn build_ps1_shim(node_exe: &str, cli_js: &Path) -> String {
    format!(
        "& {} {} @args\r\nexit $LASTEXITCODE\r\n",
        ps_quote(node_exe),
        ps_quote(&cli_js.to_string_lossy())
    )
}

/// POSIX `kai` shim body (paths quoted for homes like `/Users/John Smith/...`).
pub fn build_sh_shim(node_exe: &str, cli_js: &Path) -> String {
    format!(
        "#!/bin/sh\nexec {} {} \"$@\"\n",
        sh_quote(node_exe),
        sh_quote(&cli_js.to_string_lossy())
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

/// Directories added to the PATH of shells this app starts after startup
/// (Unix). They are recorded here and handed to each child's own environment
/// (`spawn_path_with_extras`) rather than written into this process's
/// environment: `setenv` from a background thread races with `getenv` in the
/// threads WebKitGTK/GLib and process spawning run, which is undefined behaviour.
#[cfg(not(target_os = "windows"))]
static EXTRA_PATH_DIRS: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());

#[cfg(not(target_os = "windows"))]
fn extra_path_dirs() -> Vec<String> {
    EXTRA_PATH_DIRS
        .lock()
        .map(|dirs| dirs.clone())
        .unwrap_or_default()
}

/// `current` with every entry of `extras` that it lacks put in front, in order.
pub fn path_with_extra_dirs(current: &str, extras: &[String]) -> String {
    let mut out = current.to_string();
    for dir in extras.iter().rev() {
        if !path_contains_dir(&out, dir) {
            out = if out.trim().is_empty() {
                dir.clone()
            } else {
                format!("{dir}:{out}")
            };
        }
    }
    out
}

/// The `PATH` a shell started now should get on Unix: this process's `PATH` plus
/// the directories recorded by [`prepend_current_process_path`]. `None` when
/// nothing was recorded (the child then simply inherits the environment) and
/// always `None` on Windows, where the process environment is updated directly.
#[cfg(not(target_os = "windows"))]
pub fn spawn_path_with_extras() -> Option<String> {
    let extras = extra_path_dirs();
    if extras.is_empty() {
        return None;
    }
    let current = std::env::var("PATH").unwrap_or_default();
    Some(path_with_extra_dirs(&current, &extras))
}

#[cfg(target_os = "windows")]
pub fn spawn_path_with_extras() -> Option<String> {
    None
}

/// Current-process PATH check (shells spawned later inherit this process).
pub fn current_process_path_contains(dir: &Path) -> bool {
    let cur = std::env::var("PATH").unwrap_or_default();
    if path_contains_dir(&cur, &dir.to_string_lossy()) {
        return true;
    }
    #[cfg(not(target_os = "windows"))]
    {
        let wanted = dir.to_string_lossy();
        if extra_path_dirs()
            .iter()
            .any(|d| path_contains_dir(d, &wanted))
        {
            return true;
        }
    }
    false
}

/// Make `kai` resolvable in PTY children spawned after startup, even before the
/// user restarts the terminal. Windows updates this process's PATH (its
/// environment API is thread-safe); Unix only records `dir`, which `create_pty`
/// then adds to each child's PATH (see [`spawn_path_with_extras`]).
pub fn prepend_current_process_path(dir: &Path) {
    if current_process_path_contains(dir) {
        return;
    }
    #[cfg(not(target_os = "windows"))]
    {
        if let Ok(mut dirs) = EXTRA_PATH_DIRS.lock() {
            dirs.push(dir.to_string_lossy().to_string());
        }
    }
    #[cfg(target_os = "windows")]
    {
        set_windows_process_path(dir);
    }
}

#[cfg(target_os = "windows")]
fn set_windows_process_path(dir: &Path) {
    let cur = std::env::var("PATH").unwrap_or_default();
    let dir_s = dir.to_string_lossy().to_string();
    let next = if cur.trim().is_empty() {
        dir_s
    } else {
        format!("{dir_s};{cur}")
    };
    std::env::set_var("PATH", next);
}

/// The persistent per-user PATH exactly as stored (`HKCU\Environment\Path`, variable
/// references such as `%USERPROFILE%` left unexpanded), read straight from the registry.
/// `Some("")` when the user has no PATH value yet; `None` when it cannot be read.
///
/// Reading it through a PowerShell child instead (what this used to do, on EVERY launch)
/// cost a cold PowerShell start of hundreds of milliseconds of CPU, during the window in
/// which the app avoids child processes because they are a classic "Not Responding on
/// launch" trigger. A registry read costs microseconds.
#[cfg(target_os = "windows")]
pub fn read_user_path_registry() -> Option<String> {
    use windows_sys::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_MORE_DATA, ERROR_SUCCESS};
    use windows_sys::Win32::System::Registry::{
        RegGetValueW, HKEY_CURRENT_USER, RRF_NOEXPAND, RRF_RT_REG_EXPAND_SZ, RRF_RT_REG_SZ,
    };

    let subkey: Vec<u16> = "Environment\0".encode_utf16().collect();
    let value: Vec<u16> = "Path\0".encode_utf16().collect();
    let flags = RRF_RT_REG_SZ | RRF_RT_REG_EXPAND_SZ | RRF_NOEXPAND;
    // The value can grow between sizing it and reading it: retry a few times.
    for _ in 0..4 {
        let mut size: u32 = 0;
        // SAFETY: `subkey` and `value` are NUL-terminated UTF-16 that outlive the call; passing a
        // null data pointer with a size out-parameter is the documented way to query the size.
        let status = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                subkey.as_ptr(),
                value.as_ptr(),
                flags,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                &mut size,
            )
        };
        if status == ERROR_FILE_NOT_FOUND {
            return Some(String::new());
        }
        if status != ERROR_SUCCESS {
            return None;
        }
        let mut buf: Vec<u16> = vec![0; size as usize / 2 + 2];
        let mut capacity = (buf.len() * 2) as u32;
        // SAFETY: `buf` is writable for `capacity` bytes and outlives the call; `capacity` is
        // passed as the buffer size and receives the size written.
        let status = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                subkey.as_ptr(),
                value.as_ptr(),
                flags,
                std::ptr::null_mut(),
                buf.as_mut_ptr().cast(),
                &mut capacity,
            )
        };
        if status == ERROR_MORE_DATA {
            continue;
        }
        if status != ERROR_SUCCESS {
            return None;
        }
        // `capacity` counts the terminating NUL.
        let units = (capacity as usize / 2).saturating_sub(1).min(buf.len());
        return String::from_utf16(&buf[..units]).ok();
    }
    None
}

/// Persistent per-user PATH check (registry), not just this process.
#[cfg(target_os = "windows")]
fn persisted_user_path_contains(dir: &str) -> bool {
    match read_user_path_registry() {
        Some(v) => path_contains_dir(&v, dir),
        // Unreadable (not "empty"): fall back to this process's PATH, as before.
        None => current_process_path_contains(Path::new(dir)),
    }
}

/// A registry string value with the kind it is stored as. `HKCU\Environment\Path` is usually
/// `REG_EXPAND_SZ` (it holds `%USERPROFILE%`-style references); writing it back as plain
/// `REG_SZ` makes Windows stop expanding them, which breaks every such entry.
#[cfg(target_os = "windows")]
#[derive(Debug, PartialEq, Eq)]
struct RegString {
    text: String,
    expandable: bool,
}

/// `Ok(None)`: the value does not exist. `Err(())`: it exists but cannot be read as a string.
#[cfg(target_os = "windows")]
fn read_registry_string(subkey: &str, name: &str) -> Result<Option<RegString>, ()> {
    use windows_sys::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_MORE_DATA, ERROR_SUCCESS};
    use windows_sys::Win32::System::Registry::{
        RegGetValueW, HKEY_CURRENT_USER, REG_EXPAND_SZ, RRF_NOEXPAND, RRF_RT_REG_EXPAND_SZ,
        RRF_RT_REG_SZ,
    };

    let subkey: Vec<u16> = subkey.encode_utf16().chain(std::iter::once(0)).collect();
    let name: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
    let flags = RRF_RT_REG_SZ | RRF_RT_REG_EXPAND_SZ | RRF_NOEXPAND;
    for _ in 0..4 {
        let mut size: u32 = 0;
        // SAFETY: both strings are NUL-terminated UTF-16 that outlive the call; a null data
        // pointer with a size out-parameter is the documented way to ask for the size.
        let status = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                subkey.as_ptr(),
                name.as_ptr(),
                flags,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                &mut size,
            )
        };
        if status == ERROR_FILE_NOT_FOUND {
            return Ok(None);
        }
        if status != ERROR_SUCCESS {
            return Err(());
        }
        let mut buf: Vec<u16> = vec![0; size as usize / 2 + 2];
        let mut capacity = (buf.len() * 2) as u32;
        let mut kind: u32 = 0;
        // SAFETY: `buf` is writable for `capacity` bytes and outlives the call; `kind` and
        // `capacity` are valid out-parameters.
        let status = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                subkey.as_ptr(),
                name.as_ptr(),
                flags,
                &mut kind,
                buf.as_mut_ptr().cast(),
                &mut capacity,
            )
        };
        if status == ERROR_MORE_DATA {
            continue;
        }
        if status != ERROR_SUCCESS {
            return Err(());
        }
        let units = (capacity as usize / 2).saturating_sub(1).min(buf.len());
        let text = String::from_utf16(&buf[..units]).map_err(|_| ())?;
        return Ok(Some(RegString {
            text,
            expandable: kind == REG_EXPAND_SZ,
        }));
    }
    Err(())
}

/// Writes a string value under `HKEY_CURRENT_USER\<subkey>` (created if missing) as
/// `REG_EXPAND_SZ` or `REG_SZ`.
#[cfg(target_os = "windows")]
fn write_registry_string(subkey: &str, name: &str, value: &RegString) -> Result<(), u32> {
    use windows_sys::Win32::Foundation::ERROR_SUCCESS;
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegCreateKeyExW, RegSetValueExW, HKEY, HKEY_CURRENT_USER, KEY_SET_VALUE,
        REG_EXPAND_SZ, REG_OPTION_NON_VOLATILE, REG_SZ,
    };

    let subkey: Vec<u16> = subkey.encode_utf16().chain(std::iter::once(0)).collect();
    let name: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
    let data: Vec<u16> = value
        .text
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let mut key: HKEY = std::ptr::null_mut();
    // SAFETY: `subkey` is NUL-terminated UTF-16; `key` is a valid out-parameter that is closed
    // below on every path where the call succeeded.
    let status = unsafe {
        RegCreateKeyExW(
            HKEY_CURRENT_USER,
            subkey.as_ptr(),
            0,
            std::ptr::null(),
            REG_OPTION_NON_VOLATILE,
            KEY_SET_VALUE,
            std::ptr::null(),
            &mut key,
            std::ptr::null_mut(),
        )
    };
    if status != ERROR_SUCCESS {
        return Err(status);
    }
    let kind = if value.expandable {
        REG_EXPAND_SZ
    } else {
        REG_SZ
    };
    // SAFETY: `key` was opened above; `data` is valid for `data.len() * 2` bytes and is
    // NUL-terminated, as REG_SZ / REG_EXPAND_SZ data must be.
    let status = unsafe {
        RegSetValueExW(
            key,
            name.as_ptr(),
            0,
            kind,
            data.as_ptr().cast(),
            (data.len() * 2) as u32,
        )
    };
    // SAFETY: `key` is a valid open key.
    unsafe { RegCloseKey(key) };
    if status == ERROR_SUCCESS {
        Ok(())
    } else {
        Err(status)
    }
}

/// `existing` with `dir` appended, or `None` when `dir` is already listed. Entries are kept
/// exactly as they are written (unexpanded variable references included).
#[cfg(target_os = "windows")]
fn path_with_appended(existing: &str, dir: &str) -> Option<String> {
    if path_contains_dir(existing, dir) {
        return None;
    }
    let trimmed = existing.trim_end_matches(';');
    Some(if trimmed.is_empty() {
        dir.to_string()
    } else {
        format!("{trimmed};{dir}")
    })
}

/// Appends `dir` to the persistent per-user PATH in `HKCU\<subkey>`, keeping the value's kind
/// (a `REG_EXPAND_SZ` PATH stays one). A PATH that does not exist yet is created expandable, as
/// Windows itself does. Returns whether the value changed.
#[cfg(target_os = "windows")]
fn append_to_registry_path(subkey: &str, dir: &str) -> bool {
    let current = match read_registry_string(subkey, "Path") {
        Ok(current) => current,
        // Unreadable: do not overwrite what we cannot see.
        Err(()) => return false,
    };
    let (existing, expandable) = match &current {
        Some(v) => (v.text.as_str(), v.expandable),
        None => ("", true),
    };
    let Some(text) = path_with_appended(existing, dir) else {
        return false;
    };
    write_registry_string(subkey, "Path", &RegString { text, expandable }).is_ok()
}

/// Tells running programs (Explorer, new terminals) that the environment changed, so a new
/// terminal sees the PATH without a sign-out. A hung program is skipped after 5 s.
#[cfg(target_os = "windows")]
fn broadcast_env_change() {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        SendMessageTimeoutW, HWND_BROADCAST, SMTO_ABORTIFHUNG, WM_SETTINGCHANGE,
    };
    let param: Vec<u16> = "Environment\0".encode_utf16().collect();
    let mut result: usize = 0;
    // SAFETY: HWND_BROADCAST with WM_SETTINGCHANGE is the documented way to announce an
    // environment change; `param` is NUL-terminated UTF-16 that outlives the call and `result`
    // is a valid out-parameter. The call times out after 5000 ms per window.
    unsafe {
        SendMessageTimeoutW(
            HWND_BROADCAST,
            WM_SETTINGCHANGE,
            0,
            param.as_ptr() as isize,
            SMTO_ABORTIFHUNG,
            5000,
            &mut result,
        );
    }
}

/// Append `dir` to the persistent User PATH (`HKCU\Environment`). Returns true when the value
/// changed (caller should tell the user to restart the terminal).
///
/// Written straight to the registry, keeping the value's kind: the PowerShell route this
/// replaces read a `REG_EXPAND_SZ` PATH expanded and wrote it back as `REG_SZ`, which flattened
/// every `%VAR%` entry, and started `powershell` by bare name through PATH.
#[cfg(target_os = "windows")]
fn ensure_persisted_user_path(dir: &str) -> bool {
    if persisted_user_path_contains(dir) {
        return false;
    }
    append_to_registry_path("Environment", dir)
}

#[cfg(not(target_os = "windows"))]
const KAI_RC_MARK: &str = "# kai-terminal: kai CLI on PATH";

/// The lines added to a shell rc file. `~/.local/bin` goes AFTER the existing PATH: a
/// user-writable folder in front of `/usr/bin` would let anything that can write there shadow a
/// system tool for every shell the user opens; at the end it only supplies commands that are not
/// found elsewhere, which is all the `kai` shim needs.
#[cfg(not(target_os = "windows"))]
fn rc_path_block(fish: bool) -> String {
    if fish {
        format!("\n{KAI_RC_MARK}\nfish_add_path --append ~/.local/bin\n")
    } else {
        format!("\n{KAI_RC_MARK}\nexport PATH=\"$PATH:$HOME/.local/bin\"\n")
    }
}

/// Append `~/.local/bin` to shell rc files (idempotent). Returns true when a
/// terminal restart is needed to pick it up.
#[cfg(not(target_os = "windows"))]
fn ensure_rc_path(dir: &Path) -> bool {
    let home = match std::env::var("HOME") {
        Ok(h) if !h.trim().is_empty() => PathBuf::from(h),
        _ => return false,
    };
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
        let block = rc_path_block(rc.ends_with("config.fish"));
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
#[tauri::command(async)]
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
#[tauri::command(async)]
pub fn ensure_kai_cli_cmd(app: tauri::AppHandle) -> KaiCliStatus {
    let resource_dir = app.path().resource_dir().ok();
    ensure_kai_cli(resource_dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "windows")]
    mod windows_registry_path {
        use super::super::*;

        /// A throw-away key under HKCU, removed afterwards; the real `Environment` key is never
        /// touched by these tests.
        struct Scratch(String);
        impl Scratch {
            fn new(tag: &str) -> Self {
                Scratch(format!(
                    "Software\\KaiTerminalTests\\{}-{}-{}",
                    tag,
                    std::process::id(),
                    std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_nanos())
                        .unwrap_or(0)
                ))
            }
        }
        impl Drop for Scratch {
            fn drop(&mut self) {
                use windows_sys::Win32::System::Registry::{RegDeleteTreeW, HKEY_CURRENT_USER};
                let sub: Vec<u16> = "Software\\KaiTerminalTests\0".encode_utf16().collect();
                // SAFETY: NUL-terminated UTF-16 key path; deleting our own scratch tree.
                unsafe { RegDeleteTreeW(HKEY_CURRENT_USER, sub.as_ptr()) };
            }
        }

        fn put(sub: &str, text: &str, expandable: bool) {
            write_registry_string(
                sub,
                "Path",
                &RegString {
                    text: text.to_string(),
                    expandable,
                },
            )
            .expect("write scratch value");
        }

        #[test]
        fn an_expandable_path_stays_expandable_and_keeps_its_variables() {
            let _env = crate::test_support::lock_test_env();
            let key = Scratch::new("expand");
            put(&key.0, r"%USERPROFILE%\bin;C:\tools", true);
            assert!(append_to_registry_path(&key.0, r"C:\Users\x\.local\bin"));
            let after = read_registry_string(&key.0, "Path").unwrap().unwrap();
            assert!(
                after.expandable,
                "REG_EXPAND_SZ must not be flattened to REG_SZ"
            );
            assert_eq!(
                after.text, r"%USERPROFILE%\bin;C:\tools;C:\Users\x\.local\bin",
                "existing entries stay exactly as written"
            );
        }

        #[test]
        fn a_plain_path_stays_plain() {
            let _env = crate::test_support::lock_test_env();
            let key = Scratch::new("plain");
            put(&key.0, r"C:\tools;", false);
            assert!(append_to_registry_path(&key.0, r"C:\kai\bin"));
            let after = read_registry_string(&key.0, "Path").unwrap().unwrap();
            assert!(!after.expandable);
            assert_eq!(after.text, r"C:\tools;C:\kai\bin");
        }

        #[test]
        fn nothing_is_written_when_the_folder_is_already_listed() {
            let _env = crate::test_support::lock_test_env();
            let key = Scratch::new("present");
            put(&key.0, r"C:\kai\bin;C:\tools", true);
            assert!(!append_to_registry_path(&key.0, r"c:\KAI\bin\"));
            let after = read_registry_string(&key.0, "Path").unwrap().unwrap();
            assert_eq!(after.text, r"C:\kai\bin;C:\tools");
        }

        #[test]
        fn a_missing_path_value_is_created_expandable() {
            let _env = crate::test_support::lock_test_env();
            let key = Scratch::new("missing");
            assert_eq!(read_registry_string(&key.0, "Path"), Ok(None));
            assert!(append_to_registry_path(&key.0, r"C:\kai\bin"));
            let after = read_registry_string(&key.0, "Path").unwrap().unwrap();
            assert_eq!(after.text, r"C:\kai\bin");
            assert!(after.expandable);
        }

        #[test]
        fn path_with_appended_handles_edge_cases() {
            assert_eq!(path_with_appended("", r"C:\a"), Some(r"C:\a".to_string()));
            assert_eq!(path_with_appended(";;", r"C:\a"), Some(r"C:\a".to_string()));
            assert_eq!(
                path_with_appended(r"C:\x;", r"C:\a"),
                Some(r"C:\x;C:\a".to_string())
            );
            assert_eq!(path_with_appended(r"C:\A", r"c:\a"), None);
        }
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn rc_blocks_append_the_folder_instead_of_putting_it_first() {
        let sh = rc_path_block(false);
        assert!(sh.contains(KAI_RC_MARK));
        assert!(
            sh.contains(r#"export PATH="$PATH:$HOME/.local/bin""#),
            "{sh}"
        );
        assert!(
            !sh.contains(r#"$HOME/.local/bin:$PATH"#),
            "must not prepend: {sh}"
        );
        let fish = rc_path_block(true);
        assert!(
            fish.contains("fish_add_path --append ~/.local/bin"),
            "{fish}"
        );
    }

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
    fn test_ps1_shim_quotes_a_node_path_with_spaces() {
        let s = build_ps1_shim(
            "C:\\Program Files\\nodejs\\node.exe",
            Path::new("C:\\Users\\O'Brien\\kai\\index.js"),
        );
        assert!(s.starts_with("& 'C:\\Program Files\\nodejs\\node.exe' "));
        // An apostrophe in the script path is doubled, not left to end the literal.
        assert!(s.contains("'C:\\Users\\O''Brien\\kai\\index.js'"));
    }

    #[test]
    fn test_sh_shim_quotes_paths_with_spaces_and_apostrophes() {
        let s = build_sh_shim(
            "/Users/John Smith/.nvm/bin/node",
            Path::new("/Users/John Smith/it's/cli/index.js"),
        );
        assert!(s.contains("exec '/Users/John Smith/.nvm/bin/node' "));
        assert!(s.contains("'/Users/John Smith/it'\\''s/cli/index.js'"));
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
    fn test_find_bundled_node_probes_layouts() {
        let base = std::env::temp_dir().join(format!("kai-node-res-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        assert!(find_bundled_node(&base).is_none());
        assert!(!register_bundled_node(&base));
        let exe = if cfg!(target_os = "windows") {
            "node.exe"
        } else {
            "node"
        };
        let dir = base.join("resources").join("node");
        std::fs::create_dir_all(&dir).unwrap();
        // A directory named like the binary is not a binary.
        std::fs::create_dir_all(dir.join(exe)).unwrap();
        assert!(find_bundled_node(&base).is_none());
        std::fs::remove_dir_all(dir.join(exe)).unwrap();
        std::fs::write(dir.join(exe), "node").unwrap();
        let found = find_bundled_node(&base).expect("layout resources/node");
        assert!(found.ends_with(exe));
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

    #[test]
    fn extra_path_dirs_go_in_front_once_and_keep_order() {
        let extras = vec![
            "/home/me/.local/bin".to_string(),
            "/opt/kai/bin".to_string(),
        ];
        assert_eq!(
            path_with_extra_dirs("/usr/bin:/bin", &extras),
            "/home/me/.local/bin:/opt/kai/bin:/usr/bin:/bin"
        );
        // Already present: unchanged, never duplicated.
        assert_eq!(
            path_with_extra_dirs("/opt/kai/bin:/usr/bin", &extras[1..]),
            "/opt/kai/bin:/usr/bin"
        );
        // Empty PATH and no extras.
        assert_eq!(
            path_with_extra_dirs("", &extras[..1]),
            "/home/me/.local/bin"
        );
        assert_eq!(path_with_extra_dirs("/usr/bin", &[]), "/usr/bin");
    }

    /// The raw `Path` value `reg.exe` prints for the user's environment key.
    #[cfg(target_os = "windows")]
    fn reg_exe_user_path() -> Option<String> {
        let out = std::process::Command::new("reg")
            .args(["query", r"HKCU\Environment", "/v", "Path"])
            .output()
            .ok()?;
        if !out.status.success() {
            return None; // no Path value
        }
        let text = String::from_utf8_lossy(&out.stdout);
        let line = text.lines().find(|l| l.trim_start().starts_with("Path"))?;
        // "    Path    REG_EXPAND_SZ    C:\a;%USERPROFILE%\b"
        let rest = line.trim_start().strip_prefix("Path")?.trim_start();
        let (_kind, value) = rest.split_once(char::is_whitespace)?;
        Some(value.trim().to_string())
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn reading_the_user_path_from_the_registry_matches_reg_exe() {
        let _env = crate::test_support::lock_test_env();
        let ours = read_user_path_registry();
        match reg_exe_user_path() {
            Some(expected) => assert_eq!(
                ours.as_deref(),
                Some(expected.as_str()),
                "the registry reader must return the stored value, unexpanded"
            ),
            None => assert_eq!(ours.as_deref(), Some(""), "no PATH value reads as empty"),
        }
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn the_persisted_path_check_needs_no_child_process() {
        let _env = crate::test_support::lock_test_env();
        let stored = read_user_path_registry().expect("the user PATH is readable");
        // Any directory that is on the stored PATH is found; one that is not, is not.
        if let Some(first) = stored.split(';').find(|e| !e.trim().is_empty()) {
            if !first.contains('%') {
                assert!(persisted_user_path_contains(first));
            }
        }
        assert!(!persisted_user_path_contains(
            r"C:\kai-test-not-on-any-path-7f3a91"
        ));
    }
}
