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

    let home = if let Some(h) = kai_home_override {
        h.to_path_buf()
    } else {
        match std::env::var("KAI_HOME") {
            Ok(h) => PathBuf::from(h),
            Err(_) => match std::env::var("HOME") {
                Ok(h) => PathBuf::from(h).join(".kai"),
                Err(_) => match std::env::var("USERPROFILE") {
                    Ok(u) => PathBuf::from(u).join(".kai"),
                    Err(_) => {
                        return ProjectIntelligenceSummary {
                            status: "unindexed".to_string(),
                            ..Default::default()
                        }
                    }
                },
            },
        }
    };

    let projects_dir = home.join("projects");
    if !projects_dir.is_dir() {
        return ProjectIntelligenceSummary {
            status: "unindexed".to_string(),
            ..Default::default()
        };
    }

    if let Ok(entries) = fs::read_dir(projects_dir) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_dir() {
                let meta_path = p.join("meta.json");
                if let Ok(content) = fs::read_to_string(&meta_path) {
                    if let Ok(meta) = serde_json::from_str::<MetaJson>(&content) {
                        if let Some(cp) = meta.canonical_path {
                            if cp == canonical {
                                let mut total_tokens = 0;
                                let index_path = p.join("index.json");
                                if let Ok(idx_content) = fs::read_to_string(&index_path) {
                                    if let Ok(idx) = serde_json::from_str::<IndexJson>(&idx_content)
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

        let meta_json = format!(
            r#"{{"status":"ready","canonicalPath":"{}","fileCount":42,"symbolCount":128,"lastIndexedAt":"2026-10-11T00:00:00Z"}}"#,
            canonical_repo
        );
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
}
