//! Lists "Kai Terminal" in the terminal dropdown of VS Code-family editors.
//!
//! VS Code, VS Code Insiders, VSCodium, Cursor and Windsurf build that dropdown
//! from `terminal.integrated.profiles.<os>` in the user's `settings.json`, so
//! Kai adds an entry there on startup. No extension, no command to run.
//!
//! The profile opens the user's normal shell with `KAI_TERMINAL=1`, the marker
//! Kai's own terminal sets and that `kai <agent>` & co. require. `TERM_PROGRAM`
//! is left alone so the editor's shell integration keeps working.
//!
//! Courtesy rules (this edits files the user owns):
//! - Only editors whose `User` folder already exists are touched.
//! - Each editor is offered the profile ONCE (recorded in `editor_profiles.json`
//!   under the Kai home), so deleting the entry sticks.
//! - `settings.json` is JSONC; edits keep every comment and other setting. A
//!   file that does not parse is left untouched (and retried next launch).
//! - The original is saved once as `settings.json.kai-backup`.
//! - `KAI_NO_EDITOR_PROFILE=1` turns the whole thing off.
//!
//! Paths are explicit parameters (no env reads inside the logic) so tests never
//! touch the real editors. Callers run it on a background thread; it never
//! panics (release builds use `panic = "abort"`).

use jsonc_parser::cst::{CstInputValue, CstRootNode};
use jsonc_parser::ParseOptions;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const PROFILE_NAME: &str = "Kai Terminal";
const STATE_FILE: &str = "editor_profiles.json";

/// Editor product folders that read `terminal.integrated.profiles.*`.
const PRODUCTS: [&str; 5] = ["Code", "Code - Insiders", "VSCodium", "Cursor", "Windsurf"];

/// `terminal.integrated.profiles.<this>` for the current OS.
fn platform_key() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "osx"
    } else {
        "linux"
    }
}

/// What happened for one editor.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    /// The profile was written.
    Added,
    /// Already offered before (or already present): left exactly as is.
    Skipped,
    /// The settings file could not be read or parsed: left untouched.
    Failed(String),
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct OfferedState {
    /// `settings.json` paths that were already offered the profile.
    #[serde(default)]
    offered: Vec<String>,
}

/// Root folder that holds each editor's `<product>/User` directory.
fn config_root() -> Option<PathBuf> {
    let var = |k: &str| std::env::var(k).ok().filter(|v| !v.trim().is_empty());
    if cfg!(target_os = "windows") {
        return var("APPDATA").map(PathBuf::from).or_else(|| {
            var("USERPROFILE").map(|u| PathBuf::from(u).join("AppData").join("Roaming"))
        });
    }
    if cfg!(target_os = "macos") {
        return var("HOME").map(|h| PathBuf::from(h).join("Library").join("Application Support"));
    }
    var("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| var("HOME").map(|h| PathBuf::from(h).join(".config")))
}

/// The profile entry for this OS.
fn profile_value() -> CstInputValue {
    let env = CstInputValue::Object(vec![(
        "KAI_TERMINAL".to_string(),
        CstInputValue::String("1".to_string()),
    )]);
    let mut props: Vec<(String, CstInputValue)> = Vec::new();
    if cfg!(target_os = "windows") {
        // PowerShell 7 when present, else Windows PowerShell (first that exists wins).
        props.push((
            "path".to_string(),
            CstInputValue::Array(vec![
                CstInputValue::String("pwsh.exe".to_string()),
                CstInputValue::String("powershell.exe".to_string()),
            ]),
        ));
    } else {
        let shell = std::env::var("SHELL")
            .ok()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| "/bin/bash".to_string());
        props.push(("path".to_string(), CstInputValue::String(shell)));
        if cfg!(target_os = "macos") {
            props.push((
                "args".to_string(),
                CstInputValue::Array(vec![CstInputValue::String("-l".to_string())]),
            ));
        }
    }
    props.push(("env".to_string(), env));
    props.push((
        "icon".to_string(),
        CstInputValue::String("terminal".to_string()),
    ));
    CstInputValue::Object(props)
}

/// Adds the profile to `text` (settings.json contents). `Ok(None)` = already
/// there, nothing to write; `Err` = the file is not safe to edit.
fn add_profile(text: &str) -> Result<Option<String>, String> {
    let base = if text.trim().is_empty() { "{}" } else { text };
    let root = CstRootNode::parse(base, &ParseOptions::default())
        .map_err(|e| format!("not valid JSON ({e})"))?;
    let top = root
        .object_value()
        .ok_or_else(|| "top level is not an object".to_string())?;
    let key = format!("terminal.integrated.profiles.{}", platform_key());
    let profiles = top
        .object_value_or_create(&key)
        .ok_or_else(|| format!("\"{key}\" is not an object"))?;
    if profiles.get(PROFILE_NAME).is_some() {
        return Ok(None);
    }
    profiles.append(PROFILE_NAME, profile_value());
    Ok(Some(root.to_string()))
}

/// Temp file + rename, keeping the user's original once as `*.kai-backup`.
fn write_settings(path: &Path, previous: &str, next: &str) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let backup = PathBuf::from(format!("{}.kai-backup", path.display()));
    if !previous.trim().is_empty() && !backup.exists() {
        std::fs::write(&backup, previous)?;
    }
    let tmp = PathBuf::from(format!("{}.kai-tmp-{}", path.display(), std::process::id()));
    std::fs::write(&tmp, next)?;
    std::fs::rename(&tmp, path).inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })
}

fn load_state(state_path: &Path) -> OfferedState {
    std::fs::read_to_string(state_path)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

fn save_state(state_path: &Path, state: &OfferedState) {
    if let Some(dir) = state_path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(text) = serde_json::to_string_pretty(state) {
        let _ = std::fs::write(state_path, text);
    }
}

/// Core: offer the profile to every installed editor under `config_root`.
/// Returns one `(product, outcome)` per installed editor.
fn offer_profiles(config_root: &Path, state_path: &Path) -> Vec<(String, Outcome)> {
    let mut state = load_state(state_path);
    let mut results = Vec::new();
    let mut state_changed = false;

    for product in PRODUCTS {
        let user_dir = config_root.join(product).join("User");
        if !user_dir.is_dir() {
            continue;
        }
        let settings = user_dir.join("settings.json");
        let id = settings.to_string_lossy().to_string();
        if state.offered.contains(&id) {
            results.push((product.to_string(), Outcome::Skipped));
            continue;
        }

        let text = match std::fs::read_to_string(&settings) {
            Ok(t) => t,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
            Err(e) => {
                results.push((product.to_string(), Outcome::Failed(e.to_string())));
                continue;
            }
        };
        let outcome = match add_profile(&text) {
            Ok(Some(next)) => match write_settings(&settings, &text, &next) {
                Ok(()) => Outcome::Added,
                Err(e) => Outcome::Failed(e.to_string()),
            },
            Ok(None) => Outcome::Skipped,
            Err(e) => Outcome::Failed(format!("{}: {e}", settings.display())),
        };
        // Offered (or already present): never touch this editor again, so a
        // profile the user later deletes stays deleted.
        if matches!(outcome, Outcome::Added | Outcome::Skipped) {
            state.offered.push(id);
            state_changed = true;
        }
        results.push((product.to_string(), outcome));
    }

    if state_changed {
        save_state(state_path, &state);
    }
    results
}

/// Kai home directory (`KAI_HOME` > `XDG_DATA_HOME/kai` > `~/.kai`).
fn kai_home() -> Option<PathBuf> {
    crate::active_project::candidate_home_dirs()
        .into_iter()
        .next()
}

/// Startup entry point: lists Kai in the installed editors' terminal dropdowns.
/// Best effort and silent; failures are returned for diagnostics only.
pub fn ensure_editor_terminal_profiles() -> Vec<(String, Outcome)> {
    if std::env::var("KAI_NO_EDITOR_PROFILE").is_ok_and(|v| v.trim() == "1") {
        return Vec::new();
    }
    let (Some(root), Some(home)) = (config_root(), kai_home()) else {
        return Vec::new();
    };
    offer_profiles(&root, &home.join(STATE_FILE))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "kai-editor-profile-{tag}-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn settings_of(root: &Path, product: &str) -> PathBuf {
        root.join(product).join("User").join("settings.json")
    }

    fn make_editor(root: &Path, product: &str, settings: Option<&str>) {
        std::fs::create_dir_all(root.join(product).join("User")).unwrap();
        if let Some(text) = settings {
            std::fs::write(settings_of(root, product), text).unwrap();
        }
    }

    #[test]
    fn creates_settings_for_a_fresh_editor() {
        let root = temp("fresh");
        let state = root.join("state.json");
        make_editor(&root, "Code", None);
        let out = offer_profiles(&root, &state);
        assert_eq!(out, vec![("Code".to_string(), Outcome::Added)]);
        let text = std::fs::read_to_string(settings_of(&root, "Code")).unwrap();
        let v: serde_json::Value = serde_json::from_str(&text).unwrap();
        let key = format!("terminal.integrated.profiles.{}", platform_key());
        assert_eq!(v[&key][PROFILE_NAME]["env"]["KAI_TERMINAL"], "1");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn keeps_comments_trailing_commas_and_other_profiles() {
        let root = temp("keep");
        let state = root.join("state.json");
        let key = format!("terminal.integrated.profiles.{}", platform_key());
        let original = format!(
            "{{\n  // my font\n  \"editor.fontSize\": 14,\n  \"{key}\": {{\n    \"Git Bash\": {{ \"path\": \"x\" }}, // mine\n  }},\n}}\n"
        );
        make_editor(&root, "Cursor", Some(&original));
        assert_eq!(
            offer_profiles(&root, &state),
            vec![("Cursor".to_string(), Outcome::Added)]
        );
        let path = settings_of(&root, "Cursor");
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("// my font") && text.contains("// mine"));
        assert!(text.contains("Git Bash") && text.contains(PROFILE_NAME));
        let backup = format!("{}.kai-backup", path.display());
        assert_eq!(std::fs::read_to_string(backup).unwrap(), original);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn offers_once_so_a_deleted_profile_stays_deleted() {
        let root = temp("once");
        let state = root.join("state.json");
        make_editor(&root, "Code", Some("{}"));
        assert_eq!(offer_profiles(&root, &state)[0].1, Outcome::Added);
        // The user deletes the entry; the next launch must not bring it back.
        std::fs::write(settings_of(&root, "Code"), "{}").unwrap();
        assert_eq!(offer_profiles(&root, &state)[0].1, Outcome::Skipped);
        assert_eq!(
            std::fs::read_to_string(settings_of(&root, "Code")).unwrap(),
            "{}"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn existing_kai_profile_is_left_alone() {
        let root = temp("existing");
        let state = root.join("state.json");
        let key = format!("terminal.integrated.profiles.{}", platform_key());
        let original =
            format!("{{ \"{key}\": {{ \"{PROFILE_NAME}\": {{ \"path\": \"mine\" }} }} }}");
        make_editor(&root, "Code", Some(&original));
        assert_eq!(offer_profiles(&root, &state)[0].1, Outcome::Skipped);
        assert_eq!(
            std::fs::read_to_string(settings_of(&root, "Code")).unwrap(),
            original
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn unparsable_or_oddly_shaped_settings_are_never_touched_and_are_retried() {
        let root = temp("bad");
        let state = root.join("state.json");
        make_editor(&root, "Code", Some("{ broken"));
        let key = format!("terminal.integrated.profiles.{}", platform_key());
        make_editor(&root, "Cursor", Some(&format!("{{ \"{key}\": [] }}")));
        make_editor(&root, "VSCodium", Some("[1, 2]"));
        let out = offer_profiles(&root, &state);
        assert_eq!(out.len(), 3);
        assert!(out.iter().all(|(_, o)| matches!(o, Outcome::Failed(_))));
        assert_eq!(
            std::fs::read_to_string(settings_of(&root, "Code")).unwrap(),
            "{ broken"
        );
        // Not marked as offered, so a fixed file is picked up next launch.
        assert!(!state.exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn only_installed_editors_are_touched() {
        let root = temp("installed");
        let state = root.join("state.json");
        make_editor(&root, "Windsurf", Some("{}"));
        let out = offer_profiles(&root, &state);
        assert_eq!(out, vec![("Windsurf".to_string(), Outcome::Added)]);
        assert!(!settings_of(&root, "Code").exists());
        assert!(!root.join("Code").exists());
        let _ = std::fs::remove_dir_all(&root);
    }
}
