pub mod ai_cli;
pub mod autostart;
pub mod diagnostics;
pub mod error;
pub mod git;
pub mod intelligence;
pub mod pty;
pub mod shell;

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
use git::{get_git_info, run_git_action, GitInfo};

#[cfg(feature = "tauri")]
use pty::{PtyCreateOptions, PtyManager, PtySessionInfo};
#[cfg(feature = "tauri")]
use shell::{
    detect_available_shells, detect_installed_editors, open_in_editor, EditorInfo, ShellProfile,
};
#[cfg(feature = "tauri")]
use tauri::{AppHandle, Manager, State};

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
fn get_project_intelligence_cmd(cwd: String) -> intelligence::ProjectIntelligenceSummary {
    intelligence::get_project_intelligence(&cwd)
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
fn list_sessions(state: State<'_, PtyManager>) -> Vec<PtySessionInfo> {
    state.list_sessions()
}

#[cfg(feature = "tauri")]
pub fn run() {
    let pty_manager = PtyManager::new();

    tauri::Builder::default()
        .manage(pty_manager)
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
            open_project_in_editor,
            detect_installed_editors_cmd,
            get_diagnostics,
            create_pty,
            write_to_pty,
            resize_pty,
            close_pty,
            get_autostart_enabled,
            set_autostart_enabled,
            get_session_info,
            list_sessions,
            get_project_intelligence_cmd
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
