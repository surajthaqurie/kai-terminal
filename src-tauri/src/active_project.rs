use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

/// Active Code Mode project state.
///
/// Single source of truth is `$KAI_HOME/active_project.json`, written by
/// `kai code <path>` and removed by `kai stop code`. The desktop app must
/// NOT infer Code Mode from recent-project history or default to it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ActiveProject {
    pub path: Option<String>,
    pub mode: String,
}

#[derive(Deserialize, Debug)]
struct ActiveProjectFile {
    path: Option<String>,
    mode: Option<String>,
}

fn kai_home_dir() -> Option<PathBuf> {
    if let Ok(h) = std::env::var("KAI_HOME") {
        if !h.trim().is_empty() {
            return Some(PathBuf::from(h));
        }
    }
    if let Ok(h) = std::env::var("HOME") {
        if !h.trim().is_empty() {
            return Some(PathBuf::from(h).join(".kai"));
        }
    }
    if let Ok(u) = std::env::var("USERPROFILE") {
        if !u.trim().is_empty() {
            return Some(PathBuf::from(u).join(".kai"));
        }
    }
    None
}

fn sanitize_path(p: &str) -> Option<String> {
    let t = p.trim().trim_matches('"').trim_matches('\'');
    if t.is_empty() || t.len() > 4096 || t.contains('\0') {
        return None;
    }
    Some(t.to_string())
}

/// Reads the active Code Mode project.
///
/// Precedence:
/// 1. `KAI_ACTIVE_PROJECT` env (set when the CLI launches the app) with
///    `KAI_MODE == "code"`. Works in dev AND release builds.
/// 2. `$KAI_HOME/active_project.json` with `mode == "code"`.
/// 3. Otherwise `{ path: None, mode: "terminal" }` — plain terminal mode.
///
/// Never falls back to recent history. Never defaults to code.
pub fn get_active_project() -> ActiveProject {
    // 1. Launch env from `kai code` (covers release builds where the
    // WebView localStorage path differs from dev).
    if let Ok(env_path) = std::env::var("KAI_ACTIVE_PROJECT") {
        let mode = std::env::var("KAI_MODE").unwrap_or_default();
        if mode.trim() == "code" {
            if let Some(p) = sanitize_path(&env_path) {
                return ActiveProject {
                    path: Some(p),
                    mode: "code".to_string(),
                };
            }
        }
    }

    // 2. Persisted CLI state file.
    if let Some(home) = kai_home_dir() {
        let file = home.join("active_project.json");
        if let Ok(content) = fs::read_to_string(&file) {
            if let Ok(parsed) = serde_json::from_str::<ActiveProjectFile>(&content) {
                let mode_ok = parsed.mode.as_deref().map(|m| m.trim()) == Some("code");
                if mode_ok {
                    if let Some(raw) = parsed.path.as_deref() {
                        if let Some(p) = sanitize_path(raw) {
                            return ActiveProject {
                                path: Some(p),
                                mode: "code".to_string(),
                            };
                        }
                    }
                }
            }
        }
    }

    ActiveProject {
        path: None,
        mode: "terminal".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    fn clear_env() {
        std::env::remove_var("KAI_ACTIVE_PROJECT");
        std::env::remove_var("KAI_MODE");
        std::env::remove_var("KAI_HOME");
    }

    #[test]
    fn test_no_state_returns_terminal_not_code() {
        let _g = ENV_LOCK.lock().unwrap();
        clear_env();
        let tmp = std::env::temp_dir().join(format!("kai-ap-none-{}", std::process::id()));
        let _ = fs::create_dir_all(&tmp);
        std::env::set_var("KAI_HOME", &tmp);
        let s = get_active_project();
        assert_eq!(s.path, None);
        assert_eq!(s.mode, "terminal");
        let _ = fs::remove_dir_all(&tmp);
        clear_env();
    }

    #[test]
    fn test_code_file_activates_code_mode() {
        let _g = ENV_LOCK.lock().unwrap();
        clear_env();
        let tmp = std::env::temp_dir().join(format!("kai-ap-code-{}", std::process::id()));
        let _ = fs::create_dir_all(&tmp);
        std::env::set_var("KAI_HOME", &tmp);
        fs::write(
            tmp.join("active_project.json"),
            r#"{"id":"abc","name":"demo","path":"C:\\repo\\demo","mode":"code"}"#,
        )
        .unwrap();
        let s = get_active_project();
        assert_eq!(s.path.as_deref(), Some("C:\\repo\\demo"));
        assert_eq!(s.mode, "code");
        let _ = fs::remove_dir_all(&tmp);
        clear_env();
    }

    #[test]
    fn test_non_code_mode_file_stays_terminal() {
        let _g = ENV_LOCK.lock().unwrap();
        clear_env();
        let tmp = std::env::temp_dir().join(format!("kai-ap-term-{}", std::process::id()));
        let _ = fs::create_dir_all(&tmp);
        std::env::set_var("KAI_HOME", &tmp);
        fs::write(
            tmp.join("active_project.json"),
            r#"{"path":"C:\\repo\\demo","mode":"terminal"}"#,
        )
        .unwrap();
        let s = get_active_project();
        assert_eq!(s.path, None);
        assert_eq!(s.mode, "terminal");
        let _ = fs::remove_dir_all(&tmp);
        clear_env();
    }

    #[test]
    fn test_env_vars_take_precedence_for_release_launches() {
        let _g = ENV_LOCK.lock().unwrap();
        clear_env();
        let tmp = std::env::temp_dir().join(format!("kai-ap-env-{}", std::process::id()));
        let _ = fs::create_dir_all(&tmp);
        std::env::set_var("KAI_HOME", &tmp);
        std::env::set_var("KAI_ACTIVE_PROJECT", "D:\\work\\app");
        std::env::set_var("KAI_MODE", "code");
        let s = get_active_project();
        assert_eq!(s.path.as_deref(), Some("D:\\work\\app"));
        assert_eq!(s.mode, "code");
        let _ = fs::remove_dir_all(&tmp);
        clear_env();
    }
}
