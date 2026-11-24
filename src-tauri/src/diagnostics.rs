use serde::{Deserialize, Serialize};

/// Safe application diagnostics snapshot.
///
/// Excludes terminal scrollback, environment variable values, clipboard
/// content, credentials, and settings secrets by design: only counts and
/// versions are reported.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiagnosticsReport {
    pub app_version: String,
    pub os: String,
    pub arch: String,
    pub shell_count: usize,
    pub session_count: usize,
    pub ai_cli_summary: Vec<AiCliSummary>,
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiCliSummary {
    pub id: String,
    pub available: bool,
    pub version: Option<String>,
}

/// Builds a diagnostics report from already-computed counts.
/// `shells`/`sessions` are counts only — never paths or content.
pub fn build_diagnostics(
    shell_count: usize,
    session_count: usize,
    ai_clis: Vec<AiCliSummary>,
) -> DiagnosticsReport {
    DiagnosticsReport {
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        shell_count,
        session_count,
        ai_cli_summary: ai_clis,
        notes: vec![
            "Terminal content and env values are never included.".to_string(),
            "Shell processes run with your OS user permissions (no sandbox).".to_string(),
        ],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_diagnostics_excludes_secrets_by_construction() {
        let report = build_diagnostics(2, 1, vec![]);
        let json = serde_json::to_string(&report).unwrap();
        assert!(!json.contains("PRIVATE"));
        assert!(json.contains("app_version"));
    }
}
