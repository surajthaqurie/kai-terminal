use serde::{Deserialize, Serialize};
use std::path::Path;
use std::process::Command;
use std::time::Duration;

/// Optional git context for a working directory. All fields are None when git
/// is missing, the directory is not a repo, or any error occurs — callers
/// must treat that as normal and keep working.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GitInfo {
    pub branch: Option<String>,
    pub dirty: bool,
    pub ahead_behind: Option<String>,
    pub repo_root: Option<String>,
    pub error: Option<String>,
}

/// Returns git branch/status for `cwd` using the system `git` binary only.
/// Never scans the whole filesystem; only queries the given directory.
/// Timeout: 8s per git invocation. No shell is spawned.
pub fn get_git_info(cwd: &str) -> GitInfo {
    let trimmed = cwd.trim().trim_matches('"').trim_matches('\'');
    if trimmed.is_empty() || trimmed.len() > 4096 || trimmed.contains('\0') {
        return GitInfo {
            branch: None,
            dirty: false,
            ahead_behind: None,
            repo_root: None,
            error: Some("Invalid directory".to_string()),
        };
    }
    if !Path::new(trimmed).is_dir() {
        return GitInfo {
            branch: None,
            dirty: false,
            ahead_behind: None,
            repo_root: None,
            error: Some("Directory does not exist".to_string()),
        };
    }
    let branch_raw = run_git(trimmed, &["rev-parse", "--abbrev-ref", "HEAD"]);
    let branch = match branch_raw {
        None => {
            return GitInfo {
                branch: None,
                dirty: false,
                ahead_behind: None,
                repo_root: None,
                error: Some("Not a git repository or git is missing".to_string()),
            }
        }
        Some(b) if b == "HEAD" => {
            // Detached HEAD: report the short commit hash instead of a
            // bare "HEAD" so the badge stays informative. Uses
            // machine-readable plumbing output, not localized text.
            match run_git(trimmed, &["rev-parse", "--short", "HEAD"]) {
                Some(sha) => Some(format!("detached@{}", sha)),
                None => Some("detached HEAD".to_string()),
            }
        }
        Some(b) => Some(b),
    };
    let root = run_git(trimmed, &["rev-parse", "--show-toplevel"]);
    let status = run_git(trimmed, &["status", "--porcelain"]);
    let dirty = status.map(|s| !s.trim().is_empty()).unwrap_or(false);
    GitInfo {
        branch,
        dirty,
        ahead_behind: None,
        repo_root: root,
        error: None,
    }
}

/// Information about an individual changed file.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GitFileChange {
    pub path: String,
    pub status: String,
    pub staged: bool,
    pub old_path: Option<String>,
}

/// Structured summary of all changes in the git repository (working tree, staged, untracked).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GitChangesSummary {
    pub repo_root: String,
    pub branch: Option<String>,
    pub clean: bool,
    pub working_tree: Vec<GitFileChange>,
    pub staged: Vec<GitFileChange>,
    pub untracked: Vec<GitFileChange>,
    pub total_changes: usize,
}

/// Runs a safe, whitelisted git repository action (Phase D).
/// Supported actions: "fetch", "pull", "status", "status_porcelain", "diff", "diff_working", "diff_staged", "stage_all", "unstage_all".
/// Never uses shell string interpolation.
pub fn run_git_action(cwd: &str, action: &str) -> Result<String, String> {
    let info = get_git_info(cwd);
    if info.repo_root.is_none() {
        return Err("Not a valid git repository".to_string());
    }
    let repo_dir = info.repo_root.unwrap();
    let (args, allow_diff_exit): (&[&str], bool) = match action {
        "fetch" => (&["fetch", "--all", "--prune"], false),
        "pull" => (&["pull", "--ff-only"], false),
        "status" => (&["status", "--short"], false),
        "status_porcelain" => (&["status", "--porcelain=v1", "-uall"], false),
        "diff" => (&["diff", "HEAD"], true),
        "diff_working" => (&["diff"], true),
        "diff_staged" => (&["diff", "--cached"], true),
        "stage_all" => (&["add", "-A"], false),
        "unstage_all" => (&["restore", "--staged", "."], false),
        _ => return Err(format!("Unsupported git action '{}'", action)),
    };
    run_git_bounded(&repo_dir, args, 1_000_000, allow_diff_exit)
        .ok_or_else(|| format!("Git action '{}' failed", action))
}

fn validate_repo_rel_path<'a>(repo_root: &str, rel_path: &'a str) -> Result<&'a str, String> {
    let trimmed = rel_path.trim().trim_matches('"').trim_matches('\'');
    if trimmed.is_empty() || trimmed.starts_with('-') || trimmed.contains('\0') {
        return Err("Invalid file path".to_string());
    }
    // Prevent directory traversal outside repo root
    let full = Path::new(repo_root).join(trimmed);
    let canonical_root =
        std::fs::canonicalize(repo_root).unwrap_or_else(|_| Path::new(repo_root).to_path_buf());
    if let Ok(c) = std::fs::canonicalize(&full) {
        if !c.starts_with(&canonical_root) {
            return Err("Path escapes repository root".to_string());
        }
    } else if trimmed.contains("..") {
        return Err("Invalid relative path".to_string());
    }
    Ok(trimmed)
}

/// Retrieves git diff for the repository or a specific file (staged or unstaged).
pub fn get_git_diff(cwd: &str, rel_path: Option<&str>, staged: bool) -> Result<String, String> {
    let info = get_git_info(cwd);
    let repo_dir = info.repo_root.ok_or("Not a valid git repository")?;

    if let Some(path) = rel_path {
        let valid_path = validate_repo_rel_path(&repo_dir, path)?;
        if staged {
            let res = run_git_bounded(
                &repo_dir,
                &["diff", "--cached", "--", valid_path],
                1_000_000,
                true,
            );
            return Ok(res.unwrap_or_default());
        }
        // Try normal unstaged diff
        let res = run_git_bounded(&repo_dir, &["diff", "--", valid_path], 1_000_000, true);
        if let Some(d) = res {
            if !d.is_empty() {
                return Ok(d);
            }
        }
        // If empty, check if untracked by diffing with /dev/null
        let full_path = Path::new(&repo_dir).join(valid_path);
        if full_path.is_file() {
            let no_index_res = run_git_bounded(
                &repo_dir,
                &["diff", "--no-index", "--", "/dev/null", valid_path],
                1_000_000,
                true,
            );
            if let Some(d) = no_index_res {
                if !d.is_empty() {
                    return Ok(d);
                }
            }
        }
        // Fallback to diff HEAD
        let head_res = run_git_bounded(
            &repo_dir,
            &["diff", "HEAD", "--", valid_path],
            1_000_000,
            true,
        );
        Ok(head_res.unwrap_or_default())
    } else if staged {
        let res = run_git_bounded(&repo_dir, &["diff", "--cached"], 1_000_000, true);
        Ok(res.unwrap_or_default())
    } else {
        let res = run_git_bounded(&repo_dir, &["diff"], 1_000_000, true);
        Ok(res.unwrap_or_default())
    }
}

/// Retrieves structured changes list (working tree, staged, untracked).
pub fn get_git_changes(cwd: &str) -> Result<GitChangesSummary, String> {
    let info = get_git_info(cwd);
    let repo_dir = info.repo_root.ok_or("Not a valid git repository")?;
    let status_out = run_git_bounded(
        &repo_dir,
        &["status", "--porcelain=v1", "-uall"],
        1_000_000,
        false,
    )
    .unwrap_or_default();

    let mut working_tree = Vec::new();
    let mut staged = Vec::new();
    let mut untracked = Vec::new();

    for line in status_out.lines() {
        let trimmed = line.trim_end();
        if trimmed.len() < 4 {
            continue;
        }
        let bytes = trimmed.as_bytes();
        let x = bytes[0] as char;
        let y = bytes[1] as char;
        let raw_path = trimmed[3..].trim();
        let (path, old_path) = if let Some(idx) = raw_path.find(" -> ") {
            (
                raw_path[idx + 4..].to_string(),
                Some(raw_path[..idx].to_string()),
            )
        } else {
            (raw_path.to_string(), None)
        };

        if x == '?' && y == '?' {
            untracked.push(GitFileChange {
                path,
                status: "U".to_string(),
                staged: false,
                old_path: None,
            });
            continue;
        }

        if x != ' ' && x != '?' {
            staged.push(GitFileChange {
                path: path.clone(),
                status: x.to_string(),
                staged: true,
                old_path: old_path.clone(),
            });
        }

        if y != ' ' && y != '?' {
            working_tree.push(GitFileChange {
                path,
                status: y.to_string(),
                staged: false,
                old_path,
            });
        }
    }

    let total = working_tree.len() + staged.len() + untracked.len();
    Ok(GitChangesSummary {
        repo_root: repo_dir,
        branch: info.branch,
        clean: total == 0,
        working_tree,
        staged,
        untracked,
        total_changes: total,
    })
}

/// Stages a specific file in the repository.
pub fn stage_git_file(cwd: &str, rel_path: &str) -> Result<String, String> {
    let info = get_git_info(cwd);
    let repo_dir = info.repo_root.ok_or("Not a valid git repository")?;
    let valid_path = validate_repo_rel_path(&repo_dir, rel_path)?;
    run_git_bounded(&repo_dir, &["add", "--", valid_path], 4096, false)
        .ok_or_else(|| format!("Failed to stage '{}'", valid_path))
}

/// Unstages a specific file in the repository.
pub fn unstage_git_file(cwd: &str, rel_path: &str) -> Result<String, String> {
    let info = get_git_info(cwd);
    let repo_dir = info.repo_root.ok_or("Not a valid git repository")?;
    let valid_path = validate_repo_rel_path(&repo_dir, rel_path)?;
    // Try restore --staged first, fallback to reset HEAD
    if let Some(res) = run_git_bounded(
        &repo_dir,
        &["restore", "--staged", "--", valid_path],
        4096,
        false,
    ) {
        return Ok(res);
    }
    run_git_bounded(&repo_dir, &["reset", "HEAD", "--", valid_path], 4096, false)
        .ok_or_else(|| format!("Failed to unstage '{}'", valid_path))
}

/// Discards uncommitted changes to a file (restoring tracked file or removing untracked file).
pub fn discard_git_file(cwd: &str, rel_path: &str) -> Result<String, String> {
    let info = get_git_info(cwd);
    let repo_dir = info.repo_root.ok_or("Not a valid git repository")?;
    let valid_path = validate_repo_rel_path(&repo_dir, rel_path)?;
    let full = Path::new(&repo_dir).join(valid_path);

    // If file is untracked, remove it from disk safely within repo_root
    let status_out = run_git_bounded(
        &repo_dir,
        &["status", "--porcelain=v1", "--", valid_path],
        4096,
        false,
    )
    .unwrap_or_default();
    if status_out.starts_with("??") {
        if full.is_file() {
            std::fs::remove_file(&full)
                .map_err(|e| format!("Failed to delete untracked file: {}", e))?;
            return Ok(format!("Removed {}", valid_path));
        } else if full.is_dir() {
            std::fs::remove_dir_all(&full)
                .map_err(|e| format!("Failed to delete untracked directory: {}", e))?;
            return Ok(format!("Removed {}", valid_path));
        }
    }

    // Tracked file: restore working copy
    if let Some(res) = run_git_bounded(&repo_dir, &["restore", "--", valid_path], 4096, false) {
        return Ok(res);
    }
    run_git_bounded(
        &repo_dir,
        &["checkout", "HEAD", "--", valid_path],
        4096,
        false,
    )
    .ok_or_else(|| format!("Failed to discard changes in '{}'", valid_path))
}

fn run_git(cwd: &str, args: &[&str]) -> Option<String> {
    run_git_bounded(cwd, args, 512, false)
}

fn run_git_bounded(
    cwd: &str,
    args: &[&str],
    max_chars: usize,
    allow_diff_exit: bool,
) -> Option<String> {
    let (tx, rx) = std::sync::mpsc::channel();
    let cwd_owned = cwd.to_string();
    let args_owned: Vec<String> = args.iter().map(|s| s.to_string()).collect();
    std::thread::spawn(move || {
        let out = Command::new("git")
            .current_dir(&cwd_owned)
            .args(&args_owned)
            .output();
        let _ = tx.send(out);
    });
    let output = rx.recv_timeout(Duration::from_secs(8)).ok()?.ok()?;
    let success = output.status.success() || (allow_diff_exit && output.status.code() == Some(1));
    if !success {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let trimmed = text.trim_end();
    if trimmed.is_empty() {
        Some(String::new())
    } else {
        Some(trimmed.chars().take(max_chars).collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_invalid_dir_returns_error_not_panic() {
        let info = get_git_info("/non_existent_dir_xyz_9999");
        assert!(info.branch.is_none());
        assert!(info.error.is_some());
    }

    #[test]
    fn test_tmp_dir_is_not_repo_or_returns_gracefully() {
        let dir = std::env::temp_dir().to_string_lossy().to_string();
        let info = get_git_info(&dir);
        // Must not panic; either error or valid branch.
        assert!(info.branch.is_none() || info.branch.is_some());
    }

    #[test]
    fn test_run_git_action_validation() {
        assert!(run_git_action("/non_existent_dir_xyz", "status").is_err());
        let current = std::env::current_dir()
            .unwrap()
            .to_string_lossy()
            .to_string();
        assert!(run_git_action(&current, "invalid_action").is_err());
    }

    fn git_available() -> bool {
        std::process::Command::new("git")
            .arg("--version")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    fn init_repo_with_commit(dir: &std::path::Path) {
        let run = |args: &[&str]| {
            std::process::Command::new("git")
                .current_dir(dir)
                .args(args)
                .output()
                .expect("git command")
        };
        assert!(run(&["init"]).status.success());
        assert!(run(&["config", "user.email", "t@t.t"]).status.success());
        assert!(run(&["config", "user.name", "t"]).status.success());
        assert!(run(&["config", "core.autocrlf", "false"]).status.success());
        std::fs::write(dir.join("f.txt"), "hello\n").unwrap();
        assert!(run(&["add", "f.txt"]).status.success());
        assert!(run(&["commit", "-m", "init"]).status.success());
    }

    #[test]
    fn test_branch_dirty_and_detached_head() {
        if !git_available() {
            return;
        }
        let base = std::env::temp_dir().join(format!("kai-git-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        init_repo_with_commit(&base);
        let dir = base.to_string_lossy().to_string();

        // Clean tree on a branch.
        let clean = get_git_info(&dir);
        assert!(clean.error.is_none());
        assert!(clean.branch.is_some());
        assert!(!clean.dirty);

        // Untracked file => dirty.
        std::fs::write(base.join("new.txt"), "x").unwrap();
        assert!(get_git_info(&dir).dirty);
        std::fs::remove_file(base.join("new.txt")).unwrap();

        // Modified tracked file => dirty.
        std::fs::write(base.join("f.txt"), "changed\n").unwrap();
        assert!(get_git_info(&dir).dirty);
        // Restore.
        std::process::Command::new("git")
            .current_dir(&base)
            .args(["checkout", "--", "f.txt"])
            .output()
            .unwrap();

        // Deleted tracked file => dirty.
        std::fs::remove_file(base.join("f.txt")).unwrap();
        assert!(get_git_info(&dir).dirty);

        // Detached HEAD reports detached@sha, not bare HEAD.
        std::process::Command::new("git")
            .current_dir(&base)
            .args(["checkout", "--detach", "HEAD"])
            .output()
            .unwrap();
        let det = get_git_info(&dir);
        let b = det.branch.expect("branch in detached HEAD");
        assert!(
            b.starts_with("detached@") || b == "detached HEAD",
            "unexpected detached branch label: {}",
            b
        );

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn test_large_repo_status_is_bounded() {
        if !git_available() {
            return;
        }
        let cwd = std::env::current_dir()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let info = get_git_info(&cwd);
        // Must not panic and branch strings stay bounded.
        if let Some(b) = info.branch {
            assert!(b.len() <= 512);
        }
    }

    #[test]
    fn test_git_changes_and_diff_lifecycle() {
        if !git_available() {
            return;
        }
        let base = std::env::temp_dir().join(format!("kai-git-lifecycle-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        init_repo_with_commit(&base);
        let dir = base.to_string_lossy().to_string();

        // 1. Initially clean
        let initial = get_git_changes(&dir).expect("get_git_changes");
        assert!(initial.clean);
        assert_eq!(initial.total_changes, 0);

        // 2. Add an untracked file and modify existing file
        std::fs::write(base.join("untracked.txt"), "hello untracked\n").unwrap();
        std::fs::write(base.join("f.txt"), "modified f content\n").unwrap();

        let changes = get_git_changes(&dir).expect("get_git_changes after edit");
        assert!(!changes.clean);
        assert_eq!(changes.total_changes, 2);
        assert_eq!(changes.untracked.len(), 1);
        assert_eq!(changes.working_tree.len(), 1);

        // 3. Diff for modified file contains modified content
        let diff = get_git_diff(&dir, Some("f.txt"), false).expect("get_git_diff");
        assert!(diff.contains("modified f content"));

        // 4. Diff for untracked file contains new content
        let untracked_diff =
            get_git_diff(&dir, Some("untracked.txt"), false).expect("untracked diff");
        assert!(untracked_diff.contains("hello untracked"));

        // 5. Stage modified file
        stage_git_file(&dir, "f.txt").expect("stage f.txt");
        let staged_changes = get_git_changes(&dir).expect("changes after staging");
        assert_eq!(staged_changes.staged.len(), 1);

        // 6. Unstage file
        unstage_git_file(&dir, "f.txt").expect("unstage f.txt");
        let unstaged_changes = get_git_changes(&dir).expect("changes after unstaging");
        assert_eq!(unstaged_changes.staged.len(), 0);
        assert_eq!(unstaged_changes.working_tree.len(), 1);

        // 7. Discard changes on modified file
        discard_git_file(&dir, "f.txt").expect("discard f.txt");
        assert_eq!(
            std::fs::read_to_string(base.join("f.txt"))
                .unwrap()
                .replace("\r\n", "\n"),
            "hello\n"
        );

        // 8. Discard untracked file removes it
        discard_git_file(&dir, "untracked.txt").expect("discard untracked");
        assert!(!base.join("untracked.txt").exists());

        // 9. Clean again
        let final_changes = get_git_changes(&dir).expect("final changes");
        assert!(final_changes.clean);

        let _ = std::fs::remove_dir_all(&base);
    }
}
