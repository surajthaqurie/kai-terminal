//! The user's real `PATH` for a desktop app launched from a menu or dock.
//!
//! A macOS app started from the Dock or Finder, or a Linux app started from a
//! desktop menu, inherits the session manager's short `PATH` (often just
//! `/usr/bin:/bin:/usr/sbin:/sbin`), not the one a terminal has. Tools the app
//! starts on the user's behalf (`az`, `node`, `git`) are then "not found" even
//! though they work in every terminal. At startup the app asks the user's own
//! login shell for its `PATH` once and merges it into the process environment,
//! so every child process (the bundled CLI, `az`, `git`) sees it.
//!
//! Only the `PATH` value is taken. The shell is run interactively so it reads
//! the same startup files a terminal would (`.zshrc`, `.bashrc`, nvm, Homebrew),
//! with a hard time limit so a slow or broken rc file can never delay startup
//! for long.

/// Markers around the printed value, so anything an rc file prints on its own
/// (a banner, a `fortune`) is never mistaken for the `PATH`.
#[cfg(any(unix, test))]
const START_MARK: &str = "__KAI_PATH_START__";
#[cfg(any(unix, test))]
const END_MARK: &str = "__KAI_PATH_END__";

/// Longest the login shell may take before it is killed and ignored.
#[cfg(unix)]
const SHELL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// The `PATH` value printed between the markers, or `None` when absent or empty.
#[cfg(any(unix, test))]
fn parse_marked_path(output: &str) -> Option<String> {
    let after = output.split_once(START_MARK)?.1;
    let value = after.split_once(END_MARK)?.0.trim();
    // A `PATH` is one line of absolute-ish entries; anything else is noise.
    if value.is_empty() || value.contains('\n') || value.contains('\0') {
        return None;
    }
    Some(value.to_string())
}

/// `login` entries first (the user's own order wins), then any entry of
/// `current` that `login` lacks, without duplicates or empty entries.
#[cfg(any(unix, test))]
fn merge_paths(login: &str, current: &str) -> String {
    let mut seen = std::collections::HashSet::new();
    let mut merged: Vec<&str> = Vec::new();
    for entry in login.split(':').chain(current.split(':')) {
        if !entry.is_empty() && seen.insert(entry) {
            merged.push(entry);
        }
    }
    merged.join(":")
}

/// The login shell to ask: `$SHELL` when it is an absolute path, otherwise a
/// shell every system of that kind has.
#[cfg(any(unix, test))]
fn shell_program(shell_env: Option<&str>, macos: bool) -> String {
    match shell_env.map(str::trim) {
        Some(s) if s.starts_with('/') && !s.contains('\0') => s.to_string(),
        _ if macos => "/bin/zsh".to_string(),
        _ => "/bin/sh".to_string(),
    }
}

/// Runs `shell -ilc 'printf START"$PATH"END'` and returns the parsed `PATH`.
#[cfg(unix)]
fn login_shell_path(shell: &str) -> Option<String> {
    use std::io::Read;
    use std::process::{Command, Stdio};

    let script = format!("printf '%s%s%s' '{START_MARK}' \"$PATH\" '{END_MARK}'");
    let mut child = Command::new(shell)
        .args(["-ilc", &script])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = (&mut stdout).take(64 * 1024).read_to_end(&mut buf);
        String::from_utf8_lossy(&buf).into_owned()
    });
    let started = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if started.elapsed() >= SHELL_TIMEOUT => {
                let _ = child.kill();
                let _ = child.wait();
                break;
            }
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(25)),
            Err(_) => return None,
        }
    }
    parse_marked_path(&reader.join().ok()?)
}

/// Merges the login shell's `PATH` into this process's `PATH`. Call once, early,
/// before any other thread reads the environment. Does nothing when the app was
/// started from a terminal (its `PATH` is already the user's), and every failure
/// leaves `PATH` as it was.
#[cfg(unix)]
pub fn apply_login_shell_path() {
    use std::io::IsTerminal;

    if std::io::stdin().is_terminal() {
        return;
    }
    let shell = shell_program(
        std::env::var("SHELL").ok().as_deref(),
        cfg!(target_os = "macos"),
    );
    let Some(login) = login_shell_path(&shell) else {
        return;
    };
    let current = std::env::var("PATH").unwrap_or_default();
    std::env::set_var("PATH", merge_paths(&login, &current));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_value_between_the_markers() {
        let out = format!("Welcome!\n{START_MARK}/opt/homebrew/bin:/usr/bin{END_MARK}\nbye");
        assert_eq!(
            parse_marked_path(&out).as_deref(),
            Some("/opt/homebrew/bin:/usr/bin")
        );
    }

    #[test]
    fn rejects_missing_empty_or_multiline_values() {
        assert_eq!(parse_marked_path("no markers here"), None);
        assert_eq!(parse_marked_path(&format!("{START_MARK}{END_MARK}")), None);
        assert_eq!(parse_marked_path(&format!("{START_MARK}/usr/bin")), None);
        assert_eq!(
            parse_marked_path(&format!("{START_MARK}/a\n/b{END_MARK}")),
            None
        );
    }

    #[test]
    fn merging_puts_the_login_order_first_without_duplicates() {
        assert_eq!(
            merge_paths(
                "/opt/homebrew/bin:/usr/bin:/home/me/.nvm/bin",
                "/usr/bin:/bin:/usr/sbin"
            ),
            "/opt/homebrew/bin:/usr/bin:/home/me/.nvm/bin:/bin:/usr/sbin"
        );
    }

    #[test]
    fn merging_drops_empty_entries_and_keeps_the_session_path_when_login_is_empty() {
        assert_eq!(merge_paths("", "/usr/bin::/bin"), "/usr/bin:/bin");
        assert_eq!(merge_paths("/a::/b", ""), "/a:/b");
    }

    #[test]
    fn picks_an_absolute_shell_or_a_platform_fallback() {
        assert_eq!(shell_program(Some("/usr/bin/fish"), false), "/usr/bin/fish");
        assert_eq!(shell_program(Some(" /bin/bash "), true), "/bin/bash");
        assert_eq!(shell_program(Some("bash"), false), "/bin/sh");
        assert_eq!(shell_program(None, true), "/bin/zsh");
        assert_eq!(shell_program(None, false), "/bin/sh");
        assert_eq!(shell_program(Some(""), true), "/bin/zsh");
    }

    #[cfg(unix)]
    #[test]
    fn a_real_shell_reports_a_path() {
        let _env = crate::test_support::lock_test_env();
        let path = login_shell_path("/bin/sh").expect("sh prints PATH");
        assert!(!path.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn a_missing_shell_is_ignored() {
        assert_eq!(login_shell_path("/definitely/not/a/shell"), None);
    }
}
