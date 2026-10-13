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
/// `state` is the machine-readable status; `auth_status` is `"unknown"`
/// unless a documented provider-specific local check (no network, no paid
/// calls, no credential file writes) proves otherwise. A successful
/// `--version` probe NEVER implies authentication success.
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

/// Best-effort launcher for the installed kai CLI (`["kai"]` when the
/// `kai` binary is on PATH). The desktop panel uses this to auto-wire
/// providers without guessing paths.
pub fn get_kai_cli_launch() -> Result<Vec<String>, String> {
    if let Some(p) = find_on_path("kai") {
        return Ok(vec![p]);
    }
    Err("kai CLI not found on PATH. Install it first (npm i -g kai-terminal), then retry auto-wire.".to_string())
}

fn validate_launcher(launcher: &[String]) -> Result<(), String> {
    if launcher.is_empty() || launcher.len() > 8 {
        return Err("Launcher must hold 1-8 command parts.".to_string());
    }
    for part in launcher {
        if part.is_empty() || part.len() > 4096 || part.contains('\0') || part.contains('\r') || part.contains('\n') {
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

fn kai_entry_json(style: McpKeyStyle, launcher: &[String], project_arg: &str) -> serde_json::Value {
    let mut cmd: Vec<String> = launcher.to_vec();
    cmd.push("mcp".to_string());
    cmd.push(project_arg.to_string());
    match style {
        McpKeyStyle::McpOpencode => serde_json::json!({
            "type": "local",
            "command": cmd,
            "enabled": true,
        }),
        McpKeyStyle::VscodeServers => serde_json::json!({
            "type": "stdio",
            "command": cmd[0],
            "args": cmd[1..],
        }),
        _ => {
            let (head, rest) = cmd.split_first().expect("launcher validated non-empty");
            serde_json::json!({ "command": head, "args": rest })
        }
    }
}

/// Automatically install kai MCP wiring into an agent's own config file.
///
/// Safety contract (mirrors the Node CLI):
/// - `id` must be a known registry id (copilot is project-scoped and
///   rejected here); anything else is an error, never a path.
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
) -> Result<AgentSetupResult, String> {
    let (rel, style, require_app_dir) = agent_mcp_target(id).ok_or_else(|| {
        if id == "copilot" {
            "Copilot uses project-scoped .vscode/mcp.json — run `kai agent setup copilot` inside the project instead.".to_string()
        } else {
            format!(
                "Unknown agent id '{}'. Auto-wire supports the built-in providers only.",
                id
            )
        }
    })?;
    validate_launcher(&launcher)?;
    if project_arg.len() > 1024 || project_arg.contains('\0') || project_arg.contains('\r') || project_arg.contains('\n') {
        return Err("Invalid project argument.".to_string());
    }
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
        return setup_codex_toml(id, &file, &launcher, project_arg, force);
    }

    let container_key = match style {
        McpKeyStyle::McpOpencode => "mcp",
        McpKeyStyle::VscodeServers => "servers",
        _ => "mcpServers",
    };
    let existing_raw = std::fs::read_to_string(&file).ok();
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
    let entry = kai_entry_json(style, &launcher, project_arg);
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
        std::fs::copy(&file, &bak).map_err(|e| format!("Cannot back up existing config: {}", e))?;
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
    std::fs::rename(&tmp, &file).map_err(|e| {
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

fn setup_codex_toml(
    id: &str,
    file: &Path,
    launcher: &[String],
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
    let mut cmd = launcher.to_vec();
    cmd.push("mcp".to_string());
    cmd.push(project_arg.to_string());
    let (head, rest) = cmd.split_first().expect("launcher validated non-empty");
    let section = format!(
        "[mcp_servers.kai]\ncommand = {}\nargs = {}\n",
        serde_json::to_string(head).unwrap(),
        serde_json::to_string(rest).unwrap()
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

fn check_local_auth_presence(id: &str) -> String {
    let home = match env::var("HOME").or_else(|_| env::var("USERPROFILE")) {
        Ok(h) => std::path::PathBuf::from(h),
        Err(_) => return default_auth_status(),
    };
    match id {
        "claude" => {
            if home.join(".claude.json").exists()
                || home.join(".config").join("claude-code").exists()
            {
                "configured".to_string()
            } else {
                "not_configured".to_string()
            }
        }
        "codex" => {
            if home.join(".codex").exists() || home.join(".config").join("codex").exists() {
                "configured".to_string()
            } else {
                "not_configured".to_string()
            }
        }
        "gemini" => {
            if home.join(".gemini").exists() || home.join(".config").join("gemini-cli").exists() {
                "configured".to_string()
            } else {
                "not_configured".to_string()
            }
        }
        "opencode" => {
            if home.join(".config").join("opencode").exists() || home.join(".opencode").exists() {
                "configured".to_string()
            } else {
                "not_configured".to_string()
            }
        }
        "copilot" => {
            if home.join(".config").join("github-copilot").exists()
                || home.join(".copilot").exists()
            {
                "configured".to_string()
            } else {
                "not_configured".to_string()
            }
        }
        "aider" => {
            if home.join(".aider.conf.yml").exists()
                || home.join(".aider.model.settings.yml").exists()
                || home.join(".config").join("aider").exists()
            {
                "configured".to_string()
            } else {
                "not_configured".to_string()
            }
        }
        "cursor" => {
            if home.join(".cursor").join("mcp.json").exists()
                || home.join(".cursor-server").exists()
            {
                "configured".to_string()
            } else {
                "not_configured".to_string()
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
                "configured".to_string()
            } else {
                "not_configured".to_string()
            }
        }
        "cline" => {
            if home.join(".config").join("cline").exists()
                || home
                    .join(".vscode")
                    .join("cline_mcp_settings.json")
                    .exists()
            {
                "configured".to_string()
            } else {
                "not_configured".to_string()
            }
        }
        "agy" => {
            if home.join(".gemini").join("antigravity-cli").exists()
                || home.join(".config").join("agy").exists()
                || home.join(".agy").exists()
            {
                "configured".to_string()
            } else {
                "not_configured".to_string()
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
            auth_status: check_local_auth_presence(id),
            kai_wired: is_kai_wired(id),
        },
        Some(path) => {
            let auth_status = check_local_auth_presence(id);
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
                        "Installed (version check skipped for GUI apps). Local auth configuration: {} — open it to verify it works.",
                        auth_status
                    ),
                    state: AiCliDiagnosticState::Unknown,
                    auth_status,
                    kai_wired,
                };
            }
            match probe_version(&path) {
                Some(v) => AiCliDetails {
                    id: id.to_string(),
                    name: name.to_string(),
                    available: true,
                    path: Some(path),
                    version: Some(v),
                    install_guidance: guidance.to_string(),
                    diagnostic: format!(
                        "Version detected. Local auth configuration: {} — launch it in a terminal tab to sign in or run interactive sessions.",
                        auth_status
                    ),
                    state: AiCliDiagnosticState::VersionDetected,
                    auth_status,
                    kai_wired,
                },
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
    Ok(AiCliDetails {
        id: id.to_string(),
        name,
        available: true,
        path: Some(trimmed.to_string()),
        version: version.clone(),
        install_guidance: guidance,
        diagnostic: match version {
            Some(_) => "Custom path validated.".to_string(),
            None => {
                "Custom path exists but --version probe failed (binary may need auth).".to_string()
            }
        },
        state: match version {
            Some(_) => AiCliDiagnosticState::VersionDetected,
            None => AiCliDiagnosticState::ProbeFailed,
        },
        auth_status: default_auth_status(),
        kai_wired: is_kai_wired(id),
    })
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
    // that fails on Windows, retry once through the shim's interpreter.
    let mut child = match build_child(false) {
        Some(c) => c,
        None => {
            #[cfg(target_os = "windows")]
            {
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

    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn test_detect_returns_all_catalogued_clis() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
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
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
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
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
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
        assert!(check_custom_ai_cli_path("codex", "/non_existent_xyz_12345").is_err());
        assert!(check_custom_ai_cli_path("unknown-id", "/bin/sh").is_err());
        assert!(check_custom_ai_cli_path("codex", "").is_err());
    }

    #[test]
    fn test_custom_path_accepts_real_executable() {
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
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
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
                    || d.auth_status == "not_configured"
                    || d.auth_status == "configured"
            );
            assert!(d.version.is_none());
        }
    }

    #[test]
    fn test_check_local_auth_presence() {
        let status = check_local_auth_presence("claude");
        assert!(status == "configured" || status == "not_configured" || status == "unknown");
    }

    #[test]
    fn test_version_success_does_not_imply_auth() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        // /bin/sh --version fails, but any binary that prints a version must
        // still report auth unknown, never ready/authenticated.
        let details = detect_ai_cli_details();
        for d in &details {
            if d.state == AiCliDiagnosticState::VersionDetected {
                assert!(
                    d.auth_status == "unknown"
                        || d.auth_status == "configured"
                        || d.auth_status == "not_configured"
                );
                assert!(d.version.is_some());
                assert_ne!(d.state, AiCliDiagnosticState::Ready);
            }
        }
    }

    #[test]
    fn test_probe_timeout_returns_quickly_for_missing_binary() {
        let start = std::time::Instant::now();
        assert!(probe_version("/non_existent_xyz_12345_binary").is_none());
        assert!(start.elapsed() < std::time::Duration::from_secs(8));
    }

    #[test]
    fn test_state_serializes_to_snake_case_and_defaults_unknown() {
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
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
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
        let launcher = test_launcher();
        assert!(setup_agent_mcp("no-such-agent", launcher.clone(), ".", false).is_err());
        assert!(setup_agent_mcp("custom:mine", launcher.clone(), ".", false).is_err());
        // copilot is project-scoped (.vscode/mcp.json): desktop declines it.
        assert!(setup_agent_mcp("copilot", launcher, ".", false).is_err());
    }

    #[test]
    fn test_setup_validates_launcher() {
        assert!(setup_agent_mcp("aider", vec![], ".", false).is_err());
        assert!(setup_agent_mcp(
            "aider",
            vec!["/non_existent_xyz_12345_launcher".to_string()],
            ".",
            false
        )
        .is_err());
        assert!(setup_agent_mcp(
            "aider",
            vec!["definitely-not-on-path-xyz-12345".to_string()],
            ".",
            false
        )
        .is_err());
    }

    #[test]
    fn test_setup_writes_merges_and_reports_wired_aider() {
        with_temp_home("aider", |home| {
            assert!(!is_kai_wired("aider"));
            let res = setup_agent_mcp("aider", test_launcher(), ".", false).expect("setup");
            assert!(res.wrote);
            assert!(!res.already_configured);
            assert!(res.backup_path.is_none());
            assert_eq!(
                res.path,
                home.join(".config/aider/mcp.json").to_string_lossy()
            );
            assert!(is_kai_wired("aider"));
            // Idempotent second run without force.
            let again = setup_agent_mcp("aider", test_launcher(), ".", false).expect("setup");
            assert!(!again.wrote);
            assert!(again.already_configured);
            // Force refresh rewrites and keeps a backup.
            let forced = setup_agent_mcp("aider", test_launcher(), ".", true).expect("setup");
            assert!(forced.wrote);
            assert!(forced.backup_path.is_some());
        });
    }

    #[test]
    fn test_setup_preserves_unrelated_servers() {
        with_temp_home("merge", |home| {
            let dir = home.join(".config/aider");
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(
                dir.join("mcp.json"),
                r#"{"mcpServers":{"other":{"command":"other-bin","args":[]}}}"#,
            )
            .unwrap();
            let res = setup_agent_mcp("aider", test_launcher(), ".", false).expect("setup");
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
        with_temp_home("invalid", |home| {
            let dir = home.join(".config/aider");
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("mcp.json"), "{not valid json").unwrap();
            assert!(setup_agent_mcp("aider", test_launcher(), ".", false).is_err());
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
        with_temp_home("opencode", |_| {
            let res = setup_agent_mcp("opencode", test_launcher(), ".", false).expect("setup");
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
        with_temp_home("codex", |home| {
            let res = setup_agent_mcp("codex", test_launcher(), ".", false).expect("setup");
            assert!(res.wrote);
            let raw = std::fs::read_to_string(home.join(".codex/config.toml")).unwrap();
            assert!(raw.contains("[mcp_servers.kai]"));
            assert!(is_kai_wired("codex"));
            let again = setup_agent_mcp("codex", test_launcher(), ".", false).expect("setup");
            assert!(again.already_configured);
        });
    }

    #[test]
    fn test_setup_cline_declines_without_vscode_storage() {
        with_temp_home("cline", |_| {
            // Fresh temp HOME has no VS Code storage dir: must decline, not
            // fabricate foreign app directories.
            let err = setup_agent_mcp("cline", test_launcher(), ".", false).unwrap_err();
            assert!(err.contains("manually"));
        });
    }

    #[test]
    fn test_gui_agents_skip_version_probe() {
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
        let _guard = ENV_LOCK.lock().unwrap();
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
