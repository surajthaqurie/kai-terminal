pub mod active_project;
pub mod ai_cli;
pub mod autostart;
pub mod cli_guard;
pub mod diagnostics;
pub mod error;
pub mod git;
pub mod intelligence;
pub mod pty;
pub mod shell;

#[cfg(test)]
pub(crate) mod test_support {
    //! Process-wide serialization for tests that read or mutate process
    //! environment (`PATH`/`HOME`/`USERPROFILE`/`XDG_*`/`KAI_*`/`SHELL`/…)
    //! or spawn subprocesses (which inherit that environment).
    //!
    //! Rust runs `#[test]` fns in threads of ONE process with SHARED env.
    //! A test that points `PATH`/`HOME` at a temp dir breaks every
    //! concurrent test that spawns `git`/`sh`/probes or resolves the home
    //! dir (observed as `ENOENT` flakes in the pty/git suites under load).
    //!
    //! Convention (deadlock safety — `std::Mutex` is NOT reentrant):
    //! ONLY `#[test]` fns acquire this lock, as their FIRST statement;
    //! helpers and production code NEVER lock. Waiting time stays OUTSIDE
    //! measured bounds: start any `Instant` AFTER acquiring the guard.
    use std::sync::{Mutex, MutexGuard};

    static TEST_ENV_LOCK: Mutex<()> = Mutex::new(());

    pub(crate) fn lock_test_env() -> MutexGuard<'static, ()> {
        TEST_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner())
    }
}

#[cfg(feature = "tauri")]
use std::sync::Arc;

#[cfg(feature = "tauri")]
use ai_cli::{
    check_custom_ai_cli_path, detect_ai_cli_details, detect_ai_clis, get_kai_cli_launch,
    setup_agent_mcp, AgentSetupResult, AiCliDetails, AiCliStatus,
};

#[cfg(feature = "tauri")]
use diagnostics::{build_diagnostics, AiCliSummary};

#[cfg(feature = "tauri")]
use git::{
    discard_git_file, get_git_changes, get_git_diff, get_git_info, run_git_action, stage_git_file,
    unstage_git_file, GitChangesSummary, GitInfo,
};

#[cfg(feature = "tauri")]
use pty::{PtyCreateOptions, PtyManager, PtySessionInfo};
#[cfg(feature = "tauri")]
use shell::{
    detect_available_shells, detect_installed_editors, open_in_editor, EditorInfo, ShellProfile,
};
#[cfg(feature = "tauri")]
use tauri::{AppHandle, Emitter, Manager, State};

#[cfg(feature = "tauri")]
#[tauri::command]
fn get_available_shells() -> Vec<ShellProfile> {
    detect_available_shells()
}

#[cfg(feature = "tauri")]
#[tauri::command]
fn get_ai_cli_status() -> Vec<AiCliStatus> {
    detect_ai_clis()
}

#[cfg(feature = "tauri")]
#[tauri::command]
fn get_ai_cli_details() -> Vec<AiCliDetails> {
    detect_ai_cli_details()
}

#[cfg(feature = "tauri")]
#[tauri::command]
fn check_ai_cli_path(id: String, custom_path: String) -> Result<AiCliDetails, String> {
    check_custom_ai_cli_path(&id, &custom_path)
}

#[cfg(feature = "tauri")]
#[tauri::command]
fn get_kai_cli_launch_cmd() -> Result<Vec<String>, String> {
    get_kai_cli_launch()
}

#[cfg(feature = "tauri")]
#[tauri::command]
fn setup_agent_mcp_cmd(
    id: String,
    launcher: Vec<String>,
    project_arg: String,
    force: bool,
) -> Result<AgentSetupResult, String> {
    setup_agent_mcp(&id, launcher, &project_arg, force)
}

#[cfg(feature = "tauri")]
#[tauri::command]
fn get_git_info_cmd(cwd: String) -> GitInfo {
    get_git_info(&cwd)
}

#[cfg(feature = "tauri")]
#[tauri::command]
fn run_git_action_cmd(cwd: String, action: String) -> Result<String, String> {
    run_git_action(&cwd, &action)
}

#[cfg(feature = "tauri")]
#[tauri::command]
fn get_git_changes_cmd(cwd: String) -> Result<GitChangesSummary, String> {
    get_git_changes(&cwd)
}

#[cfg(feature = "tauri")]
#[tauri::command]
fn get_git_diff_cmd(cwd: String, path: Option<String>, staged: bool) -> Result<String, String> {
    get_git_diff(&cwd, path.as_deref(), staged)
}

#[cfg(feature = "tauri")]
#[tauri::command]
fn stage_git_file_cmd(cwd: String, path: String) -> Result<String, String> {
    stage_git_file(&cwd, &path)
}

#[cfg(feature = "tauri")]
#[tauri::command]
fn unstage_git_file_cmd(cwd: String, path: String) -> Result<String, String> {
    unstage_git_file(&cwd, &path)
}

#[cfg(feature = "tauri")]
#[tauri::command]
fn discard_git_file_cmd(cwd: String, path: String) -> Result<String, String> {
    discard_git_file(&cwd, &path)
}

#[cfg(feature = "tauri")]
#[tauri::command]
fn get_project_intelligence_cmd(cwd: String) -> intelligence::ProjectIntelligenceSummary {
    intelligence::get_project_intelligence(&cwd)
}

/// Single source of truth for Code Mode: `kai code <path>` sets it,
/// `kai stop code` clears it. Never defaults to code, never falls back
/// to recent history. Works in dev and release builds (release WebViews
/// use a different localStorage file, so the CLI's state file + launch
/// env are authoritative — not a SQLite localStorage hack).
#[cfg(feature = "tauri")]
#[tauri::command]
fn get_active_project_cmd() -> active_project::ActiveProject {
    active_project::get_active_project()
}

#[cfg(feature = "tauri")]
#[tauri::command]
fn open_project_in_editor(
    editor_path: Option<String>,
    cwd: String,
) -> Result<String, error::TerminalError> {
    open_in_editor(editor_path.as_deref(), &cwd)
}

#[cfg(feature = "tauri")]
#[tauri::command]
fn detect_installed_editors_cmd() -> Vec<EditorInfo> {
    detect_installed_editors()
}

#[cfg(feature = "tauri")]
#[tauri::command]
fn get_diagnostics(state: State<'_, PtyManager>) -> diagnostics::DiagnosticsReport {
    let sessions = state.list_sessions();
    let shells = detect_available_shells();
    let ai_clis: Vec<AiCliSummary> = detect_ai_cli_details()
        .into_iter()
        .map(|d| AiCliSummary {
            id: d.id,
            available: d.available,
            version: d.version,
        })
        .collect();
    build_diagnostics(shells.len(), sessions.len(), ai_clis)
}

#[cfg(feature = "tauri")]
#[tauri::command]
fn create_pty(
    app_handle: AppHandle,
    state: State<'_, PtyManager>,
    options: PtyCreateOptions,
) -> Result<PtySessionInfo, error::TerminalError> {
    let emitter = Arc::new(pty::TauriEventEmitter { app_handle });
    state.create_pty(emitter, options)
}

#[cfg(feature = "tauri")]
#[tauri::command]
fn write_to_pty(
    state: State<'_, PtyManager>,
    id: String,
    data: String,
) -> Result<(), error::TerminalError> {
    state.write_to_pty(&id, &data)
}

#[cfg(feature = "tauri")]
#[tauri::command]
fn resize_pty(
    state: State<'_, PtyManager>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), error::TerminalError> {
    state.resize_pty(&id, cols, rows)
}

#[cfg(feature = "tauri")]
#[tauri::command]
fn close_pty(state: State<'_, PtyManager>, id: String) -> Result<(), error::TerminalError> {
    state.close_pty(&id)
}

#[cfg(feature = "tauri")]
#[tauri::command]
fn get_autostart_enabled() -> bool {
    autostart::is_autostart_enabled()
}

#[cfg(feature = "tauri")]
#[tauri::command]
fn set_autostart_enabled(enabled: bool) -> Result<(), error::TerminalError> {
    autostart::set_autostart_enabled(enabled)
}

#[cfg(feature = "tauri")]
#[tauri::command]
fn get_session_info(state: State<'_, PtyManager>, id: String) -> Option<PtySessionInfo> {
    state.get_session_info(&id)
}

#[cfg(feature = "tauri")]
#[tauri::command]
fn get_pty_cwd(state: State<'_, PtyManager>, id: String) -> Option<String> {
    state.get_session_cwd(&id)
}

#[cfg(feature = "tauri")]
#[tauri::command]
fn get_system_terminal_config() -> shell::SystemTerminalConfig {
    shell::detect_system_terminal_config()
}

#[cfg(feature = "tauri")]
#[tauri::command]
fn get_app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[cfg(feature = "tauri")]
#[tauri::command]
fn list_sessions(state: State<'_, PtyManager>) -> Vec<PtySessionInfo> {
    state.list_sessions()
}

#[cfg(feature = "tauri")]
pub fn run() {
    let pty_manager = PtyManager::new();

    // Warm the Windows build-number cache off the UI thread so the first
    // PTY spawn never blocks on `reg`/`cmd` probes (startup stall fix).
    #[cfg(target_os = "windows")]
    crate::shell::warm_host_pty_cache();

    tauri::Builder::default()
        .manage(pty_manager)
        // Single-instance enforcement (Windows / Linux / macOS): a second
        // `kai` / `kai <path>` launch must NEVER open a duplicate ("ghost")
        // window. The plugin routes the second process here in the FIRST
        // (already running) process; we focus its main window, forward an
        // optional path via `kai-open-project` (the frontend re-syncs Code
        // Mode from the state file the CLI already wrote), and the second
        // process exits without creating a window. The Node
        // `isKaiAppRunning()` fast-path avoids the spawn in the common case;
        // this is the authoritative cross-OS guarantee that closes the
        // check-then-launch race (two rapid `kai code .` calls) and the
        // process-name false-negative (AppImage/snap/renamed binaries,
        // localized `tasklist`, truncated `comm`).
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
                if let Some(path) = crate::cli_guard::gui_path_from_args(&args) {
                    let _ = window.emit("kai-open-project", serde_json::json!({ "path": path }));
                } else {
                    // Bare re-launch: still wake the frontend so it re-syncs
                    // Code Mode state (covers `kai code` written externally).
                    let _ = window.emit("kai-open-project", serde_json::json!({}));
                }
            }
        }))
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                // Reap all active PTY child processes when window is closed
                let state: State<'_, PtyManager> = window.state();
                state.close_all();
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_available_shells,
            get_ai_cli_status,
            get_ai_cli_details,
            check_ai_cli_path,
            get_kai_cli_launch_cmd,
            setup_agent_mcp_cmd,
            get_git_info_cmd,
            run_git_action_cmd,
            get_git_changes_cmd,
            get_git_diff_cmd,
            stage_git_file_cmd,
            unstage_git_file_cmd,
            discard_git_file_cmd,
            open_project_in_editor,
            detect_installed_editors_cmd,
            get_diagnostics,
            create_pty,
            write_to_pty,
            resize_pty,
            close_pty,
            get_pty_cwd,
            get_system_terminal_config,
            get_app_version,
            get_autostart_enabled,
            set_autostart_enabled,
            get_session_info,
            list_sessions,
            get_project_intelligence_cmd,
            get_active_project_cmd
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::ExitRequested { .. } = event {
                // Reap all active PTY child processes on application shutdown
                let state: State<'_, PtyManager> = app_handle.state();
                state.close_all();
            }
        });
}
