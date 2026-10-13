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

/// Candidate Kai home directories in CLI-matching precedence.
///
/// MUST mirror `getKaiHomeDir()` in `src/core/registry.ts` (`KAI_HOME` >
/// `XDG_DATA_HOME/kai` > `~/.kai`): the CLI writes `active_project.json`
/// under the first candidate, so the backend must read the same order.
/// Previously the backend skipped `XDG_DATA_HOME`, so on Linux systems with
/// `XDG_DATA_HOME` set, `kai code .` wrote one location while the desktop
/// app read another — Code Mode never activated.
fn candidate_home_dirs() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Ok(h) = std::env::var("KAI_HOME") {
        if !h.trim().is_empty() {
            out.push(PathBuf::from(h));
        }
    }
    if let Ok(x) = std::env::var("XDG_DATA_HOME") {
        if !x.trim().is_empty() {
            out.push(PathBuf::from(x).join("kai"));
        }
    }
    if let Ok(h) = std::env::var("HOME") {
        if !h.trim().is_empty() {
            out.push(PathBuf::from(h).join(".kai"));
        }
    }
    if let Ok(u) = std::env::var("USERPROFILE") {
        if !u.trim().is_empty() {
            out.push(PathBuf::from(u).join(".kai"));
        }
    }
    out
}

fn sanitize_path(p: &str) -> Option<String> {
    let t = p.trim().trim_matches('"').trim_matches('\'');
    if t.is_empty() || t.len() > 4096 || t.contains('\0') {
        return None;
    }
    Some(canonicalize_state_path(t))
}

/// Canonicalizes a Code Mode state path for cross-side comparison.
///
/// The CLI writes `resolveCanonicalPath()` (Node `realpathSync`) while pane
/// directories arrive from shells (`$PWD`, OSC 9;9) — on Windows these can
/// disagree textually for the SAME directory (8.3 short names like
/// `C:\Users\SURAJC~1\...` vs long names, verbatim `\\?\` prefixes).
/// Filesystem canonicalization collapses those to one long-name form (and
/// resolves symlinks everywhere, matching the CLI). Falls back to the
/// sanitized input when the path no longer exists. The frontend applies its
/// own case/separator normalization on top before comparing.
fn canonicalize_state_path(p: &str) -> String {
    match std::fs::canonicalize(p) {
        Ok(canon) => {
            let mut s = canon.to_string_lossy().replace('\\', "/");
            if let Some(rest) = s.strip_prefix("//?/UNC/") {
                s = format!("//{rest}");
            } else if let Some(rest) = s.strip_prefix("//?/") {
                s = rest.to_string();
            }
            if s.trim().is_empty() {
                p.to_string()
            } else {
                s
            }
        }
        Err(_) => p.to_string(),
    }
}

/// Reads the active Code Mode project.
///
/// Precedence:
/// 1. `KAI_ACTIVE_PROJECT` env (set when the CLI launches the app) with
///    `KAI_MODE == "code"`. Works in dev AND release builds.
/// 2. `active_project.json` with `mode == "code"` under the first candidate
///    home that has one (`candidate_home_dirs` order).
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

    // 2. Persisted CLI state file. Every candidate home is checked in
    // precedence order so a state file written under any of them (e.g. CLI
    // with `XDG_DATA_HOME` set, app launched without it) still activates.
    for home in candidate_home_dirs() {
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

    /// Snapshot of the home-locating env vars, for test isolation: the
    /// reader now consults `XDG_DATA_HOME`/`HOME`/`USERPROFILE` fallbacks,
    /// so tests must pin ALL of them to the temp dir (a real
    /// `~/.kai/active_project.json` on the dev machine would otherwise
    /// leak into assertions). Restored at the end of each test.
    struct EnvSnapshot {
        kai_home: Option<String>,
        xdg: Option<String>,
        home: Option<String>,
        userprofile: Option<String>,
    }

    fn isolate_home(tmp: &std::path::Path) -> EnvSnapshot {
        let snap = EnvSnapshot {
            kai_home: std::env::var("KAI_HOME").ok(),
            xdg: std::env::var("XDG_DATA_HOME").ok(),
            home: std::env::var("HOME").ok(),
            userprofile: std::env::var("USERPROFILE").ok(),
        };
        std::env::set_var("KAI_HOME", tmp);
        std::env::set_var("XDG_DATA_HOME", tmp.join("xdg-nowhere"));
        std::env::set_var("HOME", tmp);
        std::env::set_var("USERPROFILE", tmp);
        snap
    }

    fn restore_env(snap: EnvSnapshot) {
        for (k, v) in [
            ("KAI_HOME", snap.kai_home),
            ("XDG_DATA_HOME", snap.xdg),
            ("HOME", snap.home),
            ("USERPROFILE", snap.userprofile),
        ] {
            match v {
                Some(val) => std::env::set_var(k, val),
                None => std::env::remove_var(k),
            }
        }
        clear_env();
    }

    #[test]
    fn test_no_state_returns_terminal_not_code() {
        let _g = ENV_LOCK.lock().unwrap();
        clear_env();
        let tmp = std::env::temp_dir().join(format!("kai-ap-none-{}", std::process::id()));
        let _ = fs::create_dir_all(&tmp);
        let _snap = isolate_home(&tmp);
        let s = get_active_project();
        assert_eq!(s.path, None);
        assert_eq!(s.mode, "terminal");
        let _ = fs::remove_dir_all(&tmp);
        restore_env(_snap);
    }

    #[test]
    fn test_code_file_activates_code_mode() {
        let _g = ENV_LOCK.lock().unwrap();
        clear_env();
        let tmp = std::env::temp_dir().join(format!("kai-ap-code-{}", std::process::id()));
        let _ = fs::create_dir_all(&tmp);
        let _snap = isolate_home(&tmp);
        fs::write(
            tmp.join("active_project.json"),
            r#"{"id":"abc","name":"demo","path":"C:\\repo\\demo","mode":"code"}"#,
        )
        .unwrap();
        let s = get_active_project();
        assert_eq!(s.path.as_deref(), Some("C:\\repo\\demo"));
        assert_eq!(s.mode, "code");
        let _ = fs::remove_dir_all(&tmp);
        restore_env(_snap);
    }

    #[test]
    fn test_non_code_mode_file_stays_terminal() {
        let _g = ENV_LOCK.lock().unwrap();
        clear_env();
        let tmp = std::env::temp_dir().join(format!("kai-ap-term-{}", std::process::id()));
        let _ = fs::create_dir_all(&tmp);
        let _snap = isolate_home(&tmp);
        fs::write(
            tmp.join("active_project.json"),
            r#"{"path":"C:\\repo\\demo","mode":"terminal"}"#,
        )
        .unwrap();
        let s = get_active_project();
        assert_eq!(s.path, None);
        assert_eq!(s.mode, "terminal");
        let _ = fs::remove_dir_all(&tmp);
        restore_env(_snap);
    }

    #[test]
    fn test_env_vars_take_precedence_for_release_launches() {
        let _g = ENV_LOCK.lock().unwrap();
        clear_env();
        let tmp = std::env::temp_dir().join(format!("kai-ap-env-{}", std::process::id()));
        let _ = fs::create_dir_all(&tmp);
        let _snap = isolate_home(&tmp);
        std::env::set_var("KAI_ACTIVE_PROJECT", "D:\\work\\app");
        std::env::set_var("KAI_MODE", "code");
        let s = get_active_project();
        assert_eq!(s.path.as_deref(), Some("D:\\work\\app"));
        assert_eq!(s.mode, "code");
        let _ = fs::remove_dir_all(&tmp);
        restore_env(_snap);
    }

    #[test]
    fn test_xdg_fallback_activates_when_kai_home_unset() {
        // Regression: CLI honours XDG_DATA_HOME but the backend did not, so
        // `kai code .` on such systems wrote state the app never read.
        let _g = ENV_LOCK.lock().unwrap();
        clear_env();
        // KAI_HOME must be ABSENT here so the XDG candidate is exercised.
        std::env::remove_var("KAI_HOME");
        let tmp = std::env::temp_dir().join(format!("kai-ap-xdg-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        let _ = fs::create_dir_all(&tmp);
        let snap = EnvSnapshot {
            kai_home: None,
            xdg: std::env::var("XDG_DATA_HOME").ok(),
            home: std::env::var("HOME").ok(),
            userprofile: std::env::var("USERPROFILE").ok(),
        };
        let xdg_kai = tmp.join("xdg-home").join("kai");
        let _ = fs::create_dir_all(&xdg_kai);
        std::env::set_var("XDG_DATA_HOME", tmp.join("xdg-home"));
        // Point HOME/USERPROFILE at empty dirs so no real state leaks in.
        std::env::set_var("HOME", tmp.join("home-nowhere"));
        std::env::set_var("USERPROFILE", tmp.join("home-nowhere"));
        fs::write(
            xdg_kai.join("active_project.json"),
            r#"{"path":"/repo/xdg-demo","mode":"code"}"#,
        )
        .unwrap();
        let s = get_active_project();
        assert_eq!(s.path.as_deref(), Some("/repo/xdg-demo"));
        assert_eq!(s.mode, "code");
        let _ = fs::remove_dir_all(&tmp);
        restore_env(snap);
    }

    #[test]
    fn test_state_path_is_canonicalized_for_comparison() {
        // A valid-but-unclean path (`/./` segment) must come back
        // canonicalized so it textually matches shell-reported cwds.
        let _g = ENV_LOCK.lock().unwrap();
        clear_env();
        let tmp = std::env::temp_dir().join(format!("kai-ap-canon-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        let _ = fs::create_dir_all(&tmp);
        let _snap = isolate_home(&tmp);
        let messy = format!("{}/./", tmp.to_string_lossy());
        fs::write(
            tmp.join("active_project.json"),
            format!(r#"{{"path":{messy:?},"mode":"code"}}"#),
        )
        .unwrap();
        let s = get_active_project();
        assert_eq!(s.mode, "code");
        let got = s.path.expect("canonicalized path");
        assert!(
            !got.contains("/./"),
            "state path should be canonicalized, got: {got}"
        );
        // Canonical form still points at the same directory.
        assert!(std::path::Path::new(&got).is_dir());
        let _ = fs::remove_dir_all(&tmp);
        restore_env(_snap);
    }
}
