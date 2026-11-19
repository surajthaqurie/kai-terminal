// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // `kai run` on Windows starts commands through this binary so they run in
    // a Job Object it can stop as a whole (src-tauri/src/job_runner.rs). Those
    // invocations exit here, before the guard below or any window.
    kai::job_runner::handle_job_helper_args();
    // Cross-OS CLI/desktop collision guard: when the DESKTOP binary is
    // invoked with Node CLI arguments (`kai code .`, `kai agent setup
    // opencode`, `kai --version`, …) print a pointer to the real CLI and
    // exit WITHOUT opening a new window. Bare `kai` / `kai <path>` still
    // boots the GUI. See src-tauri/src/cli_guard.rs.
    #[cfg(feature = "tauri")]
    kai::cli_guard::handle_desktop_cli_collision();
    #[cfg(feature = "tauri")]
    kai::run();
}
