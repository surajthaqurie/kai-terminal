use serde::{Deserialize, Serialize};
use std::env;
use std::path::Path;
use std::process::Command;
use std::time::Duration;

/// Status of a single optional third-party AI CLI.
///
/// Detection is purely local and safe: it only probes for the executable's
/// presence on `PATH` (existence + executable bit). It never executes the
/// binary, never spawns a shell, and never performs network I/O. The
/// application must work identically whether or not any of these CLIs are
/// installed.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AiCliStatus {
    pub id: String,
    pub name: String,
    pub available: bool,
    pub path: Option<String>,
}

/// Provider-neutral diagnostic state for one AI CLI.
///
/// Only reported when there is reliable evidence:
/// - `not_found`: binary absent from PATH and custom path.
/// - `version_detected`: binary executed ` --version` and printed a version.
///   This is NOT authentication success.
/// - `probe_failed`: binary exists but the bounded probe failed/timed out.
/// - `authentication_required` / `authentication_failed`: only when a
///   documented provider-specific check yields explicit evidence (never
///   inferred from arbitrary output).
/// - `ready`: only when both version AND an explicit auth check succeed.
/// - `launch_failed`: a configured custom path cannot be launched/validated.
/// - `unsupported_version`: only when a documented minimum is violated.
/// - `unknown`: authentication or version status cannot be determined
///   reliably. Callers must treat this as "needs user attention", not success.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum AiCliDiagnosticState {
    NotFound,
    VersionDetected,
    ProbeFailed,
    AuthenticationRequired,
    AuthenticationFailed,
    Ready,
    LaunchFailed,
    UnsupportedVersion,
    #[default]
    Unknown,
}

/// Detailed diagnostics for one AI CLI, including an optional version probe
/// and official install guidance. Version probing executes
/// `<binary> --version` directly (no shell) with a short timeout and treats
/// the CLI as an ordinary process; any failure degrades to `version: None`
/// with a human-readable diagnostic instead of an error.
///
/// Five signals stay separate by construction:
/// 1. executable discovery (`available` + `path` via PATH lookup),
/// 2. version detection (`version` via bounded `--version` probe),
/// 3. local config-file presence (`auth_status`: `config_present` /
///    `config_missing` / `unknown` — file existence only, NEVER credential
///    validity),
/// 4. authentication verification (no passive check performs it; only an
///    explicit user launch can prove sign-in, so `state` is never `ready`
///    from passive probing),
/// 5. launch validation (`state: launch_failed` / `probe_failed` for custom
///    paths that cannot be executed).
///
/// `state` is the machine-readable status; `auth_status` is `"unknown"`
/// unless a local config-file existence check classifies it as
/// `config_present` / `config_missing`. A successful `--version` probe NEVER
/// implies authentication success, and config-file presence NEVER proves
/// credentials are valid.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AiCliDetails {
    pub id: String,
    pub name: String,
    pub available: bool,
    pub path: Option<String>,
    pub version: Option<String>,
    pub install_guidance: String,
    pub diagnostic: String,
    #[serde(default)]
    pub state: AiCliDiagnosticState,
    /// Authentication status: `"unknown"` unless proven otherwise.
    /// Never inferred from arbitrary stdout/stderr.
    #[serde(default = "default_auth_status")]
    pub auth_status: String,
    /// True when the agent's own config file already contains a kai MCP
    /// entry. Pure read-only probe; drives the desktop "Auto-wire" button.
    #[serde(default)]
    pub kai_wired: bool,
}

fn default_auth_status() -> String {
    "unknown".to_string()
}

/// Cached `detect_ai_cli_details` result with its capture time.
type AiCliDetailsCacheEntry = (std::time::Instant, Vec<AiCliDetails>);
type AiCliDetailsCache = std::sync::Mutex<Option<AiCliDetailsCacheEntry>>;

/// MCP config merge style per agent (mirrors `src/core/agents.ts`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum McpKeyStyle {
    McpServers,
    McpOpencode,
    #[allow(dead_code)]
    VscodeServers,
    TomlCodex,
}

/// Home-relative config file + merge style for automatic kai MCP wiring.
/// Returns `None` for unknown ids; callers must reject those.
fn agent_mcp_target(id: &str) -> Option<(&'static str, McpKeyStyle, Option<&'static str>)> {
    match id {
        "claude" => Some((".claude.json", McpKeyStyle::McpServers, None)),
        "cursor" => Some((".cursor/mcp.json", McpKeyStyle::McpServers, None)),
        "codex" => Some((".codex/config.toml", McpKeyStyle::TomlCodex, None)),
        "gemini" => Some((".muse/settings.json", McpKeyStyle::McpServers, None)),
        // copilot is project-scoped (.vscode/mcp.json) and needs a project
        // directory, so the desktop command declines it with guidance.
        "copilot" => None,
        "windsurf" => Some((
            ".codeium/windsurf/mcp_config.json",
            McpKeyStyle::McpServers,
            None,
        )),
        "cline" => Some((
            cline_config_rel(),
            McpKeyStyle::McpServers,
            Some(cline_app_dir()),
        )),
        "opencode" => Some((
            ".config/opencode/opencode.json",
            McpKeyStyle::McpOpencode,
            None,
        )),
        "aider" => Some((".config/aider/mcp.json", McpKeyStyle::McpServers, None)),
        "agy" => Some((
            ".gemini/antigravity-cli/settings.json",
            McpKeyStyle::McpServers,
            None,
        )),
        _ => None,
    }
}

#[cfg(target_os = "macos")]
fn cline_config_rel() -> &'static str {
    "Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json"
}
#[cfg(target_os = "macos")]
fn cline_app_dir() -> &'static str {
    "Library/Application Support/Code"
}
#[cfg(target_os = "windows")]
fn cline_config_rel() -> &'static str {
    "AppData/Roaming/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json"
}
#[cfg(target_os = "windows")]
fn cline_app_dir() -> &'static str {
    "AppData/Roaming/Code"
}
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn cline_config_rel() -> &'static str {
    ".config/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json"
}
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn cline_app_dir() -> &'static str {
    ".config/Code"
}

/// Read-only probe: does the agent's config already contain a kai entry?
fn is_kai_wired(id: &str) -> bool {
    let home = match env::var("HOME").or_else(|_| env::var("USERPROFILE")) {
        Ok(h) => std::path::PathBuf::from(h),
        Err(_) => return false,
    };
    let (rel, style, _) = match agent_mcp_target(id) {
        Some(t) => t,
        None => return false,
    };
    let file = home.join(rel);
    let raw = match std::fs::read_to_string(&file) {
        Ok(r) => r,
        Err(_) => return false,
    };
    if raw.len() > 1024 * 1024 {
        return false;
    }
    if style == McpKeyStyle::TomlCodex {
        return raw.contains("[mcp_servers.kai]");
    }
    let parsed: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(_) => return false,
    };
    for key in ["mcpServers", "mcp", "mcp_servers", "servers"] {
        if parsed.get(key).and_then(|c| c.get("kai")).is_some() {
            return true;
        }
    }
    false
}

/// Result of automatically installing kai MCP wiring for one agent.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AgentSetupResult {
    pub id: String,
    pub path: String,
    pub wrote: bool,
    pub already_configured: bool,
    pub backup_path: Option<String>,
    pub message: String,
}

/// Best-effort launcher for the installed kai CLI.
///
/// Search order (first plausible hit wins):
/// 1. Live `PATH` (`kai`, honouring Windows `PATHEXT`).
/// 2. This app's own user-level bin dir (`~/.local/bin/kai` on
///    Linux/macOS, `%USERPROFILE%\.kai\bin\kai.cmd` on Windows) — the
///    installer / `setup:cli` location that GUI processes frequently miss
///    through their minimal inherited `PATH`.
/// 3. Well-known per-user install locations (nvm shims, `~/.cargo/bin`, …).
/// 4. Well-known absolute paths (`/usr/local/bin/kai`, …) and the npm
///    global prefix on Windows.
///
/// Every candidate must look like the Node CLI launcher, never the desktop
/// GUI binary (both may be called `kai`): symlinks/realpaths ending in
/// `.js`, or small text shims referencing `kai.js`, are accepted; large
/// binaries without a JS reference are skipped so agents are never pointed
/// at the desktop GUI as their MCP server.
pub fn get_kai_cli_launch() -> Result<Vec<String>, String> {
    for candidate in kai_launcher_candidates() {
        if is_cli_launcher_candidate(&candidate) {
            return Ok(vec![candidate]);
        }
    }
    Err("kai CLI not found. Install it first (npm i -g kai-terminal or npm run setup:cli), then retry auto-wire.".to_string())
}

/// Ordered launcher search locations for [`get_kai_cli_launch`].
fn kai_launcher_candidates() -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut push = |p: String| {
        if !p.trim().is_empty() && !out.iter().any(|e| e == &p) {
            out.push(p);
        }
    };
    if let Some(p) = find_on_path("kai") {
        push(p);
    }
    // App-managed user bin dir (installer + `setup:cli` target). Often
    // absent from the GUI process PATH, so it is probed by absolute path.
    let bindir = crate::kai_cli::kai_bin_dir();
    #[cfg(target_os = "windows")]
    {
        for name in ["kai.cmd", "kai.ps1", "kai"] {
            let c = bindir.join(name);
            if c.is_file() {
                push(c.to_string_lossy().to_string());
            }
        }
        // npm global prefix on Windows (`%APPDATA%\npm\kai.cmd`).
        if let Ok(appdata) = std::env::var("APPDATA") {
            if !appdata.trim().is_empty() {
                for name in ["kai.cmd", "kai.ps1", "kai"] {
                    let c = std::path::Path::new(&appdata).join("npm").join(name);
                    if c.is_file() {
                        push(c.to_string_lossy().to_string());
                    }
                }
            }
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let c = bindir.join("kai");
        if c.is_file() {
            push(c.to_string_lossy().to_string());
        }
    }
    // Well-known per-user install locations (nvm, cargo, …).
    for dir in supplementary_search_dirs() {
        if let Some(found) = probe_dir_for_cmd(&dir, "kai") {
            push(found);
        }
        // Same-dir runnable shim under its PATHEXT name: `probe_dir_for_cmd`
        // returns a single hit, so an extensionless POSIX script must not
        // hide a sibling `.cmd` (or vice versa) from the CLI-shim check.
        #[cfg(target_os = "windows")]
        {
            let c = dir.join("kai.cmd");
            if c.is_file() {
                push(c.to_string_lossy().to_string());
            }
        }
    }
    #[cfg(not(target_os = "windows"))]
    for abs in [
        "/usr/local/bin/kai",
        "/usr/bin/kai",
        "/opt/homebrew/bin/kai",
        "/snap/bin/kai",
    ] {
        let p = std::path::Path::new(abs);
        if p.is_file() {
            push(abs.to_string());
        }
    }
    out
}

/// True when `p` looks like the Node `kai` CLI launcher rather than the
/// desktop GUI binary: a realpath ending in `.js` (symlinked npm/global
/// installs, direct bundle references), or a small text shim/loader that
/// mentions `kai.js`. Large binaries without a JS reference (the desktop
/// `kai`/`kai.exe`) are rejected so agent configs never spawn the GUI as
/// their MCP server.
fn is_cli_launcher_candidate(p: &str) -> bool {
    let path = std::path::Path::new(p);
    if let Ok(real) = std::fs::canonicalize(path) {
        if real.to_string_lossy().to_lowercase().ends_with(".js") {
            return true;
        }
    } else if p.to_lowercase().ends_with(".js") {
        return true;
    }
    if let Ok(meta) = std::fs::metadata(path) {
        if meta.is_file() && meta.len() <= 8192 {
            if let Ok(raw) = std::fs::read(path) {
                if !raw.contains(&0) {
                    let head = String::from_utf8_lossy(&raw);
                    // Normalise separators so Windows shims (`dist\cli\index.js`)
                    // match on any OS, and compare case-insensitively.
                    let norm = head.replace('\\', "/").to_lowercase();
                    if norm.contains("kai.js") || norm.contains("dist/cli/index.js") {
                        return true;
                    }
                }
            }
        }
    }
    false
}

fn validate_launcher(launcher: &[String]) -> Result<(), String> {
    if launcher.is_empty() || launcher.len() > 8 {
        return Err("Launcher must hold 1-8 command parts.".to_string());
    }
    for part in launcher {
        if part.is_empty()
            || part.len() > 4096
            || part.contains('\0')
            || part.contains('\r')
            || part.contains('\n')
        {
            return Err("Launcher contains an invalid command part.".to_string());
        }
    }
    let head = &launcher[0];
    if head.contains('/') || head.contains('\\') {
        let p = Path::new(head);
        if !p.is_file() {
            return Err(format!("Launcher '{}' does not exist.", head));
        }
    } else if find_on_path(head).is_none() {
        return Err(format!("Launcher '{}' not found on PATH.", head));
    }
    Ok(())
}

/// Resolved spawn form for a kai MCP server config entry.
#[derive(Debug)]
struct McpSpawn {
    command: String,
    args_head: Vec<String>,
}

/// Full argument list for a tool call: head + `mcp <project>`.
fn spawn_full_args(spawn: &McpSpawn, project_arg: &str) -> Vec<String> {
    let mut full = spawn.args_head.clone();
    full.push("mcp".to_string());
    full.push(project_arg.to_string());
    full
}

/// Resolve `launcher` (from [`get_kai_cli_launch`]) to the verified
/// `node <kai.js> mcp` spawn form used by `kai agent setup`.
///
/// Background: the desktop panel used to write the launcher shim itself as
/// the entry command. On Windows that shim is `kai.cmd`, which agents
/// cannot spawn directly (no shell), so every desktop-wired MCP server
/// failed to start. Resolving to the JS bundle + `node` matches the
/// CLI-written entries on every OS.
///
/// Resolution order:
/// 1. Head already ends in `.js` → `node <head>`.
/// 2. Shim text (`.cmd`/`.ps1`/POSIX shell) embeds the bundle path
///    (quoted or bare token ending in `.js`, resolved relative to the shim
///    dir, `\\?\` verbatim prefixes stripped) → `node <bundle>`.
/// 3. Directly runnable binary as-is (POSIX shebang/ELF, Windows `.exe`).
/// 4. Otherwise an error — never write a config entry the agent cannot
///    launch; the message points at the terminal CLI instead.
fn resolve_mcp_command(launcher: &[String]) -> Result<McpSpawn, String> {
    let head = launcher.first().map(|s| s.as_str()).unwrap_or("");
    // 1. Direct bundle reference.
    if head.to_lowercase().ends_with(".js") {
        return Ok(McpSpawn {
            command: "node".to_string(),
            args_head: vec![strip_verbatim_prefix(head)],
        });
    }
    // 2. Bundle path embedded in a launcher shim.
    if let Some(js) = js_from_shim_file(head) {
        if std::path::Path::new(&js).is_file() {
            return Ok(McpSpawn {
                command: "node".to_string(),
                args_head: vec![js],
            });
        }
        return Err(format!(
            "kai CLI bundle not found at {js} — reinstall the CLI (npm run setup:cli) or repair the desktop install, then retry."
        ));
    }
    // 3. Directly runnable binary, kept verbatim.
    #[cfg(not(target_os = "windows"))]
    {
        if is_usable_executable(std::path::Path::new(head)) {
            let mut args_head = launcher.to_vec();
            let command = args_head.remove(0);
            return Ok(McpSpawn { command, args_head });
        }
        Err("The kai launcher is not directly runnable and no kai JS bundle could be found inside it. Run `kai agent setup <name>` from a terminal instead.".to_string())
    }
    #[cfg(target_os = "windows")]
    {
        if is_windows_runnable_binary(head) {
            let mut args_head = launcher.to_vec();
            let command = args_head.remove(0);
            return Ok(McpSpawn { command, args_head });
        }
        Err("The kai launcher is a shell shim (.cmd/.ps1) that agents cannot spawn directly, and no kai JS bundle could be found inside it. Run `kai agent setup <name>` from a terminal instead.".to_string())
    }
}

/// True on Windows for binaries agents can spawn directly (`.exe`/`.com`,
/// or extensionless files with an MZ header). Script shims (`.cmd`/`.bat`/
/// `.ps1`/…) are deliberately excluded — those must go through
/// [`js_from_shim_file`] instead.
#[cfg(target_os = "windows")]
fn is_windows_runnable_binary(p: &str) -> bool {
    let path = std::path::Path::new(p);
    if !path.is_file() {
        return false;
    }
    match path.extension().and_then(|e| e.to_str()) {
        Some(ext) => matches!(ext.to_lowercase().as_str(), "exe" | "com"),
        None => has_mz_header(path),
    }
}

/// Cross-platform absolute-path check for shim-embedded tokens.
/// `Path::is_absolute` is platform-specific, so a Windows token like
/// `C:\app\kai.js` looks relative on Linux/macOS (and vice versa for `/`
/// on Windows UNC edge cases). Drive-letter (`C:\`, `C:/`), UNC (`\\`, `//`)
/// and verbatim (`\\?\`, `//?/`) prefixes all count as absolute.
fn is_absolute_shim_token(t: &str) -> bool {
    if std::path::Path::new(t).is_absolute() {
        return true;
    }
    let bytes = t.as_bytes();
    if t.len() >= 3
        && bytes[1] == b':'
        && (bytes[2] == b'/' || bytes[2] == b'\\')
        && (bytes[0] as char).is_ascii_alphabetic()
    {
        return true;
    }
    if t.starts_with("\\\\") || t.starts_with("//") {
        return true;
    }
    false
}

/// Extract the kai JS bundle path embedded in a launcher shim
/// (`kai.cmd`, `kai.ps1`, POSIX `kai` shell script). Returns the resolved,
/// verbatim-stripped path, or `None` when the file is binary/oversized or
/// holds no resolvable `.js` token. Tokens with shell expansions (`$…`,
/// `%…`, backticks) are never trusted.
fn js_from_shim_file(shim_path: &str) -> Option<String> {
    // Size-gate BEFORE reading: never slurp multi-MB binaries into memory
    // looking for shim text.
    if let Ok(meta) = std::fs::metadata(shim_path) {
        if !meta.is_file() || meta.len() > 8192 {
            return None;
        }
    }
    let raw = std::fs::read(shim_path).ok()?;
    if raw.len() > 8192 || raw.contains(&0) {
        return None;
    }
    let text = String::from_utf8_lossy(&raw);
    // Quoted tokens first (paths with spaces), then bare tokens.
    let mut cands: Vec<String> = Vec::new();
    let mut quoted: Option<(char, String)> = None;
    for ch in text.chars() {
        if let Some((q, ref mut buf)) = quoted {
            if ch == q {
                cands.push(std::mem::take(buf));
                quoted = None;
            } else {
                buf.push(ch);
                if buf.len() > 4096 {
                    quoted = None;
                }
            }
        } else if ch == '"' || ch == '\'' {
            quoted = Some((ch, String::new()));
        }
    }
    for tok in text.split(|c: char| c.is_whitespace() || c == '"' || c == '\'' || c == ';') {
        let t = tok.trim();
        if !t.is_empty() {
            cands.push(t.to_string());
        }
    }
    let usable = |t: &str| {
        t.to_lowercase().ends_with(".js")
            && t.len() <= 4096
            && !t.contains('$')
            && !t.contains('%')
            && !t.contains('`')
            && !t.contains('\0')
    };
    let pick = cands
        .iter()
        .find(|t| usable(t) && t.to_lowercase().contains("kai"))
        .or_else(|| cands.iter().find(|t| usable(t)));
    let token = pick?;
    let resolved = if is_absolute_shim_token(token) {
        token.clone()
    } else {
        // Relative tokens may use Windows separators (`pkg\kai.js`) even when
        // the test/host OS is Linux/macOS, where `\` is not a separator.
        // Normalising to `/` keeps the join correct on every platform
        // (Windows accepts `/` too).
        let normalised = token.replace('\\', "/");
        std::path::Path::new(shim_path)
            .parent()
            .map(|d| d.join(normalised))
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|| token.clone())
    };
    Some(strip_verbatim_prefix(&resolved))
}

/// Drop Win32 verbatim prefixes (`\\?\C:\…`, `//?/C:/…`, `\\?\UNC\…`) that
/// the installer bakes into shim contents: Node itself tolerates them, but
/// agent-side spawning/config parsing frequently does not.
fn strip_verbatim_prefix(p: &str) -> String {
    if let Some(rest) = p
        .strip_prefix("\\\\?\\UNC\\")
        .or_else(|| p.strip_prefix("//?/UNC/"))
    {
        return format!("\\\\{rest}");
    }
    if let Some(rest) = p.strip_prefix("\\\\?\\").or_else(|| p.strip_prefix("//?/")) {
        return rest.to_string();
    }
    p.to_string()
}

fn kai_entry_json(style: McpKeyStyle, spawn: &McpSpawn, project_arg: &str) -> serde_json::Value {
    let full = spawn_full_args(spawn, project_arg);
    match style {
        McpKeyStyle::McpOpencode => serde_json::json!({
            "type": "local",
            "command": std::iter::once(spawn.command.clone()).chain(full.into_iter()).collect::<Vec<_>>(),
            "enabled": true,
        }),
        McpKeyStyle::VscodeServers => serde_json::json!({
            "type": "stdio",
            "command": spawn.command.clone(),
            "args": full,
        }),
        _ => {
            serde_json::json!({ "command": spawn.command.clone(), "args": full })
        }
    }
}

/// Automatically install kai MCP wiring into an agent's own config file.
///
/// Safety contract (mirrors the Node CLI):
/// - `id` must be a known registry id; anything else is an error, never a path.
/// - `copilot` is project-scoped (`.vscode/mcp.json`) and additionally
///   requires `project_dir` (absolute); without it the call is declined with
///   guidance instead of guessing.
/// - The launcher resolves to the verified `node <kai.js>` spawn form first:
///   a config entry the agent cannot launch (e.g. a Windows `.cmd` shim) is
///   never written — the error points at the terminal CLI instead.
/// - Existing files are backed up to `<file>.kai.bak` before any write;
///   unrelated keys are preserved via JSON merge.
/// - Invalid/oversized configs are never rewritten; the error tells the
///   user to merge manually.
/// - Writes are atomic (temp file + rename).
pub fn setup_agent_mcp(
    id: &str,
    launcher: Vec<String>,
    project_arg: &str,
    force: bool,
    project_dir: Option<String>,
) -> Result<AgentSetupResult, String> {
    validate_launcher(&launcher)?;
    // Resolve the spawn form BEFORE touching any files.
    let spawn = resolve_mcp_command(&launcher)?;
    if project_arg.len() > 1024
        || project_arg.contains('\0')
        || project_arg.contains('\r')
        || project_arg.contains('\n')
    {
        return Err("Invalid project argument.".to_string());
    }
    // Project-scoped agents resolve into the caller's project directory.
    if id == "copilot" {
        let dir = project_dir.as_deref().unwrap_or("").trim();
        if dir.is_empty() {
            return Err(
                "Copilot uses project-scoped .vscode/mcp.json — open a project and retry auto-wire there, or run `kai agent setup copilot` inside the project.".to_string(),
            );
        }
        if dir.len() > 4096 || dir.contains('\0') || dir.contains('\r') || dir.contains('\n') {
            return Err("Invalid project directory.".to_string());
        }
        let base = std::path::Path::new(dir);
        if !base.is_absolute() {
            return Err(
                "Project directory must be absolute for Copilot wiring — retry with the project open.".to_string(),
            );
        }
        return setup_copilot_project(id, base, &spawn, project_arg, force);
    }
    let (rel, style, require_app_dir) = agent_mcp_target(id).ok_or_else(|| {
        format!(
            "Unknown agent id '{}'. Auto-wire supports the built-in providers only.",
            id
        )
    })?;
    let home = env::var("HOME")
        .or_else(|_| env::var("USERPROFILE"))
        .map_err(|_| "Cannot resolve home directory.".to_string())?;
    let home = std::path::PathBuf::from(home);
    if let Some(app_dir) = require_app_dir {
        if !home.join(app_dir).exists() {
            return Err(
                "VS Code storage not found on this machine; wire Cline manually via its MCP settings panel."
                    .to_string(),
            );
        }
    }
    let file = home.join(rel);

    if style == McpKeyStyle::TomlCodex {
        return setup_codex_toml(id, &file, &spawn, project_arg, force);
    }

    let container_key = match style {
        McpKeyStyle::McpOpencode => "mcp",
        McpKeyStyle::VscodeServers => "servers",
        _ => "mcpServers",
    };
    write_merged_json_config(id, &file, container_key, &spawn, project_arg, force)
}

/// Project-scoped Copilot wiring: `<project>/.vscode/mcp.json` in the
/// `servers` style, merged (never clobbered) with atomic write + backup.
fn setup_copilot_project(
    id: &str,
    project_base: &Path,
    spawn: &McpSpawn,
    project_arg: &str,
    force: bool,
) -> Result<AgentSetupResult, String> {
    let file = project_base.join(".vscode/mcp.json");
    write_merged_json_config(id, &file, "servers", spawn, project_arg, force)
}

/// Merge the kai entry into a JSON agent config (creating parent dirs and
/// the file as needed), preserving unrelated keys, with `.kai.bak` backup
/// and atomic temp-file + rename writes.
fn write_merged_json_config(
    id: &str,
    file: &Path,
    container_key: &str,
    spawn: &McpSpawn,
    project_arg: &str,
    force: bool,
) -> Result<AgentSetupResult, String> {
    let style = match container_key {
        "mcp" => McpKeyStyle::McpOpencode,
        "servers" => McpKeyStyle::VscodeServers,
        _ => McpKeyStyle::McpServers,
    };
    let existing_raw = std::fs::read_to_string(file).ok();
    let mut doc: serde_json::Value = match &existing_raw {
        None => serde_json::json!({}),
        Some(raw) => {
            if raw.trim().is_empty() {
                serde_json::json!({})
            } else if raw.len() > 1024 * 1024 {
                return Err(format!(
                    "{} exceeds 1 MB; merge the kai entry manually to avoid data loss.",
                    file.to_string_lossy()
                ));
            } else {
                serde_json::from_str(raw).map_err(|_| {
                    format!(
                        "{} is not valid JSON; merge the kai entry manually to avoid data loss.",
                        file.to_string_lossy()
                    )
                })?
            }
        }
    };
    if !doc.is_object() {
        return Err(format!(
            "{} does not hold a JSON object; merge the kai entry manually.",
            file.to_string_lossy()
        ));
    }
    let entry = kai_entry_json(style, spawn, project_arg);
    let already = doc.get(container_key).and_then(|c| c.get("kai")).is_some();
    if already && !force {
        return Ok(AgentSetupResult {
            id: id.to_string(),
            path: file.to_string_lossy().to_string(),
            wrote: false,
            already_configured: true,
            backup_path: None,
            message: "Kai entry already present.".to_string(),
        });
    }
    if !doc
        .get(container_key)
        .map(|v| v.is_object())
        .unwrap_or(false)
    {
        doc[container_key] = serde_json::json!({});
    }
    doc[container_key]["kai"] = entry;

    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Cannot create config directory: {}", e))?;
    }
    let backup_path = if existing_raw.is_some() {
        // Human-friendly `<file>.kai.bak` next to the original.
        let bak = file.with_file_name(format!(
            "{}.kai.bak",
            file.file_name().unwrap_or_default().to_string_lossy()
        ));
        std::fs::copy(file, &bak).map_err(|e| format!("Cannot back up existing config: {}", e))?;
        Some(bak.to_string_lossy().to_string())
    } else {
        None
    };
    let tmp = file.with_file_name(format!(
        "{}.kai.tmp.{}.tmp",
        file.file_name().unwrap_or_default().to_string_lossy(),
        std::process::id()
    ));
    std::fs::write(
        &tmp,
        format!("{}\n", serde_json::to_string_pretty(&doc).unwrap()),
    )
    .map_err(|e| format!("Cannot write config: {}", e))?;
    std::fs::rename(&tmp, file).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("Cannot replace config: {}", e)
    })?;
    Ok(AgentSetupResult {
        id: id.to_string(),
        path: file.to_string_lossy().to_string(),
        wrote: true,
        already_configured: false,
        backup_path,
        message: "Kai MCP entry installed.".to_string(),
    })
}

/// Remove a previously written `[mcp_servers.kai]` section (up to the next
/// table header or EOF) so forced refreshes replace instead of duplicating.
fn strip_codex_kai_section(raw: &str) -> String {
    let mut out: Vec<&str> = Vec::new();
    let mut skipping = false;
    for line in raw.lines() {
        let t = line.trim();
        if t == "[mcp_servers.kai]" {
            skipping = true;
            continue;
        }
        if skipping && t.starts_with('[') && t.ends_with(']') {
            skipping = false;
        }
        if !skipping {
            out.push(line);
        }
    }
    out.join("\n").trim_end().to_string()
}

fn setup_codex_toml(
    id: &str,
    file: &Path,
    spawn: &McpSpawn,
    project_arg: &str,
    force: bool,
) -> Result<AgentSetupResult, String> {
    let existing = std::fs::read_to_string(file).ok();
    let has_kai = existing
        .as_deref()
        .map(|r| r.contains("[mcp_servers.kai]"))
        .unwrap_or(false);
    if has_kai && !force {
        return Ok(AgentSetupResult {
            id: id.to_string(),
            path: file.to_string_lossy().to_string(),
            wrote: false,
            already_configured: true,
            backup_path: None,
            message: "Kai entry already present.".to_string(),
        });
    }
    let full = spawn_full_args(spawn, project_arg);
    let section = format!(
        "[mcp_servers.kai]\ncommand = {}\nargs = {}\n",
        serde_json::to_string(&spawn.command).unwrap(),
        serde_json::to_string(&full).unwrap()
    );
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Cannot create config directory: {}", e))?;
    }
    let backup_path = if existing.is_some() {
        let bak = file.with_file_name(format!(
            "{}.kai.bak",
            file.file_name().unwrap_or_default().to_string_lossy()
        ));
        std::fs::copy(file, &bak).map_err(|e| format!("Cannot back up existing config: {}", e))?;
        Some(bak.to_string_lossy().to_string())
    } else {
        None
    };
    let content = match existing {
        // Forced refresh replaces the stale kai section instead of appending
        // a duplicate table (duplicate `[mcp_servers.kai]` tables are a TOML
        // parse error in the agent).
        Some(raw) if has_kai => {
            let stripped = strip_codex_kai_section(&raw);
            if stripped.is_empty() {
                section
            } else {
                format!("{stripped}\n\n{section}")
            }
        }
        Some(raw) if raw.ends_with('\n') => format!("{}\n{}", raw, section),
        Some(raw) => format!("{}\n\n{}", raw, section),
        None => section,
    };
    let tmp = file.with_file_name(format!(
        "{}.kai.tmp.{}.tmp",
        file.file_name().unwrap_or_default().to_string_lossy(),
        std::process::id()
    ));
    std::fs::write(&tmp, content).map_err(|e| format!("Cannot write config: {}", e))?;
    std::fs::rename(&tmp, file).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("Cannot replace config: {}", e)
    })?;
    Ok(AgentSetupResult {
        id: id.to_string(),
        path: file.to_string_lossy().to_string(),
        wrote: true,
        already_configured: false,
        backup_path,
        message: "Kai MCP section installed.".to_string(),
    })
}
/// Verified manual MCP snippet for an agent, for the desktop panel's
/// "Manual setup" fallback (unwired agents, declined writes, offline CLI).
/// Mirrors the Node CLI `buildSetup` texts: same keys, same verified
/// `node <kai.js> mcp` spawn form. Unknown ids are an error.
pub fn agent_setup_snippet(id: &str, project_arg: &str) -> Result<String, String> {
    let project_arg = if project_arg.trim().is_empty() {
        "."
    } else {
        project_arg.trim()
    };
    // Resolve the real spawn form when the CLI is present; otherwise fall
    // back to a clearly-marked placeholder so the snippet stays copyable.
    let (command, head, install_note) = match get_kai_cli_launch()
        .ok()
        .and_then(|l| resolve_mcp_command(&l).ok())
    {
        Some(spawn) => (
            spawn.command.clone(),
            spawn.args_head.first().cloned().unwrap_or_default(),
            String::new(),
        ),
        None => (
            "node".to_string(),
            "<path-to-kai-cli-bundle>".to_string(),
            " (kai CLI not detected — install it: npm i -g kai-terminal or npm run setup:cli)"
                .to_string(),
        ),
    };
    let cmd_json = serde_json::to_string(&command).unwrap_or_else(|_| "\"node\"".to_string());
    let args_json = serde_json::to_string(&{
        let mut full = vec![head.clone()];
        full.push("mcp".to_string());
        full.push(project_arg.to_string());
        full
    })
    .unwrap_or_else(|_| "[]".to_string());
    let opencode_cmd_json = serde_json::to_string(&{
        let mut full = vec![command.clone(), head.clone()];
        full.push("mcp".to_string());
        full.push(project_arg.to_string());
        full
    })
    .unwrap_or_else(|_| "[]".to_string());

    let (file_label, body) = match id {
        "opencode" => (
            "~/.config/opencode/opencode.json",
            format!(
                "{{\n  \"$schema\": \"https://opencode.ai/config.json\",\n  \"mcp\": {{\n    \"kai\": {{\n      \"type\": \"local\",\n      \"command\": {opencode_cmd_json},\n      \"enabled\": true\n    }}\n  }}\n}}"
            ),
        ),
        "codex" => (
            "~/.codex/config.toml",
            format!("[mcp_servers.kai]\ncommand = {cmd_json}\nargs = {args_json}"),
        ),
        "copilot" => (
            "<project>/.vscode/mcp.json",
            format!(
                "{{\n  \"servers\": {{\n    \"kai\": {{\n      \"type\": \"stdio\",\n      \"command\": {cmd_json},\n      \"args\": {args_json}\n    }}\n  }}\n}}"
            ),
        ),
        "claude" | "cursor" | "gemini" | "windsurf" | "cline" | "aider" | "agy" => (
            match id {
                "claude" => "~/.claude.json",
                "cursor" => ".cursor/mcp.json",
                "gemini" => "~/.muse/settings.json",
                "windsurf" => "~/.codeium/windsurf/mcp_config.json",
                "cline" => "cline_mcp_settings.json (VS Code Cline extension storage)",
                "aider" => "~/.config/aider/mcp.json",
                _ => "~/.gemini/antigravity-cli/settings.json",
            },
            format!(
                "{{\n  \"mcpServers\": {{\n    \"kai\": {{\n      \"command\": {cmd_json},\n      \"args\": {args_json}\n    }}\n  }}\n}}"
            ),
        ),
        _ => {
            return Err(format!(
                "Unknown agent id '{id}'. Run `kai agent list` for targets."
            ))
        }
    };
    Ok(format!(
        "Add to {file_label}{install_note}:\n\n{body}\n\nThen restart {id} so it picks up the kai MCP server, or run: kai agent setup {id}"
    ))
}

/// Configuration for a user-defined custom AI CLI tool.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CustomAiCliConfig {
    pub id: String,
    pub name: String,
    pub path: String,
    pub install_guidance: Option<String>,
}

/// Catalog of optionally detected AI CLIs.
///
/// Each entry maps a stable id to the binary name(s) probed on `PATH`.
/// No binary is ever bundled with the terminal installer; this list only
/// describes what the user may independently have installed.
///
/// The trailing flag marks GUI/IDE-backed agents (Cursor, Windsurf, Cline)
/// whose shims open a desktop app: spawning them with `--version` can hang
/// or pop windows, so detection stops at "binary found" and reports the
/// version as unknown instead of a scary probe-failed diagnostic.
fn ai_cli_catalog() -> Vec<(
    &'static str,
    &'static str,
    Vec<&'static str>,
    &'static str,
    bool,
)> {
    vec![
        (
            "codex",
            "Codex CLI",
            vec!["codex"],
            "Install via npm: npm install -g @openai/codex — docs: https://github.com/openai/codex",
            false,
        ),
        (
            "claude",
            "Claude Code",
            vec!["claude", "claude-code"],
            "Install via npm: npm install -g @anthropic-ai/claude-code — docs: https://docs.anthropic.com/en/docs/claude-code",
            false,
        ),
        (
            "gemini",
            "Gemini CLI",
            vec!["gemini", "gemini-cli"],
            "Install via npm: npm install -g @google/gemini-cli — docs: https://github.com/google-gemini/gemini-cli",
            false,
        ),
        (
            "opencode",
            "opencode",
            vec!["opencode", "opencode-ai", "opencode2"],
            "Install via npm: npm install -g opencode-ai — docs: https://opencode.ai/docs",
            false,
        ),
        (
            "copilot",
            "Muse CLI",
            vec!["copilot", "gh-copilot", "github-copilot"],
            "Install via npm: npm install -g @github/copilot — docs: https://docs.github.com/en/copilot",
            false,
        ),
        (
            "aider",
            "Aider",
            vec!["aider", "aider-chat"],
            "Install via pip: pip install aider-chat — docs: https://aider.chat/docs/install.html",
            false,
        ),
        (
            "cursor",
            "Cursor",
            vec!["cursor", "cursor-cli", "cursor-agent"],
            "Install Cursor from https://cursor.com — MCP docs: https://docs.cursor.com/mcp",
            true,
        ),
        (
            "windsurf",
            "Windsurf",
            vec!["windsurf"],
            "Install Windsurf from https://windsurf.com — MCP docs: https://docs.windsurf.com",
            true,
        ),
        (
            "cline",
            "Cline",
            vec!["cline"],
            "Install the Cline VS Code extension — docs: https://docs.cline.bot/mcp",
            true,
        ),
        (
            "agy",
            "Agy",
            vec!["agy"],
            "Agy AI agent CLI (`agy` on PATH). See your Agy vendor docs for install steps.",
            false,
        ),
    ]
}

/// Detects installed AI CLIs without executing them.
///
/// Returns one entry per catalogued CLI. Missing CLIs yield
/// `available: false` and `path: None`; callers must treat that as normal.
pub fn detect_ai_clis() -> Vec<AiCliStatus> {
    ai_cli_catalog()
        .into_iter()
        .map(|(id, name, binaries, _, _)| {
            let mut found: Option<String> = None;
            for bin in binaries {
                if let Some(p) = find_on_path(bin) {
                    found = Some(p);
                    break;
                }
            }
            AiCliStatus {
                id: id.to_string(),
                name: name.to_string(),
                available: found.is_some(),
                path: found,
            }
        })
        .collect()
}

/// Returns full diagnostics including a bounded `--version` probe per CLI.
///
/// Probes run in parallel (one thread per CLI) so wall-clock time is bounded
/// by a single 5 s probe, not the sum. Results are cached for 60 s so
/// reopening the AI panel / Diagnostics does not re-spawn 10 processes
/// every time (the "every panel open is slow" report). Never panics; a
/// missing binary, auth failure, timeout, or unparsable output is reported
/// in `diagnostic` with `version: None`.
pub fn detect_ai_cli_details() -> Vec<AiCliDetails> {
    // Tests sandbox PATH/HOME per-case: caching would poison them.
    if cfg!(test) {
        return detect_ai_cli_details_uncached();
    }
    static CACHE: std::sync::OnceLock<AiCliDetailsCache> = std::sync::OnceLock::new();
    let lock = CACHE.get_or_init(|| std::sync::Mutex::new(None));
    if let Ok(guard) = lock.lock() {
        if let Some((at, cached)) = guard.as_ref() {
            if at.elapsed() < std::time::Duration::from_secs(60) {
                return cached.clone();
            }
        }
    }
    let fresh = detect_ai_cli_details_uncached();
    if let Ok(mut guard) = lock.lock() {
        *guard = Some((std::time::Instant::now(), fresh.clone()));
    }
    fresh
}

fn detect_ai_cli_details_uncached() -> Vec<AiCliDetails> {
    std::thread::scope(|s| {
        let catalog = ai_cli_catalog();
        // Small (&'static str) fallback metadata kept aside so a panicking
        // probe thread still yields a well-formed unavailable entry.
        let fallback_meta: Vec<(&'static str, &'static str, &'static str)> = catalog
            .iter()
            .map(|(id, name, _, guidance, _)| (*id, *name, *guidance))
            .collect();
        let handles: Vec<_> = catalog
            .into_iter()
            .map(|(id, name, binaries, guidance, skip_probe)| {
                s.spawn(move || details_for_entry(id, name, binaries, guidance, skip_probe))
            })
            .collect();
        handles
            .into_iter()
            .zip(fallback_meta)
            .map(|(handle, (id, name, guidance))| {
                handle.join().unwrap_or(AiCliDetails {
                    id: id.to_string(),
                    name: name.to_string(),
                    available: false,
                    path: None,
                    version: None,
                    install_guidance: guidance.to_string(),
                    diagnostic: "Detection probe failed unexpectedly; treating as unavailable."
                        .to_string(),
                    state: AiCliDiagnosticState::Unknown,
                    auth_status: default_auth_status(),
                    kai_wired: false,
                })
            })
            .collect()
    })
}

fn check_local_config_presence(id: &str) -> String {
    // Passive, local, non-billable: only tests whether the provider's
    // well-known config path EXISTS. File CONTENTS (tokens, secrets) are
    // never read, never logged, and presence never implies valid credentials.
    let home = match env::var("HOME").or_else(|_| env::var("USERPROFILE")) {
        Ok(h) => std::path::PathBuf::from(h),
        Err(_) => return default_auth_status(),
    };
    match id {
        "claude" => {
            if home.join(".claude.json").exists()
                || home.join(".config").join("claude-code").exists()
            {
                "config_present".to_string()
            } else {
                "config_missing".to_string()
            }
        }
        "codex" => {
            if home.join(".codex").exists() || home.join(".config").join("codex").exists() {
                "config_present".to_string()
            } else {
                "config_missing".to_string()
            }
        }
        "gemini" => {
            if home.join(".gemini").exists() || home.join(".config").join("gemini-cli").exists() {
                "config_present".to_string()
            } else {
                "config_missing".to_string()
            }
        }
        "opencode" => {
            if home.join(".config").join("opencode").exists() || home.join(".opencode").exists() {
                "config_present".to_string()
            } else {
                "config_missing".to_string()
            }
        }
        "copilot" => {
            if home.join(".config").join("github-copilot").exists()
                || home.join(".copilot").exists()
            {
                "config_present".to_string()
            } else {
                "config_missing".to_string()
            }
        }
        "aider" => {
            if home.join(".aider.conf.yml").exists()
                || home.join(".aider.model.settings.yml").exists()
                || home.join(".config").join("aider").exists()
            {
                "config_present".to_string()
            } else {
                "config_missing".to_string()
            }
        }
        "cursor" => {
            if home.join(".cursor").join("mcp.json").exists()
                || home.join(".cursor-server").exists()
            {
                "config_present".to_string()
            } else {
                "config_missing".to_string()
            }
        }
        "windsurf" => {
            if home
                .join(".codeium")
                .join("windsurf")
                .join("mcp_config.json")
                .exists()
                || home.join(".windsurf").exists()
            {
                "config_present".to_string()
            } else {
                "config_missing".to_string()
            }
        }
        "cline" => {
            if home.join(".config").join("cline").exists()
                || home
                    .join(".vscode")
                    .join("cline_mcp_settings.json")
                    .exists()
            {
                "config_present".to_string()
            } else {
                "config_missing".to_string()
            }
        }
        "agy" => {
            if home.join(".gemini").join("antigravity-cli").exists()
                || home.join(".config").join("agy").exists()
                || home.join(".agy").exists()
            {
                "config_present".to_string()
            } else {
                "config_missing".to_string()
            }
        }
        _ => default_auth_status(),
    }
}

fn details_for_entry(
    id: &'static str,
    name: &'static str,
    binaries: Vec<&'static str>,
    guidance: &'static str,
    skip_probe: bool,
) -> AiCliDetails {
    let mut found: Option<String> = None;
    for bin in binaries {
        if let Some(p) = find_on_path(bin) {
            found = Some(p);
            break;
        }
    }
    match found.clone() {
        None => AiCliDetails {
            id: id.to_string(),
            name: name.to_string(),
            available: false,
            path: None,
            version: None,
            install_guidance: guidance.to_string(),
            diagnostic: "Binary not found on PATH. Install it, then restart detection.".to_string(),
            state: AiCliDiagnosticState::NotFound,
            auth_status: check_local_config_presence(id),
            kai_wired: is_kai_wired(id),
        },
        Some(path) => {
            let auth_status = check_local_config_presence(id);
            let kai_wired = is_kai_wired(id);
            // GUI/IDE-backed agents (Cursor, Windsurf, Cline): their shims
            // launch a desktop app, so `--version` can hang or pop windows.
            // Report "found" without probing instead of a probe-failed scare.
            if skip_probe {
                return AiCliDetails {
                    id: id.to_string(),
                    name: name.to_string(),
                    available: true,
                    path: Some(path),
                    version: None,
                    install_guidance: guidance.to_string(),
                    diagnostic: format!(
                        "Installed (version check skipped for GUI apps). Local config file: {} — presence does not prove sign-in; launch it to verify.",
                        auth_status
                    ),
                    state: AiCliDiagnosticState::Unknown,
                    auth_status,
                    kai_wired,
                };
            }
            match probe_version(&path) {
                Some(v) => {
                    let min = min_supported_version(id);
                    let state = classify_version(min, &v);
                    AiCliDetails {
                        id: id.to_string(),
                        name: name.to_string(),
                        available: true,
                        path: Some(path),
                        version: Some(v),
                        install_guidance: guidance.to_string(),
                        diagnostic: version_diagnostic(&state, min, &auth_status),
                        state,
                        auth_status,
                        kai_wired,
                    }
                }
                None => AiCliDetails {
                    id: id.to_string(),
                    name: name.to_string(),
                    available: true,
                    path: Some(path),
                    version: None,
                    install_guidance: guidance.to_string(),
                    diagnostic: "Found on PATH but --version probe failed or timed out. Launch it in a terminal tab for details.".to_string(),
                    state: AiCliDiagnosticState::ProbeFailed,
                    auth_status,
                    kai_wired,
                },
            }
        }
    }
}

/// Validates a user-supplied custom executable path for an AI CLI without
/// executing anything beyond a bounded `--version` probe.
///
/// Returns details for the requested id, or an error string when the path is
/// invalid. Never stores credentials or modifies third-party auth files.
pub fn check_custom_ai_cli_path(id: &str, custom_path: &str) -> Result<AiCliDetails, String> {
    let catalog = ai_cli_catalog();
    let (name, guidance) = if let Some(entry) = catalog.iter().find(|(cid, _, _, _, _)| *cid == id)
    {
        (entry.1.to_string(), entry.3.to_string())
    } else if id.starts_with("custom:") || id.starts_with("user-") {
        (
            format!("Custom CLI ({})", id),
            "User-configured custom executable.".to_string(),
        )
    } else {
        return Err(format!("Unknown AI CLI id '{}'", id));
    };

    let trimmed = custom_path.trim().trim_matches('"').trim_matches('\'');
    if trimmed.is_empty() {
        return Err("Custom path is empty".to_string());
    }
    if trimmed.len() > 4096 || trimmed.contains('\0') {
        return Err("Custom path is invalid".to_string());
    }
    let p = Path::new(trimmed);
    if !p.exists() || !p.is_file() {
        return Err(format!("Path '{}' does not exist", trimmed));
    }
    #[cfg(not(target_os = "windows"))]
    {
        use std::os::unix::fs::PermissionsExt;
        match p.metadata() {
            Ok(md) if md.permissions().mode() & 0o111 != 0 => {}
            _ => return Err(format!("Path '{}' is not executable", trimmed)),
        }
    }
    let version = probe_version(trimmed);
    let min = min_supported_version(id);
    let state = match &version {
        Some(v) => classify_version(min, v),
        None => AiCliDiagnosticState::ProbeFailed,
    };
    Ok(AiCliDetails {
        id: id.to_string(),
        name,
        available: true,
        path: Some(trimmed.to_string()),
        version: version.clone(),
        install_guidance: guidance,
        diagnostic: match (&version, &state) {
            (Some(_), AiCliDiagnosticState::UnsupportedVersion) => {
                version_diagnostic(&state, min, &default_auth_status())
            }
            (Some(_), _) => "Custom path validated (version detected; not authentication).".to_string(),
            (None, _) => {
                "Custom path exists but --version probe failed or timed out; launch it directly for details.".to_string()
            }
        },
        state,
        auth_status: default_auth_status(),
        kai_wired: is_kai_wired(id),
    })
}

/// Documented minimum supported version per AI CLI id, as `(major, minor,
/// patch)`. A CLI is reported `unsupported_version` only when its parsed
/// version is strictly older than the entry here.
///
/// Policy (keep this table honest): add an entry ONLY for a minimum that is
/// documented by the vendor or verified against that tool's release notes
/// (e.g. the first release with the MCP/config behavior Kai wires up). An
/// invented floor would tell users their working install is unsupported.
/// Ids without an entry are never flagged. Currently empty: no vendor
/// minimums have been verified, so passive probing emits
/// `version_detected` for every parsable version.
const MIN_SUPPORTED_VERSIONS: &[(&str, (u64, u64, u64))] = &[];

fn min_supported_version(id: &str) -> Option<(u64, u64, u64)> {
    MIN_SUPPORTED_VERSIONS
        .iter()
        .find(|(cid, _)| *cid == id)
        .map(|(_, v)| *v)
}

/// Extracts the first `MAJOR.MINOR[.PATCH]` triple from a `--version` line.
///
/// Tolerant of vendor decoration (`codex-cli 0.46.0`, `2.1.5 (Claude Code)`,
/// `aider 0.86.1`, `v1.2.3-beta.1`, `1.2`). Missing patch defaults to 0.
/// Returns `None` when no dotted numeric token exists or a component
/// overflows, so unparsable output can never be misread as "too old".
fn parse_version_triple(raw: &str) -> Option<(u64, u64, u64)> {
    let bytes = raw.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if !bytes[i].is_ascii_digit() {
            i += 1;
            continue;
        }
        // A version must start at a token boundary: digits glued to letters
        // or a hyphen (`abc123.4`, a date `2025-01-02`) are ids, not versions.
        // A single `v`/`V` prefix (`v1.2.3`) is the one accepted decoration.
        let glued = |at: usize| bytes[at].is_ascii_alphanumeric() || bytes[at] == b'-';
        let boundary = i == 0
            || !glued(i - 1)
            || (matches!(bytes[i - 1], b'v' | b'V') && (i == 1 || !glued(i - 2)));
        let mut parts: Vec<u64> = Vec::new();
        loop {
            let ds = i;
            while i < bytes.len() && bytes[i].is_ascii_digit() {
                i += 1;
            }
            match raw[ds..i].parse::<u64>() {
                Ok(n) => parts.push(n),
                Err(_) => return None,
            }
            let dotted_digit =
                i + 1 < bytes.len() && bytes[i] == b'.' && bytes[i + 1].is_ascii_digit();
            if parts.len() < 3 && dotted_digit {
                i += 1;
                continue;
            }
            break;
        }
        if boundary && parts.len() >= 2 {
            return Some((parts[0], parts[1], parts.get(2).copied().unwrap_or(0)));
        }
    }
    None
}

/// Classifies a successfully probed `--version` line against `min`.
///
/// Returns `UnsupportedVersion` only when a minimum exists, the version
/// parses, and it is strictly older. Everything else (no minimum, equal or
/// newer, unparsable) stays `VersionDetected`: this is never an
/// authentication verdict and never fails closed on garbage output.
fn classify_version(min: Option<(u64, u64, u64)>, raw_version: &str) -> AiCliDiagnosticState {
    match (min, parse_version_triple(raw_version)) {
        (Some(min), Some(found)) if found < min => AiCliDiagnosticState::UnsupportedVersion,
        _ => AiCliDiagnosticState::VersionDetected,
    }
}

/// Diagnostic text for a probed version, including upgrade guidance when the
/// version is below the documented minimum.
fn version_diagnostic(
    state: &AiCliDiagnosticState,
    min: Option<(u64, u64, u64)>,
    auth_status: &str,
) -> String {
    match (state, min) {
        (AiCliDiagnosticState::UnsupportedVersion, Some((a, b, c))) => format!(
            "Installed version is older than the minimum supported {}.{}.{}. Upgrade it, then re-run detection. Local config file: {}.",
            a, b, c, auth_status
        ),
        _ => format!(
            "Version detected (not authentication). Local config file: {} — presence does not prove sign-in; launch it in a terminal tab to verify.",
            auth_status
        ),
    }
}

/// Bounded `<binary> --version` probe executed directly (no shell).
/// Timeout: 5 seconds (was 8 s — panels felt stuck). Output truncated to
/// 512 chars / first line.
///
/// Windows shell shims (`.cmd`/`.bat` from npm, e.g. `opencode.cmd`, and
/// `.ps1`) cannot run via `CreateProcess` directly, so they are launched
/// through their interpreter (`cmd /c` / `powershell`) with
/// `CREATE_NO_WINDOW` — same ghost-window treatment as every other helper.
/// Direct spawn is tried first for real binaries; on failure the
/// interpreter fallback gets one chance before degrading to `None`.
///
/// Safety: spawns the child directly (no shell interpolation) and polls
/// `try_wait`; on timeout the child is killed and reaped so no probe
/// process lingers. Only stdout/stderr text is read — never terminal
/// scrollback, env values, or credentials — and nothing is logged.
fn probe_version(binary_path: &str) -> Option<String> {
    use std::process::Stdio;
    use std::time::Instant;
    let build_child = |via_shell_fallback: bool| -> Option<std::process::Child> {
        let mut c = build_probe_command(binary_path, via_shell_fallback);
        c.stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .stdin(Stdio::null());
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            c.creation_flags(0x08000000);
        }
        c.spawn().ok()
    };
    // Direct spawn first (real binaries everywhere, shims on Unix). When
    // that fails on Windows, retry once through the shim's interpreter —
    // but only when the target actually exists. A missing path can never
    // yield a version; the interpreter would only echo its own
    // "command not found" error, which must not be mistaken for one.
    let mut child = match build_child(false) {
        Some(c) => c,
        None => {
            #[cfg(target_os = "windows")]
            {
                if !std::path::Path::new(binary_path).is_file() {
                    return None;
                }
                build_child(true)?
            }
            #[cfg(not(target_os = "windows"))]
            {
                return None;
            }
        }
    };
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if Instant::now() >= deadline {
                    // Bound probe duration: kill and reap so nothing lingers.
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(_) => return None,
        }
    }
    let output = child.wait_with_output().ok()?;
    if !output.status.success() && output.stdout.is_empty() && output.stderr.is_empty() {
        return None;
    }
    let combined = if !output.stdout.is_empty() {
        String::from_utf8_lossy(&output.stdout).to_string()
    } else {
        String::from_utf8_lossy(&output.stderr).to_string()
    };
    let first_line = combined.lines().next().unwrap_or("").trim();
    if first_line.is_empty() {
        return None;
    }
    Some(first_line.chars().take(512).collect())
}

/// Build the `--version` probe command for an agent binary.
///
/// On Windows, `.cmd`/`.bat` shims (what npm actually installs for
/// `opencode`, `claude`, …) cannot run via `CreateProcess` directly, so
/// they go through `cmd /c` (`.ps1` through `powershell`); real binaries
/// always spawn directly. The `via_shell_fallback` flag forces the
/// interpreter route for direct-spawn failures of unknown shim types.
fn build_probe_command(binary_path: &str, via_shell_fallback: bool) -> Command {
    #[cfg(target_os = "windows")]
    {
        let lower = binary_path.to_lowercase();
        let is_cmd_shim = lower.ends_with(".cmd") || lower.ends_with(".bat");
        let is_ps_shim = lower.ends_with(".ps1");
        if is_ps_shim || (via_shell_fallback && !is_cmd_shim) {
            // PowerShell single-quote escaping: double any embedded quote.
            let quoted = binary_path.replace('\'', "''");
            let mut c = Command::new("powershell");
            c.args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                &format!("& '{}' --version", quoted),
            ]);
            return c;
        }
        if is_cmd_shim || via_shell_fallback {
            let mut c = Command::new("cmd");
            c.args(["/c", binary_path, "--version"]);
            return c;
        }
    }
    let _ = via_shell_fallback;
    let mut c = Command::new(binary_path);
    c.arg("--version");
    c
}

/// Local `PATH` lookup entry point. No shell is spawned; each directory
/// entry is checked for existence (and the executable bit on Unix).
///
/// Desktop GUI launches typically inherit a minimal `PATH` that misses
/// user-level installers (nvm shims, `~/.local/bin`, `~/.opencode/bin`,
/// `~/.cargo/bin`, ...), so after the live `PATH` is searched a bounded set
/// of well-known install locations is probed as well (see
/// `supplementary_search_dirs`). Still purely local file stats — no
/// execution, no network.
///
/// Probe one directory for `cmd`, honouring Windows `PATHEXT`.
///
/// npm/nvm shims install as `tool` (POSIX shell script, NOT runnable via
/// `CreateProcess`) + `tool.cmd` + `tool.ps1`. The old code returned the
/// extensionless shell script, so `--version` probes failed with a scary
/// "probe failed" diagnostic (the `C:\nvm4w\nodejs\opencode` report).
/// Now the runnable shim wins; extensionless files only count when they
/// are real executables (MZ header check).
fn probe_dir_for_cmd(dir: &Path, cmd: &str) -> Option<String> {
    let candidate = dir.join(cmd);
    if candidate.exists() && is_usable_executable(&candidate) {
        return Some(candidate.to_string_lossy().to_string());
    }
    #[cfg(target_os = "windows")]
    {
        // If the caller already named an extension (e.g. `code.cmd`),
        // the exact match above settled it — never append a second one.
        let lower_cmd = cmd.to_lowercase();
        for ext in pathext_extensions() {
            if lower_cmd.ends_with(&ext) {
                continue;
            }
            let with_ext = dir.join(format!("{}{}", cmd, ext));
            if with_ext.exists() && is_usable_executable(&with_ext) {
                return Some(with_ext.to_string_lossy().to_string());
            }
        }
    }
    None
}

fn find_on_path(cmd: &str) -> Option<String> {
    if cmd.contains('/') || cmd.contains('\\') {
        let p = Path::new(cmd);
        if p.exists() && is_usable_executable(p) {
            return Some(p.to_string_lossy().to_string());
        }
        return None;
    }
    let path_env = env::var("PATH").unwrap_or_default();
    for dir in env::split_paths(&path_env) {
        if dir.as_os_str().is_empty() {
            continue;
        }
        if let Some(found) = probe_dir_for_cmd(&dir, cmd) {
            return Some(found);
        }
    }
    // Fallback: well-known per-user install locations absent from GUI PATH.
    for dir in supplementary_search_dirs() {
        if let Some(found) = probe_dir_for_cmd(&dir, cmd) {
            return Some(found);
        }
    }
    None
}

/// Lowercase `.ext` entries from `PATHEXT` (`.COM;.EXE;.BAT;.CMD`, …),
/// each guaranteed to start with a dot.
#[cfg(target_os = "windows")]
fn pathext_extensions() -> Vec<String> {
    let raw = env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD;.VBS;.PS1".to_string());
    raw.split(';')
        .map(|e| e.trim().to_lowercase())
        .filter(|e| !e.is_empty())
        .map(|e| {
            if e.starts_with('.') {
                e
            } else {
                format!(".{}", e)
            }
        })
        .collect()
}

/// True when the file starts with the DOS `MZ` executable header.
/// Used to tell real extensionless binaries apart from npm's extensionless
/// POSIX shell-script shims (which `CreateProcess` cannot run).
#[cfg(target_os = "windows")]
fn has_mz_header(path: &Path) -> bool {
    use std::io::Read;
    match std::fs::File::open(path).and_then(|mut f| {
        let mut magic = [0u8; 2];
        f.read_exact(&mut magic).map(|_| magic)
    }) {
        Ok(magic) => magic == [0x4D, 0x5A],
        Err(_) => false,
    }
}

/// Well-known install locations probed when the live `PATH` misses.
/// Bounded, home-relative or system-wide only — never user-controlled input.
fn supplementary_search_dirs() -> Vec<std::path::PathBuf> {
    use std::path::PathBuf;
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Ok(home) = env::var("HOME").or_else(|_| env::var("USERPROFILE")) {
        let h = PathBuf::from(home);
        for rel in [
            "bin",
            ".local/bin",
            ".opencode/bin",
            ".cargo/bin",
            "go/bin",
            ".npm-global/bin",
            ".local/share/mise/shims",
        ] {
            dirs.push(h.join(rel));
        }
        // nvm node versions: ~/.nvm/versions/node/<version>/bin
        let nvm_versions = h.join(".nvm/versions/node");
        if let Ok(entries) = std::fs::read_dir(&nvm_versions) {
            for entry in entries.flatten() {
                let bin = entry.path().join("bin");
                if bin.is_dir() {
                    dirs.push(bin);
                }
            }
        }
    }
    for abs in [
        "/usr/local/bin",
        "/opt/homebrew/bin",
        "/opt/local/bin",
        "/snap/bin",
    ] {
        dirs.push(PathBuf::from(abs));
    }
    dirs
}

#[cfg(not(target_os = "windows"))]
fn is_usable_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    match path.metadata() {
        Ok(md) => md.is_file() && (md.permissions().mode() & 0o111 != 0),
        Err(_) => false,
    }
}

#[cfg(target_os = "windows")]
fn is_usable_executable(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }
    match path.extension().and_then(|e| e.to_str()) {
        // Runnable only when the extension is on PATHEXT (`.exe`, `.cmd`,
        // …). npm also drops extensionless POSIX shell scripts next to the
        // real shims — those must NOT match (see `probe_dir_for_cmd`).
        Some(ext) => {
            let dot_ext = format!(".{}", ext.to_lowercase());
            pathext_extensions().iter().any(|e| e == &dot_ext)
        }
        None => has_mz_header(path),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_detect_returns_all_catalogued_clis() {
        let _env = crate::test_support::lock_test_env();
        let statuses = detect_ai_clis();
        let ids: Vec<&str> = statuses.iter().map(|s| s.id.as_str()).collect();
        assert!(ids.contains(&"codex"));
        assert!(ids.contains(&"claude"));
        assert!(ids.contains(&"gemini"));
        assert!(ids.contains(&"opencode"));
        assert!(ids.contains(&"copilot"));
        assert!(ids.contains(&"aider"));
        assert!(ids.contains(&"cursor"));
        assert!(ids.contains(&"windsurf"));
        assert!(ids.contains(&"cline"));
        assert!(ids.contains(&"agy"));
        assert_eq!(statuses.len(), 10);
    }

    #[test]
    fn test_missing_cli_is_reported_unavailable_not_error() {
        let _env = crate::test_support::lock_test_env();
        // Detection must never fail; absence is a normal state.
        let statuses = detect_ai_clis();
        for s in &statuses {
            if !s.available {
                assert!(s.path.is_none());
            } else {
                assert!(s.path.is_some());
            }
        }
    }

    #[test]
    fn test_status_serialization_roundtrip() {
        let _env = crate::test_support::lock_test_env();
        let status = AiCliStatus {
            id: "codex".into(),
            name: "Codex CLI".into(),
            available: false,
            path: None,
        };
        let json = serde_json::to_string(&status).expect("serialize");
        assert!(json.contains("codex"));
        let back: AiCliStatus = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back, status);
    }

    #[test]
    fn test_details_always_return_guidance() {
        let _env = crate::test_support::lock_test_env();
        let details = detect_ai_cli_details();
        assert_eq!(details.len(), 10);
        for d in &details {
            assert!(!d.install_guidance.is_empty());
            assert!(!d.diagnostic.is_empty());
            if !d.available {
                assert!(d.version.is_none());
            }
        }
    }

    #[test]
    fn test_custom_path_rejects_missing_and_unknown_id() {
        let _env = crate::test_support::lock_test_env();
        assert!(check_custom_ai_cli_path("codex", "/non_existent_xyz_12345").is_err());
        assert!(check_custom_ai_cli_path("unknown-id", "/bin/sh").is_err());
        assert!(check_custom_ai_cli_path("codex", "").is_err());
    }

    #[test]
    fn test_custom_path_accepts_real_executable() {
        let _env = crate::test_support::lock_test_env();
        // /bin/sh exists on Unix CI; Windows CI uses cmd path fallback.
        #[cfg(not(target_os = "windows"))]
        {
            let res = check_custom_ai_cli_path("codex", "/bin/sh");
            assert!(res.is_ok());
            assert_eq!(res.unwrap().path, Some("/bin/sh".to_string()));
        }
    }

    #[test]
    fn test_missing_cli_reports_not_found_state() {
        let _env = crate::test_support::lock_test_env();
        // Point PATH at an empty dir so nothing is found. HOME is sandboxed
        // too so the supplementary well-known-dir fallback (which ignores
        // PATH) also finds nothing on machines with user-level installs.
        let tmp = std::env::temp_dir().join("kai-ai-empty-path-test");
        let _ = std::fs::create_dir_all(&tmp);
        let old_path = std::env::var("PATH").unwrap_or_default();
        let old_home = std::env::var("HOME").ok();
        let old_profile = std::env::var("USERPROFILE").ok();
        std::env::set_var("PATH", tmp.to_string_lossy().to_string());
        std::env::set_var("HOME", tmp.to_string_lossy().to_string());
        std::env::set_var("USERPROFILE", tmp.to_string_lossy().to_string());
        let details = detect_ai_cli_details();
        std::env::set_var("PATH", old_path);
        match old_home {
            Some(v) => std::env::set_var("HOME", v),
            None => std::env::remove_var("HOME"),
        }
        match old_profile {
            Some(v) => std::env::set_var("USERPROFILE", v),
            None => std::env::remove_var("USERPROFILE"),
        }
        assert_eq!(details.len(), 10);
        for d in &details {
            assert!(!d.available);
            assert_eq!(d.state, AiCliDiagnosticState::NotFound);
            assert!(
                d.auth_status == "unknown"
                    || d.auth_status == "config_missing"
                    || d.auth_status == "config_present"
            );
            assert!(d.version.is_none());
        }
    }

    #[test]
    fn test_check_local_config_presence() {
        let _env = crate::test_support::lock_test_env();
        let status = check_local_config_presence("claude");
        assert!(status == "config_present" || status == "config_missing" || status == "unknown");
    }

    #[test]
    fn test_version_success_does_not_imply_auth() {
        let _env = crate::test_support::lock_test_env();
        // /bin/sh --version fails, but any binary that prints a version must
        // still report auth unknown, never ready/authenticated.
        let details = detect_ai_cli_details();
        for d in &details {
            if d.state == AiCliDiagnosticState::VersionDetected {
                assert!(
                    d.auth_status == "unknown"
                        || d.auth_status == "config_present"
                        || d.auth_status == "config_missing"
                );
                assert!(d.version.is_some());
                assert_ne!(d.state, AiCliDiagnosticState::Ready);
            }
        }
    }

    #[test]
    fn test_probe_timeout_returns_quickly_for_missing_binary() {
        let _env = crate::test_support::lock_test_env();
        let start = std::time::Instant::now();
        assert!(probe_version("/non_existent_xyz_12345_binary").is_none());
        assert!(start.elapsed() < std::time::Duration::from_secs(8));
    }

    #[test]
    fn test_malformed_version_never_implies_auth() {
        let _env = crate::test_support::lock_test_env();
        // A binary printing garbage on --version still yields a version
        // string (informational only) with auth unknown — never ready.
        #[cfg(not(target_os = "windows"))]
        {
            let dir = std::env::temp_dir().join(format!("kai-ai-malformed-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            let script = dir.join("fake-ai");
            std::fs::write(&script, "#!/bin/sh\necho 'not a version!!!@@@'\n").unwrap();
            {
                use std::os::unix::fs::PermissionsExt;
                let mut perms = std::fs::metadata(&script).unwrap().permissions();
                perms.set_mode(0o755);
                std::fs::set_permissions(&script, perms).unwrap();
            }
            let v = probe_version(&script.to_string_lossy());
            assert_eq!(v.as_deref(), Some("not a version!!!@@@"));
            let det = check_custom_ai_cli_path("custom:fake", &script.to_string_lossy())
                .expect("custom fake validates");
            assert_eq!(det.state, AiCliDiagnosticState::VersionDetected);
            assert_eq!(det.auth_status, "unknown");
            assert!(det.version.is_some());
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    #[test]
    fn test_hanging_binary_probe_times_out_and_reaps() {
        let _env = crate::test_support::lock_test_env();
        // A binary that ignores --version must not linger past the bound.
        #[cfg(not(target_os = "windows"))]
        {
            let dir = std::env::temp_dir().join(format!("kai-ai-hang-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            let script = dir.join("hang-ai");
            std::fs::write(&script, "#!/bin/sh\nsleep 30\n").unwrap();
            {
                use std::os::unix::fs::PermissionsExt;
                let mut perms = std::fs::metadata(&script).unwrap().permissions();
                perms.set_mode(0o755);
                std::fs::set_permissions(&script, perms).unwrap();
            }
            let start = std::time::Instant::now();
            assert!(probe_version(&script.to_string_lossy()).is_none());
            assert!(start.elapsed() < std::time::Duration::from_secs(8));
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    #[test]
    fn test_custom_path_rejects_directories_and_non_executables() {
        let _env = crate::test_support::lock_test_env();
        let dir = std::env::temp_dir().join(format!("kai-ai-custom-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        assert!(check_custom_ai_cli_path("codex", &dir.to_string_lossy()).is_err());
        let plain = dir.join("plain.txt");
        std::fs::write(&plain, "x").unwrap();
        #[cfg(not(target_os = "windows"))]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = std::fs::metadata(&plain).unwrap().permissions();
            perms.set_mode(0o644);
            std::fs::set_permissions(&plain, perms).unwrap();
            assert!(check_custom_ai_cli_path("codex", &plain.to_string_lossy()).is_err());
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_parse_version_triple_handles_vendor_decoration() {
        assert_eq!(parse_version_triple("codex-cli 0.46.0"), Some((0, 46, 0)));
        assert_eq!(parse_version_triple("2.1.5 (Claude Code)"), Some((2, 1, 5)));
        assert_eq!(parse_version_triple("aider 0.86.1"), Some((0, 86, 1)));
        assert_eq!(parse_version_triple("v1.2.3-beta.1"), Some((1, 2, 3)));
        assert_eq!(parse_version_triple("tool V4.5.6"), Some((4, 5, 6)));
        assert_eq!(parse_version_triple("opencode 1.2"), Some((1, 2, 0)));
        assert_eq!(parse_version_triple("1.2.3.4"), Some((1, 2, 3)));
        assert_eq!(parse_version_triple("10.20.30"), Some((10, 20, 30)));
    }

    #[test]
    fn test_parse_version_triple_rejects_garbage_instead_of_guessing() {
        assert_eq!(parse_version_triple(""), None);
        assert_eq!(parse_version_triple("command not found"), None);
        assert_eq!(parse_version_triple("version 7"), None);
        assert_eq!(parse_version_triple("1."), None);
        // Overflowing components must not wrap into a bogus small number.
        assert_eq!(parse_version_triple("99999999999999999999999.1.1"), None);
        // A token glued to letters is a hash/id, not a version.
        assert_eq!(parse_version_triple("build abc123.4.5"), None);
        // Only a lone `v` is decoration; `dev1.2.3` is not a version token.
        assert_eq!(parse_version_triple("dev1.2.3"), None);
        assert_eq!(parse_version_triple("2025-01-02"), None);
    }

    #[test]
    fn test_classify_version_flags_only_strictly_older_parsable_versions() {
        let min = Some((1, 4, 0));
        assert_eq!(
            classify_version(min, "tool 1.3.9"),
            AiCliDiagnosticState::UnsupportedVersion
        );
        assert_eq!(
            classify_version(min, "tool 0.99.99"),
            AiCliDiagnosticState::UnsupportedVersion
        );
        // Exactly the minimum and newer are supported.
        assert_eq!(
            classify_version(min, "tool 1.4.0"),
            AiCliDiagnosticState::VersionDetected
        );
        assert_eq!(
            classify_version(min, "tool 2.0.0"),
            AiCliDiagnosticState::VersionDetected
        );
        // Numeric (not lexicographic) comparison: 1.10.0 > 1.4.0.
        assert_eq!(
            classify_version(min, "tool 1.10.0"),
            AiCliDiagnosticState::VersionDetected
        );
        // Unparsable output never becomes "unsupported", and no minimum
        // means never flagged.
        assert_eq!(
            classify_version(min, "garbage"),
            AiCliDiagnosticState::VersionDetected
        );
        assert_eq!(
            classify_version(None, "tool 0.0.1"),
            AiCliDiagnosticState::VersionDetected
        );
    }

    #[test]
    fn test_unsupported_version_diagnostic_gives_upgrade_guidance() {
        let msg = version_diagnostic(
            &AiCliDiagnosticState::UnsupportedVersion,
            Some((1, 4, 0)),
            "config_present",
        );
        assert!(msg.contains("1.4.0"));
        assert!(msg.to_lowercase().contains("upgrade"));
        let ok = version_diagnostic(&AiCliDiagnosticState::VersionDetected, None, "unknown");
        assert!(ok.contains("not authentication"));
    }

    #[test]
    fn test_min_supported_version_lookup_matches_table_entries_only() {
        assert_eq!(min_supported_version("definitely-not-a-cli"), None);
        for (id, v) in MIN_SUPPORTED_VERSIONS {
            assert_eq!(min_supported_version(id), Some(*v));
        }
    }

    #[test]
    fn test_unsupported_version_state_serializes_and_needs_a_configured_minimum() {
        let _env = crate::test_support::lock_test_env();
        let json = serde_json::to_string(&AiCliDiagnosticState::UnsupportedVersion).unwrap();
        assert_eq!(json, "\"unsupported_version\"");
        // Passive probing of the real PATH may emit unsupported_version only
        // for ids that have a configured minimum. With the table empty
        // (no vendor-verified floors) it must never appear.
        let details = detect_ai_cli_details();
        for d in details
            .iter()
            .filter(|d| d.state == AiCliDiagnosticState::UnsupportedVersion)
        {
            assert!(min_supported_version(&d.id).is_some());
        }
        assert!(!details
            .iter()
            .any(|d| d.state == AiCliDiagnosticState::Ready));
    }

    #[test]
    fn test_config_presence_never_claims_valid_credentials() {
        let _env = crate::test_support::lock_test_env();
        let details = detect_ai_cli_details();
        for d in &details {
            // auth_status is file-existence only; diagnostics must say so.
            assert!(
                d.auth_status == "unknown"
                    || d.auth_status == "config_present"
                    || d.auth_status == "config_missing"
            );
            assert!(!d.diagnostic.to_lowercase().contains("authenticated"));
            assert!(!d.diagnostic.to_lowercase().contains("signed in as"));
            if d.state == AiCliDiagnosticState::VersionDetected {
                assert!(
                    d.diagnostic.contains("not authentication")
                        || d.diagnostic.contains("does not prove")
                );
            }
        }
    }

    #[test]
    fn test_state_serializes_to_snake_case_and_defaults_unknown() {
        let _env = crate::test_support::lock_test_env();
        let json = serde_json::to_string(&AiCliDiagnosticState::VersionDetected).unwrap();
        assert_eq!(json, "\"version_detected\"");
        // Old payloads without state/auth_status must still deserialize.
        let legacy = r#"{"id":"codex","name":"Codex CLI","available":false,"path":null,"version":null,"install_guidance":"g","diagnostic":"d"}"#;
        let back: AiCliDetails = serde_json::from_str(legacy).expect("legacy compat");
        assert_eq!(back.state, AiCliDiagnosticState::Unknown);
        assert_eq!(back.auth_status, "unknown");
        assert!(!back.kai_wired);
    }

    /// Run `f` with HOME/USERPROFILE pointed at a fresh temp dir.
    fn with_temp_home(name: &str, f: impl FnOnce(std::path::PathBuf)) {
        let dir =
            std::env::temp_dir().join(format!("kai-agent-setup-{}-{}", name, std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("temp home");
        let old_home = std::env::var("HOME").ok();
        let old_profile = std::env::var("USERPROFILE").ok();
        std::env::set_var("HOME", &dir);
        std::env::set_var("USERPROFILE", &dir);
        f(dir.clone());
        match old_home {
            Some(v) => std::env::set_var("HOME", v),
            None => std::env::remove_var("HOME"),
        }
        match old_profile {
            Some(v) => std::env::set_var("USERPROFILE", v),
            None => std::env::remove_var("USERPROFILE"),
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn test_launcher() -> Vec<String> {
        // An executable that always exists on any CI runner.
        vec![std::env::current_exe()
            .unwrap()
            .to_string_lossy()
            .to_string()]
    }

    #[test]
    fn test_setup_rejects_unknown_and_project_scoped_ids() {
        let _env = crate::test_support::lock_test_env();
        let launcher = test_launcher();
        assert!(setup_agent_mcp("no-such-agent", launcher.clone(), ".", false, None).is_err());
        assert!(setup_agent_mcp("custom:mine", launcher.clone(), ".", false, None).is_err());
        // copilot is project-scoped (.vscode/mcp.json): without a project
        // dir the desktop declines it; with one it wires the file.
        assert!(setup_agent_mcp("copilot", launcher.clone(), ".", false, None).is_err());
    }

    /// Write a fake launcher shim + bundle pair into a tag-unique temp dir
    /// (tests run in threads of one process, so the tag — not just the pid
    /// — must disambiguate). Returns `(shim_path, js_path)`.
    fn write_fake_shim(
        tag: &str,
        name: &str,
        shim_body: &str,
    ) -> (std::path::PathBuf, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "kai-mcp-resolve-{tag}-{name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let js = dir.join("dist").join("cli").join("index.js");
        std::fs::create_dir_all(js.parent().unwrap()).unwrap();
        std::fs::write(&js, "console.log('kai');\n").unwrap();
        let shim = dir.join(name);
        std::fs::write(&shim, shim_body.replace("{JS}", &js.to_string_lossy())).unwrap();
        (shim, js)
    }

    #[test]
    fn test_resolve_prefers_direct_js_head() {
        let _env = crate::test_support::lock_test_env();
        let dir = std::env::temp_dir().join(format!("kai-mcp-js-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let js = dir.join("kai.js");
        std::fs::write(&js, "console.log(1);\n").unwrap();
        let spawn =
            resolve_mcp_command(&[js.to_string_lossy().to_string()]).expect("js head resolves");
        assert_eq!(spawn.command, "node");
        assert_eq!(spawn.args_head, vec![js.to_string_lossy().to_string()]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_resolve_extracts_js_from_cmd_and_ps1_shims() {
        let _env = crate::test_support::lock_test_env();
        for (name, body) in [
            ("kai.cmd", "@echo off\r\nnode \"{JS}\" %*\r\n"),
            ("kai.ps1", "& node \"{JS}\" @args\r\nexit $LASTEXITCODE\r\n"),
            ("kai", "#!/bin/sh\nexec node \"{JS}\" \"$@\"\n"),
        ] {
            let (shim, js) = write_fake_shim("extract", name, body);
            let spawn = resolve_mcp_command(&[shim.to_string_lossy().to_string()])
                .expect("shim resolves to node+js");
            assert_eq!(spawn.command, "node");
            assert_eq!(spawn.args_head, vec![js.to_string_lossy().to_string()]);
            let _ = std::fs::remove_dir_all(shim.parent().unwrap());
        }
    }

    #[test]
    fn test_resolve_strips_verbatim_prefix_and_relative_tokens() {
        let _env = crate::test_support::lock_test_env();
        assert_eq!(
            strip_verbatim_prefix("\\\\?\\C:\\app\\kai.js"),
            "C:\\app\\kai.js"
        );
        assert_eq!(strip_verbatim_prefix("//?/C:/app/kai.js"), "C:/app/kai.js");
        assert_eq!(strip_verbatim_prefix("C:\\app\\kai.js"), "C:\\app\\kai.js");
        // Relative token resolves against the shim directory.
        let dir = std::env::temp_dir().join(format!("kai-mcp-rel-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("pkg")).unwrap();
        let js = dir.join("pkg").join("kai.js");
        std::fs::write(&js, "x").unwrap();
        let shim = dir.join("kai.cmd");
        std::fs::write(&shim, "@echo off\r\nnode \"pkg\\kai.js\" %*\r\n").unwrap();
        let got = js_from_shim_file(&shim.to_string_lossy()).expect("relative token");
        assert!(got.ends_with("kai.js"), "got: {got}");
        assert!(std::path::Path::new(&got).is_file());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_resolve_missing_bundle_is_an_error_not_a_broken_entry() {
        let _env = crate::test_support::lock_test_env();
        let dir = std::env::temp_dir().join(format!("kai-mcp-miss-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let shim = dir.join("kai.cmd");
        std::fs::write(
            &shim,
            "@echo off\r\nnode \"C:\\nope\\kai-missing-xyz\\index.js\" %*\r\n",
        )
        .unwrap();
        let err = resolve_mcp_command(&[shim.to_string_lossy().to_string()]).unwrap_err();
        assert!(err.contains("not found"), "unexpected: {err}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_desktop_gui_binary_is_not_a_cli_launcher() {
        let _env = crate::test_support::lock_test_env();
        // Small MZ-header .exe with no JS reference: the desktop GUI shape.
        let dir = std::env::temp_dir().join(format!("kai-gui-skip-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let exe = dir.join("kai.exe");
        std::fs::write(&exe, b"MZ fake desktop binary\x00\x01\x02").unwrap();
        assert!(!is_cli_launcher_candidate(&exe.to_string_lossy()));
        // ...while a real shim next to it is accepted.
        let (shim, _) = write_fake_shim("guiskip", "kai.cmd", "@echo off\r\nnode \"{JS}\" %*\r\n");
        assert!(is_cli_launcher_candidate(&shim.to_string_lossy()));
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(shim.parent().unwrap());
    }

    #[test]
    fn test_launch_falls_back_to_user_bin_dir() {
        let _env = crate::test_support::lock_test_env();
        with_temp_home("launch-fallback", |home| {
            // Empty PATH so the live lookup misses; the user bin dir (under
            // the sandboxed HOME/USERPROFILE) still resolves.
            let old_path = std::env::var("PATH").unwrap_or_default();
            let empty = std::env::temp_dir().join(format!("kai-empty-path-{}", std::process::id()));
            let _ = std::fs::create_dir_all(&empty);
            std::env::set_var("PATH", empty.to_string_lossy().to_string());
            #[cfg(target_os = "windows")]
            let shim_name = "kai.cmd";
            #[cfg(not(target_os = "windows"))]
            let shim_name = "kai";
            let (shim, _) =
                write_fake_shim("fallback", shim_name, "@echo off\r\nnode \"{JS}\" %*\r\n");
            // Stage the fake shim where get_kai_cli_launch looks.
            #[cfg(target_os = "windows")]
            let dest_dir = home.join(".kai").join("bin");
            #[cfg(not(target_os = "windows"))]
            let dest_dir = home.join(".local").join("bin");
            std::fs::create_dir_all(&dest_dir).unwrap();
            let dest = dest_dir.join(shim_name);
            std::fs::copy(&shim, &dest).unwrap();
            let got = get_kai_cli_launch().expect("fallback launch");
            std::env::set_var("PATH", old_path);
            assert_eq!(got.len(), 1);
            assert!(
                got[0]
                    .to_lowercase()
                    .ends_with(shim_name.to_lowercase().as_str()),
                "got: {:?}",
                got
            );
            let _ = std::fs::remove_dir_all(shim.parent().unwrap());
        });
    }

    #[test]
    fn test_setup_copilot_project_scope_writes_vscode_mcp() {
        let _env = crate::test_support::lock_test_env();
        with_temp_home("copilot", |home| {
            let proj = home.join("proj");
            std::fs::create_dir_all(proj.join(".vscode")).unwrap();
            std::fs::write(
                proj.join(".vscode/mcp.json"),
                r#"{"servers":{"other":{"command":"other-bin"}}}"#,
            )
            .unwrap();
            let res = setup_agent_mcp(
                "copilot",
                test_launcher(),
                ".",
                false,
                Some(proj.to_string_lossy().to_string()),
            )
            .expect("copilot project setup");
            assert!(res.wrote);
            let raw = std::fs::read_to_string(proj.join(".vscode/mcp.json")).unwrap();
            let doc: serde_json::Value = serde_json::from_str(&raw).unwrap();
            assert!(doc["servers"]["kai"].is_object());
            assert!(doc["servers"]["other"].is_object());
            // Idempotent without force.
            let again = setup_agent_mcp(
                "copilot",
                test_launcher(),
                ".",
                false,
                Some(proj.to_string_lossy().to_string()),
            )
            .expect("copilot again");
            assert!(again.already_configured);
            // Relative project dir is declined, never resolved against the
            // app's opaque working directory.
            assert!(
                setup_agent_mcp("copilot", test_launcher(), ".", false, Some(".".into())).is_err()
            );
        });
    }

    #[test]
    fn test_setup_codex_force_replaces_instead_of_duplicating() {
        let _env = crate::test_support::lock_test_env();
        with_temp_home("codex-force", |home| {
            let res = setup_agent_mcp("codex", test_launcher(), ".", false, None).expect("setup");
            assert!(res.wrote);
            let forced =
                setup_agent_mcp("codex", test_launcher(), ".", true, None).expect("force setup");
            assert!(forced.wrote);
            let raw = std::fs::read_to_string(home.join(".codex/config.toml")).unwrap();
            assert_eq!(
                raw.matches("[mcp_servers.kai]").count(),
                1,
                "duplicate kai tables would be a TOML parse error: {raw}"
            );
        });
    }

    #[test]
    fn test_setup_writes_node_spawn_form_not_shim() {
        let _env = crate::test_support::lock_test_env();
        with_temp_home("spawnform", |_| {
            let (shim, js) =
                write_fake_shim("spawnform", "kai.cmd", "@echo off\r\nnode \"{JS}\" %*\r\n");
            let res = setup_agent_mcp(
                "aider",
                vec![shim.to_string_lossy().to_string()],
                ".",
                false,
                None,
            )
            .expect("setup via shim");
            assert!(res.wrote);
            let raw = std::fs::read_to_string(&res.path).unwrap();
            let doc: serde_json::Value = serde_json::from_str(&raw).unwrap();
            assert_eq!(
                doc["mcpServers"]["kai"]["command"],
                serde_json::json!("node")
            );
            let args = doc["mcpServers"]["kai"]["args"].as_array().unwrap();
            assert_eq!(args[0], serde_json::json!(js.to_string_lossy()));
            assert!(is_kai_wired("aider"));
            let _ = std::fs::remove_dir_all(shim.parent().unwrap());
        });
    }

    #[test]
    fn test_snippet_covers_key_styles_and_rejects_unknown() {
        let _env = crate::test_support::lock_test_env();
        let open = agent_setup_snippet("opencode", ".").expect("opencode snippet");
        assert!(open.contains("\"mcp\""));
        assert!(open.contains("node"));
        let codex = agent_setup_snippet("codex", ".").expect("codex snippet");
        assert!(codex.contains("[mcp_servers.kai]"));
        let copilot = agent_setup_snippet("copilot", ".").expect("copilot snippet");
        assert!(copilot.contains("\"servers\""));
        let claude = agent_setup_snippet("claude", ".").expect("claude snippet");
        assert!(claude.contains("\"mcpServers\""));
        assert!(agent_setup_snippet("nope", ".").is_err());
    }

    #[test]
    fn test_setup_validates_launcher() {
        let _env = crate::test_support::lock_test_env();
        assert!(setup_agent_mcp("aider", vec![], ".", false, None).is_err());
        assert!(setup_agent_mcp(
            "aider",
            vec!["/non_existent_xyz_12345_launcher".to_string()],
            ".",
            false,
            None
        )
        .is_err());
        assert!(setup_agent_mcp(
            "aider",
            vec!["definitely-not-on-path-xyz-12345".to_string()],
            ".",
            false,
            None
        )
        .is_err());
    }

    #[test]
    fn test_setup_writes_merges_and_reports_wired_aider() {
        let _env = crate::test_support::lock_test_env();
        with_temp_home("aider", |home| {
            assert!(!is_kai_wired("aider"));
            let res = setup_agent_mcp("aider", test_launcher(), ".", false, None).expect("setup");
            assert!(res.wrote);
            assert!(!res.already_configured);
            assert!(res.backup_path.is_none());
            assert_eq!(
                res.path,
                home.join(".config/aider/mcp.json").to_string_lossy()
            );
            assert!(is_kai_wired("aider"));
            // Idempotent second run without force.
            let again = setup_agent_mcp("aider", test_launcher(), ".", false, None).expect("setup");
            assert!(!again.wrote);
            assert!(again.already_configured);
            // Force refresh rewrites and keeps a backup.
            let forced = setup_agent_mcp("aider", test_launcher(), ".", true, None).expect("setup");
            assert!(forced.wrote);
            assert!(forced.backup_path.is_some());
        });
    }

    #[test]
    fn test_setup_preserves_unrelated_servers() {
        let _env = crate::test_support::lock_test_env();
        with_temp_home("merge", |home| {
            let dir = home.join(".config/aider");
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(
                dir.join("mcp.json"),
                r#"{"mcpServers":{"other":{"command":"other-bin","args":[]}}}"#,
            )
            .unwrap();
            let res = setup_agent_mcp("aider", test_launcher(), ".", false, None).expect("setup");
            assert!(res.wrote);
            assert!(res.backup_path.is_some());
            let raw = std::fs::read_to_string(dir.join("mcp.json")).unwrap();
            let doc: serde_json::Value = serde_json::from_str(&raw).unwrap();
            assert!(doc["mcpServers"]["other"].is_object());
            assert!(doc["mcpServers"]["kai"].is_object());
        });
    }

    #[test]
    fn test_setup_refuses_to_rewrite_invalid_json() {
        let _env = crate::test_support::lock_test_env();
        with_temp_home("invalid", |home| {
            let dir = home.join(".config/aider");
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("mcp.json"), "{not valid json").unwrap();
            assert!(setup_agent_mcp("aider", test_launcher(), ".", false, None).is_err());
            // File left untouched.
            assert_eq!(
                std::fs::read_to_string(dir.join("mcp.json")).unwrap(),
                "{not valid json"
            );
            assert!(!is_kai_wired("aider"));
        });
    }

    #[test]
    fn test_setup_opencode_uses_mcp_key_style() {
        let _env = crate::test_support::lock_test_env();
        with_temp_home("opencode", |_| {
            let res =
                setup_agent_mcp("opencode", test_launcher(), ".", false, None).expect("setup");
            assert!(res.wrote);
            let raw = std::fs::read_to_string(&res.path).unwrap();
            let doc: serde_json::Value = serde_json::from_str(&raw).unwrap();
            assert_eq!(doc["mcp"]["kai"]["type"], serde_json::json!("local"));
            assert!(doc.get("mcpServers").is_none());
            assert!(is_kai_wired("opencode"));
        });
    }

    #[test]
    fn test_setup_codex_toml_append_is_idempotent() {
        let _env = crate::test_support::lock_test_env();
        with_temp_home("codex", |home| {
            let res = setup_agent_mcp("codex", test_launcher(), ".", false, None).expect("setup");
            assert!(res.wrote);
            let raw = std::fs::read_to_string(home.join(".codex/config.toml")).unwrap();
            assert!(raw.contains("[mcp_servers.kai]"));
            assert!(is_kai_wired("codex"));
            let again = setup_agent_mcp("codex", test_launcher(), ".", false, None).expect("setup");
            assert!(again.already_configured);
        });
    }

    #[test]
    fn test_setup_cline_declines_without_vscode_storage() {
        let _env = crate::test_support::lock_test_env();
        with_temp_home("cline", |_| {
            // Fresh temp HOME has no VS Code storage dir: must decline, not
            // fabricate foreign app directories.
            let err = setup_agent_mcp("cline", test_launcher(), ".", false, None).unwrap_err();
            assert!(err.contains("manually"));
        });
    }

    #[test]
    fn test_gui_agents_skip_version_probe() {
        let _env = crate::test_support::lock_test_env();
        let catalog = ai_cli_catalog();
        let flag = |id: &str| {
            catalog
                .iter()
                .find(|(cid, _, _, _, _)| *cid == id)
                .map(|e| e.4)
        };
        // GUI/IDE shims (Cursor, Windsurf, Cline) must not be `--version`
        // probed: spawning them can hang or pop desktop windows.
        assert_eq!(flag("cursor"), Some(true));
        assert_eq!(flag("windsurf"), Some(true));
        assert_eq!(flag("cline"), Some(true));
        // Real CLIs still get version probed.
        assert_eq!(flag("claude"), Some(false));
        assert_eq!(flag("opencode"), Some(false));
        assert_eq!(flag("codex"), Some(false));
        assert_eq!(flag("gemini"), Some(false));
    }

    /// Windows-only: an npm-style dir holding both an extensionless POSIX
    /// shell script (`tool`) and a runnable shim (`tool.cmd`) must resolve
    /// to the shim — the old code returned the shell script and every
    /// `--version` probe failed (the `C:\nvm4w\nodejs\opencode` report).
    #[cfg(target_os = "windows")]
    #[test]
    fn test_find_on_path_prefers_cmd_shim_over_shell_script() {
        let _env = crate::test_support::lock_test_env();
        let dir = std::env::temp_dir().join(format!("kai-pathext-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("kaifaketool"), "#!/bin/sh\necho hi\n").unwrap();
        std::fs::write(dir.join("kaifaketool.cmd"), "@echo off\r\necho hi\r\n").unwrap();
        let old_path = std::env::var("PATH").unwrap_or_default();
        std::env::set_var("PATH", format!("{};{}", dir.to_string_lossy(), old_path));
        let found = find_on_path("kaifaketool");
        std::env::set_var("PATH", old_path);
        let _ = std::fs::remove_dir_all(&dir);
        assert!(
            found
                .as_deref()
                .map(|p| p.to_lowercase().ends_with(".cmd"))
                .unwrap_or(false),
            "expected the .cmd shim, got {:?}",
            found
        );
    }
}
