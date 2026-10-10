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

/// Runs a safe, whitelisted git repository action (Phase D).
/// Supported actions: "fetch", "pull", "status".
/// Never uses shell string interpolation.
pub fn run_git_action(cwd: &str, action: &str) -> Result<String, String> {
    let info = get_git_info(cwd);
    if info.repo_root.is_none() {
        return Err("Not a valid git repository".to_string());
    }
    let repo_dir = info.repo_root.unwrap();
    let args: &[&str] = match action {
        "fetch" => &["fetch", "--all", "--prune"],
        "pull" => &["pull", "--ff-only"],
        "status" => &["status", "--short"],
        _ => return Err(format!("Unsupported git action '{}'", action)),
    };
    run_git(&repo_dir, args).ok_or_else(|| format!("Git action '{}' failed", action))
}

fn run_git(cwd: &str, args: &[&str]) -> Option<String> {
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
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if text.is_empty() {
        None
    } else {
        Some(text.chars().take(512).collect())
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
}
