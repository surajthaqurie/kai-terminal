use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct ProjectIntelligenceSummary {
    pub status: String,
    pub file_count: usize,
    pub symbol_count: usize,
    pub total_tokens_estimated: usize,
    pub last_indexed_at: Option<String>,
}

#[derive(Deserialize, Debug)]
struct MetaJson {
    #[serde(rename = "status")]
    pub status: Option<String>,
    #[serde(rename = "canonicalPath")]
    pub canonical_path: Option<String>,
    #[serde(rename = "fileCount")]
    pub file_count: Option<usize>,
    #[serde(rename = "symbolCount")]
    pub symbol_count: Option<usize>,
    #[serde(rename = "lastIndexedAt")]
    pub last_indexed_at: Option<String>,
}

#[derive(Deserialize, Debug)]
struct IndexJson {
    #[serde(rename = "totalTokensEstimated")]
    pub total_tokens_estimated: Option<usize>,
}

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

fn normalize_canonical_for_compare(p: &str) -> String {
    let mut s = p.to_string();
    if let Some(stripped) = s.strip_prefix(r"\\?\UNC\") {
        s = format!(r"\\{stripped}");
    } else if let Some(stripped) = s.strip_prefix(r"\\?\") {
        s = stripped.to_string();
    }
    s = s.replace('\\', "/");
    while s.len() > 1 && s.ends_with('/') {
        s.pop();
    }
    #[cfg(any(windows, target_os = "macos"))]
    {
        s.to_lowercase()
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        s
    }
}

pub fn get_project_intelligence(cwd: &str) -> ProjectIntelligenceSummary {
    get_project_intelligence_internal(cwd, None)
}

pub fn get_project_intelligence_internal(
    cwd: &str,
    kai_home_override: Option<&Path>,
) -> ProjectIntelligenceSummary {
    let canonical = match fs::canonicalize(Path::new(cwd)) {
        Ok(c) => c.to_string_lossy().to_string(),
        Err(_) => cwd.to_string(),
    };

    let homes: Vec<PathBuf> = if let Some(h) = kai_home_override {
        vec![h.to_path_buf()]
    } else {
        candidate_home_dirs()
    };

    for home in homes {
        let projects_dir = home.join("projects");
        if !projects_dir.is_dir() {
            continue;
        }

        if let Ok(entries) = fs::read_dir(projects_dir) {
            for entry in entries.flatten() {
                let p = entry.path();
                if p.is_dir() {
                    let meta_path = p.join("meta.json");
                    if let Ok(content) = fs::read_to_string(&meta_path) {
                        if let Ok(meta) = serde_json::from_str::<MetaJson>(&content) {
                            if let Some(cp) = meta.canonical_path {
                                if normalize_canonical_for_compare(&cp)
                                    == normalize_canonical_for_compare(&canonical)
                                {
                                    let mut total_tokens = 0;
                                    let index_path = p.join("index.json");
                                    if let Ok(idx_content) = fs::read_to_string(&index_path) {
                                        if let Ok(idx) =
                                            serde_json::from_str::<IndexJson>(&idx_content)
                                        {
                                            total_tokens = idx.total_tokens_estimated.unwrap_or(0);
                                        }
                                    }

                                    return ProjectIntelligenceSummary {
                                        status: meta.status.unwrap_or_else(|| "ready".to_string()),
                                        file_count: meta.file_count.unwrap_or(0),
                                        symbol_count: meta.symbol_count.unwrap_or(0),
                                        total_tokens_estimated: total_tokens,
                                        last_indexed_at: meta.last_indexed_at,
                                    };
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    ProjectIntelligenceSummary {
        status: "unindexed".to_string(),
        ..Default::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn test_unindexed_directory_returns_unindexed_status() {
        let summary = get_project_intelligence("/non/existent/path/xyz123");
        assert_eq!(summary.status, "unindexed");
        assert_eq!(summary.file_count, 0);
        assert_eq!(summary.symbol_count, 0);
    }

    #[test]
    fn test_reads_existing_project_meta_and_tokens() {
        let temp_path =
            std::env::temp_dir().join(format!("kai_test_intel_{}", uuid::Uuid::new_v4()));
        let _ = fs::create_dir_all(&temp_path);

        let test_kai_home = temp_path.join(".kai");
        let proj_dir = test_kai_home.join("projects").join("sample_id");
        fs::create_dir_all(&proj_dir).unwrap();

        let target_repo = temp_path.join("my_repo");
        fs::create_dir_all(&target_repo).unwrap();
        let canonical_repo = fs::canonicalize(&target_repo)
            .unwrap()
            .to_string_lossy()
            .to_string();

        let meta_json = serde_json::json!({
            "status": "ready",
            "canonicalPath": canonical_repo,
            "fileCount": 42,
            "symbolCount": 128,
            "lastIndexedAt": "2026-10-11T00:00:00Z"
        })
        .to_string();
        fs::write(proj_dir.join("meta.json"), meta_json).unwrap();
        fs::write(
            proj_dir.join("index.json"),
            r#"{"totalTokensEstimated":15420}"#,
        )
        .unwrap();

        let summary =
            get_project_intelligence_internal(target_repo.to_str().unwrap(), Some(&test_kai_home));

        assert_eq!(summary.status, "ready");
        assert_eq!(summary.file_count, 42);
        assert_eq!(summary.symbol_count, 128);
        assert_eq!(summary.total_tokens_estimated, 15420);
        assert_eq!(
            summary.last_indexed_at,
            Some("2026-10-11T00:00:00Z".to_string())
        );

        let _ = fs::remove_dir_all(&temp_path);
    }

    #[test]
    fn test_verbatim_prefix_mismatch_still_matches() {
        // Rust canonicalize() returns `\\?\C:\...` verbatim paths on Windows
        // while Node's realpathSync() (which writes meta.json) returns `C:\...`.
        // Normalization must bridge the two forms.
        assert_eq!(
            normalize_canonical_for_compare(r"\\?\C:\Users\Runner\repo"),
            normalize_canonical_for_compare(r"C:\Users\Runner\repo")
        );
        assert_eq!(
            normalize_canonical_for_compare(r"\\?\UNC\server\share"),
            normalize_canonical_for_compare(r"\\server\share")
        );
        assert_eq!(
            normalize_canonical_for_compare("/home/user/project/"),
            normalize_canonical_for_compare("/home/user/project")
        );
    }

    #[test]
    fn test_candidate_homes_include_xdg_data_home() {
        let temp_path = std::env::temp_dir().join(format!("kai_test_xdg_{}", uuid::Uuid::new_v4()));
        let xdg_dir = temp_path.join("xdg_share");
        let kai_xdg = xdg_dir.join("kai");
        let proj_dir = kai_xdg.join("projects").join("xdg_sample");
        fs::create_dir_all(&proj_dir).unwrap();

        let target_repo = temp_path.join("xdg_repo");
        fs::create_dir_all(&target_repo).unwrap();
        let canonical_repo = fs::canonicalize(&target_repo)
            .unwrap()
            .to_string_lossy()
            .to_string();

        let meta_json = serde_json::json!({
            "status": "ready",
            "canonicalPath": canonical_repo,
            "fileCount": 10,
            "symbolCount": 25,
            "lastIndexedAt": "2026-10-12T00:00:00Z"
        })
        .to_string();
        fs::write(proj_dir.join("meta.json"), meta_json).unwrap();

        std::env::set_var("XDG_DATA_HOME", &xdg_dir);
        let summary = get_project_intelligence(target_repo.to_str().unwrap());
        std::env::remove_var("XDG_DATA_HOME");

        assert_eq!(summary.status, "ready");
        assert_eq!(summary.file_count, 10);
        assert_eq!(summary.symbol_count, 25);

        let _ = fs::remove_dir_all(&temp_path);
    }
}
