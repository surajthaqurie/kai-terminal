//! Guard against the `kai` CLI/desktop binary name collision.
//!
//! The desktop GUI (`kai` / `kai.exe`) and the Node CLI (`kai` via
//! `npm run setup:cli`) intentionally share one command name on every OS:
//!
//! * Linux   — desktop: `/usr/bin/kai`, CLI shim: `~/.local/bin/kai`
//! * macOS   — desktop: `Kai Terminal.app/Contents/MacOS/kai`, CLI: `~/.local/bin/kai`
//! * Windows — desktop: `%LOCALAPPDATA%/KaiTerminal/kai.exe`,
//!             CLI: `%USERPROFILE%/.kai/bin/kai.cmd`
//!
//! Whichever entry comes first on PATH wins. When the desktop binary wins
//! (fresh `.deb`/NSIS/dmg install before `setup:cli`, or a stale symlink
//! such as `~/.local/bin/kai -> /usr/bin/cross-platform-terminal-backend`),
//! running `kai code .` or `kai agent setup opencode` would previously
//! just open a NEW Kai window (the reported "new terminal opens" bug) and
//! silently swallow the CLI request.
//!
//! This guard runs before the Tauri WebView boots: when the desktop binary
//! is invoked with a known CLI subcommand/flag it prints a short pointer
//! to the real CLI and exits WITHOUT opening a window, on all three OSes.
//! A bare `kai` (no args) or `kai <path>` still opens the GUI as before.

use std::process::exit;

/// First argv tokens the Node CLI owns. Kept in sync with
/// `src/cli/index.ts` (`code`, `stop`, `status`, …).
const CLI_COMMANDS: &[&str] = &[
    "code",
    "stop",
    "clear",
    "status",
    "unregister",
    "graph",
    "query",
    "cost",
    "config",
    "session",
    "mcp",
    "bench",
    "agent",
    "metrics",
    "lsp",
];

const CLI_FLAGS: &[&str] = &["--help", "-h", "--version", "-v", "help", "version"];

/// Returns true when `args` (without the binary name) looks like a CLI
/// invocation that the desktop GUI must NOT open a window for.
pub fn is_cli_invocation(args: &[String]) -> bool {
    let first = match args.first() {
        Some(f) => f.to_ascii_lowercase(),
        None => return false,
    };
    if CLI_COMMANDS.contains(&first.as_str()) || CLI_FLAGS.contains(&first.as_str()) {
        return true;
    }
    // `kai --no-launch ...` / `kai --headless` style flag-first calls.
    if first.starts_with('-') {
        return true;
    }
    false
}

/// Help text printed when the desktop binary intercepts a CLI call.
/// Points at the per-OS fix instead of opening a duplicate window.
pub fn cli_collision_hint(invoked_as: &str) -> String {
    format!(
        "[kai] You ran the Kai Terminal DESKTOP app as `{invoked_as}` with CLI arguments.\n\
         The desktop app does not implement CLI subcommands — no window was opened.\n\
         \n\
         Run the Node CLI instead (all OS, requires Node.js 20+):\n\
         \x20\x20node ./bin/kai.js --help            # from the kai-terminal repo\n\
         \x20\x20kai code . --no-launch               # after the CLI is on PATH\n\
         \n\
         To put the real `kai` CLI on PATH:\n\
         \x20\x20Linux/macOS: npm run setup:cli && restart your terminal\n\
         \x20\x20  (ensures ~/.local/bin/kai points at bin/kai.js, not the desktop binary;\n\
         \x20\x20   keep ~/.local/bin BEFORE /usr/bin on PATH)\n\
         \x20\x20Windows:     npm run setup:cli, then open a NEW terminal\n\
         \x20\x20  (%USERPROFILE%\\.kai\\bin\\kai.cmd takes precedence over KaiTerminal\\kai.exe)\n\
         \n\
         If `which kai` / `where kai` still resolves to the desktop binary,\n\
         reinstall the CLI shim with `npm run setup:cli` (it backs up collisions)."
    )
}

/// Check process args before Tauri boots. Returns true when the process
/// handled the invocation (printed a hint) and the caller must exit
/// without opening a GUI window.
pub fn handle_desktop_cli_collision() -> bool {
    let argv: Vec<String> = std::env::args().collect();
    if argv.len() < 2 {
        return false; // bare `kai` — open the GUI normally
    }
    let rest: Vec<String> = argv[1..].to_vec();
    if !is_cli_invocation(&rest) {
        return false; // e.g. `kai /path/to/dir` — let the GUI open normally
    }
    let invoked = argv.join(" ");
    // `--version`/`version` go to stdout (script-friendly); everything
    // else goes to stderr with a non-zero exit so scripts can detect it.
    if rest[0].to_ascii_lowercase() == "--version"
        || rest[0].to_ascii_lowercase() == "-v"
        || rest[0].to_ascii_lowercase() == "version"
    {
        println!(
            "kai-desktop {}",
            option_env!("CARGO_PKG_VERSION").unwrap_or("unknown")
        );
        println!("(desktop GUI — for CLI features install the Node CLI: npm run setup:cli)");
    } else {
        eprintln!("{}", cli_collision_hint(&invoked));
    }
    // Exit code 2 mirrors the Node CLI's usage-error code, except --help.
    let help = rest[0].to_ascii_lowercase();
    if help == "--help" || help == "-h" || help == "help" {
        exit(0);
    } else {
        exit(2);
    }
}

/// Extracts a GUI path argument to forward when a second instance is
/// launched while one is already running (single-instance enforcement).
///
/// Takes the raw `argv` as delivered by the OS / the single-instance
/// plugin (argv[0] is the binary name). Returns:
/// - `None` for a bare launch (just focus the existing window), for CLI
///   invocations (those never open a window — see `is_cli_invocation`),
///   and for flag-first args (`--no-launch`, `--help`, …).
/// - `Some(path)` for `kai <path>` / `kai .` so the existing window can
///   surface it (emitted as `kai-open-project`) instead of opening a
///   duplicate ("ghost") window.
///
/// Pure + OS-agnostic: no filesystem probes here, so unit tests cover
/// Windows (`C:\...`), macOS (`/Users/...`), and Linux (`/home/...`)
/// argv shapes on any host.
pub fn gui_path_from_args(argv: &[String]) -> Option<String> {
    let rest: Vec<&String> = argv.iter().skip(1).collect();
    if rest.is_empty() {
        return None; // bare `kai` — just focus, nothing to forward
    }
    let owned: Vec<String> = rest.into_iter().cloned().collect();
    if is_cli_invocation(&owned) {
        return None; // CLI subcommand/flag — never a window path
    }
    let first = owned.first()?.trim().trim_matches('"').trim_matches('\'');
    if first.is_empty() || first.starts_with('-') {
        return None;
    }
    Some(first.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_cli_subcommands_on_all_os_argv_shapes() {
        for cmd in ["code", "agent", "status", "mcp", "query", "stop", "config"] {
            assert!(is_cli_invocation(&[cmd.to_string()]));
            // Windows CMD lowercases nothing, but be case-tolerant anyway.
            assert!(is_cli_invocation(&[cmd.to_uppercase()]));
        }
        assert!(is_cli_invocation(&[
            "agent".into(),
            "setup".into(),
            "opencode".into()
        ]));
        assert!(is_cli_invocation(&["code".into(), ".".into()]));
    }

    #[test]
    fn detects_flags() {
        assert!(is_cli_invocation(&["--version".into()]));
        assert!(is_cli_invocation(&["--help".into()]));
        assert!(is_cli_invocation(&["-h".into()]));
        assert!(is_cli_invocation(&["--no-launch".into()]));
    }

    #[test]
    fn bare_launch_and_path_args_still_open_gui() {
        assert!(!is_cli_invocation(&[]));
        assert!(!is_cli_invocation(&[".".into()]));
        assert!(!is_cli_invocation(&["/home/user/repo".into()]));
        assert!(!is_cli_invocation(&["C:\\Users\\me\\repo".into()]));
    }

    #[test]
    fn second_instance_forwards_gui_path_on_all_os_shapes() {
        let argv = |tail: &[&str]| {
            let mut v = vec!["kai".to_string()];
            v.extend(tail.iter().map(|s| s.to_string()));
            v
        };
        // Bare launch — focus only, nothing to forward.
        assert_eq!(gui_path_from_args(&argv(&[])), None);
        // GUI paths forward on every OS (no duplicate window).
        assert_eq!(gui_path_from_args(&argv(&["."])), Some(".".to_string()));
        assert_eq!(
            gui_path_from_args(&argv(&["/home/user/repo"])),
            Some("/home/user/repo".to_string())
        );
        assert_eq!(
            gui_path_from_args(&argv(&["C:\\Users\\me\\repo"])),
            Some("C:\\Users\\me\\repo".to_string())
        );
        assert_eq!(
            gui_path_from_args(&argv(&["/Users/me/repo"])),
            Some("/Users/me/repo".to_string())
        );
        // CLI invocations never forward (they exit without a window).
        assert_eq!(gui_path_from_args(&argv(&["code", "."])), None);
        assert_eq!(gui_path_from_args(&argv(&["agent", "setup"])), None);
        assert_eq!(gui_path_from_args(&argv(&["--version"])), None);
        assert_eq!(gui_path_from_args(&argv(&["--help"])), None);
        assert_eq!(gui_path_from_args(&argv(&["--no-launch"])), None);
    }
}
