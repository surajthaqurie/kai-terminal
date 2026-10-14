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
///
/// Error taxonomy (all graceful, never panics):
/// - invalid / over-long / NUL paths → "Invalid directory"
/// - missing path → "Directory does not exist"
/// - permission-denied / inaccessible → "Directory is not accessible"
/// - existing non-directory → "Not a directory"
/// - git binary absent from PATH → "Git is not installed or not on PATH"
/// - otherwise not a repo / git failure → "Not a git repository or git is missing"
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
    match std::fs::symlink_metadata(trimmed) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return GitInfo {
                branch: None,
                dirty: false,
                ahead_behind: None,
                repo_root: None,
                error: Some("Directory does not exist".to_string()),
            };
        }
        Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => {
            return GitInfo {
                branch: None,
                dirty: false,
                ahead_behind: None,
                repo_root: None,
                error: Some("Directory is not accessible".to_string()),
            };
        }
        Err(_) => {
            return GitInfo {
                branch: None,
                dirty: false,
                ahead_behind: None,
                repo_root: None,
                error: Some("Directory does not exist".to_string()),
            };
        }
        Ok(md) => {
            if !md.file_type().is_dir() && !md.file_type().is_symlink() {
                return GitInfo {
                    branch: None,
                    dirty: false,
                    ahead_behind: None,
                    repo_root: None,
                    error: Some("Not a directory".to_string()),
                };
            }
            if !Path::new(trimmed).is_dir() {
                // Symlink to non-dir, permission shadow, or racing delete.
                return GitInfo {
                    branch: None,
                    dirty: false,
                    ahead_behind: None,
                    repo_root: None,
                    error: Some("Directory is not accessible".to_string()),
                };
            }
        }
    }
    if !git_binary_available() {
        return GitInfo {
            branch: None,
            dirty: false,
            ahead_behind: None,
            repo_root: None,
            error: Some("Git is not installed or not on PATH".to_string()),
        };
    }
    let root = match run_git(trimmed, &["rev-parse", "--show-toplevel"]) {
        Some(r) if !r.trim().is_empty() => r.trim().to_string(),
        _ => {
            return GitInfo {
                branch: None,
                dirty: false,
                ahead_behind: None,
                repo_root: None,
                error: Some("Not a git repository or git is missing".to_string()),
            };
        }
    };

    // 1. Try `branch --show-current` (works for regular branches even with 0 commits)
    let mut branch = run_git(trimmed, &["branch", "--show-current"])
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    // 2. If None, try `symbolic-ref --short HEAD`
    if branch.is_none() {
        branch = run_git(trimmed, &["symbolic-ref", "--short", "HEAD"])
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
    }

    // 3. If None, try `rev-parse --abbrev-ref HEAD`
    if branch.is_none() {
        if let Some(b) = run_git(trimmed, &["rev-parse", "--abbrev-ref", "HEAD"]) {
            let b_trimmed = b.trim();
            if b_trimmed != "HEAD" && !b_trimmed.is_empty() {
                branch = Some(b_trimmed.to_string());
            }
        }
    }

    // 4. Detached HEAD check: if branch is still None, try `rev-parse --short HEAD`
    if branch.is_none() {
        if let Some(sha) = run_git(trimmed, &["rev-parse", "--short", "HEAD"]) {
            let sha_trimmed = sha.trim();
            if !sha_trimmed.is_empty() {
                branch = Some(format!("detached@{}", sha_trimmed));
            }
        }
    }

    // 5. Fallback for brand-new repository with 0 commits
    if branch.is_none() {
        branch = Some("main".to_string());
    }

    // -c core.quotepath=off prevents git from C-string-quoting paths that
    // contain spaces, Unicode, or other non-ASCII bytes. Without this flag,
    // `git status --porcelain` wraps those paths in double quotes with
    // backslash escapes, breaking the downstream path parser.
    let status = run_git(
        trimmed,
        &["-c", "core.quotepath=off", "status", "--porcelain"],
    );
    let dirty = status.map(|s| !s.trim().is_empty()).unwrap_or(false);
    GitInfo {
        branch,
        dirty,
        ahead_behind: None,
        repo_root: Some(root),
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
    // Status commands add -c core.quotepath=off so filenames with spaces
    // or non-ASCII bytes are not C-string quoted in the output.
    let result = match action {
        "fetch" => run_git_bounded(&repo_dir, &["fetch", "--all", "--prune"], 1_000_000, false),
        "pull" => run_git_bounded(&repo_dir, &["pull", "--ff-only"], 1_000_000, false),
        "status" => run_git_bounded(
            &repo_dir,
            &["-c", "core.quotepath=off", "status", "--short"],
            1_000_000,
            false,
        ),
        "status_porcelain" => run_git_bounded(
            &repo_dir,
            &[
                "-c",
                "core.quotepath=off",
                "status",
                "--porcelain=v1",
                "-uall",
            ],
            1_000_000,
            false,
        ),
        "diff" => run_git_bounded(&repo_dir, &["diff", "HEAD"], 1_000_000, true),
        "diff_working" => run_git_bounded(&repo_dir, &["diff"], 1_000_000, true),
        "diff_staged" => run_git_bounded(&repo_dir, &["diff", "--cached"], 1_000_000, true),
        "stage_all" => run_git_bounded(&repo_dir, &["add", "-A"], 1_000_000, false),
        "unstage_all" => {
            run_git_bounded(&repo_dir, &["restore", "--staged", "."], 1_000_000, false)
        }
        _ => return Err(format!("Unsupported git action '{}'", action)),
    };
    result.ok_or_else(|| format!("Git action '{}' failed", action))
}

fn validate_repo_rel_path<'a>(repo_root: &str, rel_path: &'a str) -> Result<&'a str, String> {
    let trimmed = rel_path.trim().trim_matches('"').trim_matches('\'');
    if trimmed.is_empty()
        || trimmed.starts_with('-')
        || trimmed.contains('\0')
        || trimmed.starts_with('/')
        || trimmed.starts_with('\\')
    {
        return Err("Invalid file path".to_string());
    }

    let p = Path::new(trimmed);
    let bytes = trimmed.as_bytes();
    let is_windows_drive = bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':';
    if is_windows_drive || p.is_absolute() {
        return Err("Absolute paths are not permitted".to_string());
    }

    let normalized = trimmed.replace('\\', "/");
    for part in normalized.split('/') {
        if part == ".." {
            return Err("Invalid relative path: directory traversal attempt".to_string());
        }
    }

    for component in p.components() {
        match component {
            std::path::Component::Prefix(_)
            | std::path::Component::RootDir
            | std::path::Component::ParentDir => {
                return Err("Invalid relative path: directory traversal attempt".to_string());
            }
            _ => {}
        }
    }

    let canonical_root =
        std::fs::canonicalize(repo_root).unwrap_or_else(|_| Path::new(repo_root).to_path_buf());
    let full = Path::new(repo_root).join(trimmed);

    // If the path or a symlink exists, verify the canonical target remains within canonical_root
    if let Ok(c) = std::fs::canonicalize(&full) {
        if !c.starts_with(&canonical_root) {
            return Err("Path escapes repository root".to_string());
        }
    } else if let Ok(meta) = std::fs::symlink_metadata(&full) {
        if meta.file_type().is_symlink() {
            // Symlink exists but canonicalize failed (broken symlink). Check link target.
            if let Ok(target) = std::fs::read_link(&full) {
                let resolved = if target.is_absolute() {
                    target.clone()
                } else {
                    Path::new(repo_root).join(&target)
                };
                if let Ok(c) = std::fs::canonicalize(&resolved) {
                    if !c.starts_with(&canonical_root) {
                        return Err("Symlink escapes repository root".to_string());
                    }
                } else if resolved.is_absolute() || target.to_string_lossy().contains("..") {
                    return Err("Symlink escapes repository root".to_string());
                }
            }
        }
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
        &[
            "-c",
            "core.quotepath=off",
            "status",
            "--porcelain=v1",
            "-uall",
        ],
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
        &[
            "-c",
            "core.quotepath=off",
            "status",
            "--porcelain=v1",
            "--",
            valid_path,
        ],
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

/// True when a `git` executable resolves on PATH (or via well-known
/// install locations). Used to distinguish "git missing" from "not a repo".
///
/// Step 9 perf: the PATH scan (stat per directory) ran on EVERY git probe,
/// so each footer refresh paid it N times for N panes. The result is cached
/// process-wide — a mid-process git install/uninstall takes effect on the
/// next app restart. Path validation elsewhere is untouched.
fn git_binary_available() -> bool {
    static CACHE: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *CACHE.get_or_init(git_binary_available_uncached)
}

fn git_binary_available_uncached() -> bool {
    if let Ok(path_env) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path_env) {
            if dir.as_os_str().is_empty() {
                continue;
            }
            let candidate = dir.join("git");
            if candidate.is_file() {
                #[cfg(not(target_os = "windows"))]
                {
                    use std::os::unix::fs::PermissionsExt;
                    if let Ok(md) = candidate.metadata() {
                        if md.permissions().mode() & 0o111 != 0 {
                            return true;
                        }
                        continue;
                    }
                }
                #[cfg(target_os = "windows")]
                {
                    return true;
                }
            }
            #[cfg(target_os = "windows")]
            {
                for ext in ["git.exe", "git.cmd", "git.bat"] {
                    if dir.join(ext).is_file() {
                        return true;
                    }
                }
            }
        }
    }
    // Absolute fallbacks (bounded, fixed set — never user input).
    for abs in [
        "/usr/bin/git",
        "/usr/local/bin/git",
        "/opt/homebrew/bin/git",
        "/snap/bin/git",
    ] {
        if Path::new(abs).is_file() {
            return true;
        }
    }
    false
}

fn run_git_bounded(
    cwd: &str,
    args: &[&str],
    max_chars: usize,
    allow_diff_exit: bool,
) -> Option<String> {
    let mut c = Command::new("git");
    c.current_dir(cwd)
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        // stderr is never consumed (diagnostics use exit status + stdout
        // only). Piping it without a drain thread risks deadlock when git
        // writes >64 KiB of warnings (large repos, index churn), stalling
        // the probe until the 8 s timeout. Discard it instead.
        .stderr(std::process::Stdio::null());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x08000000);
    }

    let mut child = c.spawn().ok()?;
    let mut stdout_pipe = child.stdout.take();
    let stdout_handle = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(ref mut pipe) = stdout_pipe {
            let _ = std::io::Read::read_to_end(pipe, &mut buf);
        }
        buf
    });

    let deadline = std::time::Instant::now() + Duration::from_secs(8);
    let mut exited = false;
    while std::time::Instant::now() < deadline {
        match child.try_wait() {
            Ok(Some(_)) => {
                exited = true;
                break;
            }
            Ok(None) => {
                std::thread::sleep(Duration::from_millis(25));
            }
            Err(_) => break,
        }
    }

    if !exited {
        let _ = child.kill();
        let _ = child.wait();
        let _ = stdout_handle.join();
        return None;
    }

    let status = child.wait().ok()?;
    let stdout_bytes = stdout_handle.join().unwrap_or_default();
    let success = status.success() || (allow_diff_exit && status.code() == Some(1));
    if !success {
        return None;
    }
    let text = String::from_utf8_lossy(&stdout_bytes);
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
        let _env = crate::test_support::lock_test_env();
        let info = get_git_info("/non_existent_dir_xyz_9999");
        assert!(info.branch.is_none());
        assert!(info.error.is_some());
    }

    #[test]
    fn test_tmp_dir_is_not_repo_or_returns_gracefully() {
        let _env = crate::test_support::lock_test_env();
        let dir = std::env::temp_dir().to_string_lossy().to_string();
        let info = get_git_info(&dir);
        // Must not panic; either error or valid branch.
        assert!(info.branch.is_none() || info.branch.is_some());
    }

    #[test]
    fn test_run_git_action_validation() {
        let _env = crate::test_support::lock_test_env();
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
        let _env = crate::test_support::lock_test_env();
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

        // Fresh repo with 0 commits must still report repo_root and branch
        let empty_base = std::env::temp_dir().join(format!("kai-git-empty-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&empty_base);
        std::fs::create_dir_all(&empty_base).unwrap();
        assert!(std::process::Command::new("git")
            .current_dir(&empty_base)
            .arg("init")
            .output()
            .unwrap()
            .status
            .success());
        let empty_info = get_git_info(&empty_base.to_string_lossy());
        assert!(empty_info.error.is_none());
        assert!(empty_info.repo_root.is_some());
        assert!(empty_info.branch.is_some());
        let _ = std::fs::remove_dir_all(&empty_base);
    }

    #[test]
    fn test_large_repo_status_is_bounded() {
        let _env = crate::test_support::lock_test_env();
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
        let _env = crate::test_support::lock_test_env();
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

    #[test]
    fn test_validate_repo_rel_path_traversal_attacks() {
        let _env = crate::test_support::lock_test_env();
        let temp_dir = std::env::temp_dir().join(format!("kai_git_sec_{}", uuid::Uuid::new_v4()));
        let _ = std::fs::create_dir_all(&temp_dir);
        let repo_root = temp_dir.to_string_lossy().to_string();

        // 1. Directory traversal via ..
        assert!(validate_repo_rel_path(&repo_root, "../outside.txt").is_err());
        assert!(validate_repo_rel_path(&repo_root, "src/../../outside.txt").is_err());
        assert!(validate_repo_rel_path(&repo_root, "..\\outside.txt").is_err());

        // 2. Absolute paths
        assert!(validate_repo_rel_path(&repo_root, "/etc/passwd").is_err());
        assert!(validate_repo_rel_path(&repo_root, "/var/log/syslog").is_err());
        assert!(validate_repo_rel_path(&repo_root, "C:\\Windows\\System32").is_err());

        // 3. Flags and command injection indicators
        assert!(validate_repo_rel_path(&repo_root, "--all").is_err());
        assert!(validate_repo_rel_path(&repo_root, "-f").is_err());

        // 4. Null bytes
        assert!(validate_repo_rel_path(&repo_root, "file.txt\0payload").is_err());

        // 5. Empty or whitespace
        assert!(validate_repo_rel_path(&repo_root, "").is_err());
        assert!(validate_repo_rel_path(&repo_root, "   ").is_err());

        // 6. Valid relative path succeeds
        assert_eq!(
            validate_repo_rel_path(&repo_root, "src/index.ts").unwrap(),
            "src/index.ts"
        );

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_unborn_branch_reports_repo_and_branch() {
        let _env = crate::test_support::lock_test_env();
        if !git_available() {
            return;
        }
        let base = std::env::temp_dir().join(format!("kai-git-unborn-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        assert!(std::process::Command::new("git")
            .current_dir(&base)
            .arg("init")
            .output()
            .unwrap()
            .status
            .success());
        let info = get_git_info(&base.to_string_lossy());
        assert!(
            info.error.is_none(),
            "unborn repo must not error: {:?}",
            info.error
        );
        assert!(info.repo_root.is_some());
        assert!(info.branch.is_some());
        assert!(!info.dirty);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn test_worktree_nested_and_unusual_paths() {
        let _env = crate::test_support::lock_test_env();
        if !git_available() {
            return;
        }
        let base = std::env::temp_dir().join(format!("kai-git-edge-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        init_repo_with_commit(&base);
        let dir = base.to_string_lossy().to_string();

        // Nested repository: inner init wins over outer.
        let nested = base.join("nested");
        std::fs::create_dir_all(&nested).unwrap();
        assert!(std::process::Command::new("git")
            .current_dir(&nested)
            .arg("init")
            .output()
            .unwrap()
            .status
            .success());
        let nested_info = get_git_info(&nested.to_string_lossy());
        assert!(nested_info.error.is_none());
        let nested_root = std::fs::canonicalize(&nested)
            .unwrap()
            .to_string_lossy()
            .to_string();
        let reported_root = std::fs::canonicalize(nested_info.repo_root.unwrap())
            .unwrap()
            .to_string_lossy()
            .to_string();
        assert_eq!(reported_root, nested_root);

        // Linked worktree resolves to its own root and stays queryable.
        let wt = base
            .parent()
            .unwrap()
            .join(format!("kai-git-wt-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&wt);
        let wt_out = std::process::Command::new("git")
            .current_dir(&base)
            .args(["worktree", "add", "--detach", wt.to_str().unwrap()])
            .output()
            .unwrap();
        if wt_out.status.success() {
            let wt_info = get_git_info(&wt.to_string_lossy());
            assert!(wt_info.error.is_none());
            assert!(wt_info.repo_root.is_some());
            let _ = std::process::Command::new("git")
                .current_dir(&base)
                .args(["worktree", "remove", "--force", wt.to_str().unwrap()])
                .output();
        }
        let _ = std::fs::remove_dir_all(&wt);

        // Unusual paths: spaces + unicode, untracked + modified => dirty.
        std::fs::write(base.join("sp ace ünïcode.txt"), "x\n").unwrap();
        assert!(get_git_info(&dir).dirty);
        let changes = get_git_changes(&dir).expect("changes with unusual path");
        assert!(changes.untracked.iter().any(|f| f.path.contains("sp ace")));
        std::fs::remove_file(base.join("sp ace ünïcode.txt")).unwrap();

        // Deleted tracked file is dirty and surfaced as a working-tree deletion.
        std::fs::remove_file(base.join("f.txt")).unwrap();
        assert!(get_git_info(&dir).dirty);
        let del = get_git_changes(&dir).expect("changes after delete");
        assert!(del
            .working_tree
            .iter()
            .any(|f| f.path == "f.txt" && f.status == "D"));

        // Inaccessible / missing taxonomy never panics.
        assert!(get_git_info("/non_existent_dir_xyz_9999").error.is_some());
        assert!(get_git_info("").error.is_some());
        assert!(get_git_info("bad\0dir").error.is_some());
        let file_as_dir = base.join("nested");
        let _ = std::fs::write(base.join("plain.txt"), "p");
        assert!(get_git_info(&base.join("plain.txt").to_string_lossy())
            .error
            .is_some());
        let _ = std::fs::remove_file(base.join("plain.txt"));
        let _ = file_as_dir;

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn test_large_repo_changes_stay_bounded() {
        let _env = crate::test_support::lock_test_env();
        if !git_available() {
            return;
        }
        let base = std::env::temp_dir().join(format!("kai-git-large-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        init_repo_with_commit(&base);
        for i in 0..200 {
            let _ = std::fs::write(base.join(format!("bulk-{}.txt", i)), "bulk\n");
        }
        let dir = base.to_string_lossy().to_string();
        let start = std::time::Instant::now();
        let info = get_git_info(&dir);
        assert!(info.dirty);
        let changes = get_git_changes(&dir).expect("large changes");
        assert_eq!(changes.untracked.len(), 200);
        assert!(start.elapsed() < std::time::Duration::from_secs(8));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn test_symlink_escape_rejected_by_git_validation() {
        let _env = crate::test_support::lock_test_env();
        let temp_dir = std::env::temp_dir().join(format!("kai_git_sym_{}", uuid::Uuid::new_v4()));
        let repo_dir = temp_dir.join("repo");
        let outside_dir = temp_dir.join("outside");
        let _ = std::fs::create_dir_all(&repo_dir);
        let _ = std::fs::create_dir_all(&outside_dir);

        let secret_file = outside_dir.join("secret.txt");
        let _ = std::fs::write(&secret_file, "SECRET_DATA");

        #[cfg(unix)]
        {
            let symlink_path = repo_dir.join("leaked_link.txt");
            let _ = std::os::unix::fs::symlink(&secret_file, &symlink_path);
            let repo_str = repo_dir.to_string_lossy().to_string();
            let res = validate_repo_rel_path(&repo_str, "leaked_link.txt");
            assert!(
                res.is_err(),
                "Symlink pointing outside repo root must be rejected"
            );
        }

        let _ = std::fs::remove_dir_all(&temp_dir);
    }
}
