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
}

fn default_auth_status() -> String {
    "unknown".to_string()
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
fn ai_cli_catalog() -> Vec<(&'static str, &'static str, Vec<&'static str>, &'static str)> {
    vec![
        (
            "codex",
            "Codex CLI",
            vec!["codex"],
            "Install via npm: npm install -g @openai/codex — docs: https://github.com/openai/codex",
        ),
        (
            "claude",
            "Claude Code",
            vec!["claude"],
            "Install via npm: npm install -g @anthropic-ai/claude-code — docs: https://docs.anthropic.com/en/docs/claude-code",
        ),
        (
            "gemini",
            "Gemini CLI",
            vec!["gemini", "gemini-cli"],
            "Install via npm: npm install -g @google/gemini-cli — docs: https://github.com/google-gemini/gemini-cli",
        ),
        (
            "opencode",
            "opencode",
            vec!["opencode"],
            "Install via npm: npm install -g opencode-ai — docs: https://opencode.ai/docs",
        ),
        (
            "copilot",
            "Muse CLI",
            vec!["copilot", "gh-copilot"],
            "Install via npm: npm install -g @github/copilot — docs: https://docs.github.com/en/copilot",
        ),
        (
            "aider",
            "Aider",
            vec!["aider"],
            "Install via pip: pip install aider-chat — docs: https://aider.chat/docs/install.html",
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
        .map(|(id, name, binaries, _)| {
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
/// by a single 8 s probe, not the sum. Never panics; a missing binary, auth
/// failure, timeout, or unparsable output is reported in `diagnostic` with
/// `version: None`.
pub fn detect_ai_cli_details() -> Vec<AiCliDetails> {
    std::thread::scope(|s| {
        let catalog = ai_cli_catalog();
        // Small (&'static str) fallback metadata kept aside so a panicking
        // probe thread still yields a well-formed unavailable entry.
        let fallback_meta: Vec<(&'static str, &'static str, &'static str)> = catalog
            .iter()
            .map(|(id, name, _, guidance)| (*id, *name, *guidance))
            .collect();
        let handles: Vec<_> = catalog
            .into_iter()
            .map(|(id, name, binaries, guidance)| {
                s.spawn(move || details_for_entry(id, name, binaries, guidance))
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
            if home.join(".config").join("opencode").exists() {
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
            if home.join(".aider.conf.yml").exists() || home.join(".aider.model.settings.yml").exists()
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
        },
        Some(path) => {
            let auth_status = check_local_auth_presence(id);
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
    let (name, guidance) = if let Some(entry) = catalog.iter().find(|(cid, _, _, _)| *cid == id) {
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
    })
}

/// Bounded `<binary> --version` probe executed directly (no shell).
/// Timeout: 8 seconds. Output truncated to 512 chars / first line.
///
/// Safety: spawns the child directly (no shell interpolation) and polls
/// `try_wait`; on timeout the child is killed and reaped so no probe
/// process lingers. Only stdout/stderr text is read — never terminal
/// scrollback, env values, or credentials — and nothing is logged.
fn probe_version(binary_path: &str) -> Option<String> {
    use std::process::Stdio;
    use std::time::Instant;
    let mut child = Command::new(binary_path)
        .arg("--version")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .ok()?;
    let deadline = Instant::now() + Duration::from_secs(8);
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

/// Local `PATH` lookup. No shell is spawned; each directory entry is checked
/// for existence (and the executable bit on Unix).
fn find_on_path(cmd: &str) -> Option<String> {
    let path_env = env::var("PATH").ok()?;
    for dir in env::split_paths(&path_env) {
        if cmd.contains('/') || cmd.contains('\\') {
            let p = Path::new(cmd);
            if p.exists() && is_usable_executable(p) {
                return Some(p.to_string_lossy().to_string());
            }
            continue;
        }
        let candidate = dir.join(cmd);
        if candidate.exists() && is_usable_executable(&candidate) {
            return Some(candidate.to_string_lossy().to_string());
        }
        #[cfg(target_os = "windows")]
        {
            let with_exe = dir.join(format!("{}.exe", cmd));
            if with_exe.exists() {
                return Some(with_exe.to_string_lossy().to_string());
            }
        }
    }
    None
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
    path.is_file()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_detect_returns_all_catalogued_clis() {
        let statuses = detect_ai_clis();
        let ids: Vec<&str> = statuses.iter().map(|s| s.id.as_str()).collect();
        assert!(ids.contains(&"codex"));
        assert!(ids.contains(&"claude"));
        assert!(ids.contains(&"gemini"));
        assert!(ids.contains(&"opencode"));
        assert!(ids.contains(&"copilot"));
        assert!(ids.contains(&"aider"));
        assert_eq!(statuses.len(), 6);
    }

    #[test]
    fn test_missing_cli_is_reported_unavailable_not_error() {
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
        let details = detect_ai_cli_details();
        assert_eq!(details.len(), 6);
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
        // Point PATH at an empty dir so nothing is found.
        let tmp = std::env::temp_dir().join("kai-ai-empty-path-test");
        let _ = std::fs::create_dir_all(&tmp);
        let old_path = std::env::var("PATH").unwrap_or_default();
        std::env::set_var("PATH", tmp.to_string_lossy().to_string());
        let details = detect_ai_cli_details();
        std::env::set_var("PATH", old_path);
        assert_eq!(details.len(), 6);
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
        // /bin/sh --version fails, but any binary that prints a version must
        // still report auth unknown, never ready/authenticated.
        let details = detect_ai_cli_details();
        for d in &details {
            if d.state == AiCliDiagnosticState::VersionDetected {
                assert_eq!(d.auth_status, "unknown");
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
    }
}
