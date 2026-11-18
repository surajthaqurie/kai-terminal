pub mod active_project;
pub mod ai_cli;
pub mod autostart;
pub mod call_watch;
pub mod cli_guard;
pub mod clipboard;
pub mod diagnostics;
pub mod editor_terminal;
pub mod error;
pub mod fonts;
pub mod git;
pub mod integrations;
pub mod intelligence;
pub mod kai_cli;
pub mod login_path;
pub mod pty;
pub mod shell;
pub mod shutdown;
pub mod snap_layouts;
pub mod updater;

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

/// How long exit waits for terminal children to be reaped before leaving anyway.
#[cfg(feature = "tauri")]
const REAP_BUDGET: std::time::Duration = std::time::Duration::from_millis(1500);

/// Ends the process without ever leaving a frozen window behind.
///
/// Every window is hidden first, so nothing is on screen while teardown runs.
/// Reaping the PTY children can block (closing a Windows pseudo-console waits
/// for its output to drain), and a visible window whose thread is stuck is what
/// Windows paints as a blank "Not Responding" ghost. The reaping runs on its
/// own thread for at most [`REAP_BUDGET`]; then the process exits regardless.
#[cfg(feature = "tauri")]
pub(crate) fn exit_now(app_handle: &AppHandle) -> ! {
    for window in app_handle.webview_windows().values() {
        let _ = window.hide();
    }
    let handle = app_handle.clone();
    let _ = shutdown::finish_within(REAP_BUDGET, move || {
        let state: State<'_, PtyManager> = handle.state();
        state.close_all();
    });
    std::process::exit(0)
}

/// Reaps every PTY child and terminates the process (see [`exit_now`]).
#[cfg(feature = "tauri")]
pub(crate) fn shutdown_app(app_handle: &AppHandle) {
    exit_now(app_handle)
}

#[cfg(feature = "tauri")]
#[tauri::command]
fn close_app_window(app_handle: AppHandle) {
    shutdown_app(&app_handle);
}

/// Label of the detached music picture-in-picture window.
#[cfg(feature = "tauri")]
const MUSIC_PIP_LABEL: &str = "music-pip";

/// Sent to every window once the picture-in-picture window is gone, however it
/// was closed (its own button, Alt+F4, or [`close_music_pip`]).
#[cfg(feature = "tauri")]
const MUSIC_PIP_CLOSED_EVENT: &str = "kai-pip:closed";

/// The Windows window configuration, the single place the WebView2 arguments are
/// written down (`app.windows[0].additionalBrowserArgs`).
#[cfg(any(all(feature = "tauri", target_os = "windows"), test))]
const WINDOWS_CONF: &str = include_str!("../tauri.windows.conf.json");

/// WebView2 browser arguments, read from `tauri.windows.conf.json`. Every window
/// in the app shares one WebView2 environment, and WebView2 refuses to create a
/// window whose arguments differ from the environment's, so the music window
/// takes them from the same file the main window is configured from instead of
/// keeping a copy. They are wry's defaults plus autoplay: the music window is a
/// fresh page nobody has clicked in yet, and without autoplay the YouTube embed
/// it loads (with sound) would be blocked and the song would stop.
#[cfg(any(all(feature = "tauri", target_os = "windows"), test))]
fn webview2_browser_args() -> Option<String> {
    let conf: serde_json::Value = serde_json::from_str(WINDOWS_CONF).ok()?;
    let args = conf["app"]["windows"][0]["additionalBrowserArgs"].as_str()?;
    (!args.trim().is_empty()).then(|| args.to_string())
}

/// Smallest size of the music window (logical pixels).
#[cfg(any(feature = "tauri", test))]
const MUSIC_PIP_MIN_SIZE: (f64, f64) = (240.0, 150.0);

/// Size to open the music window at: the saved `width`/`height` (logical
/// pixels) when both are usable, never below the minimum nor above `max`
/// (the primary monitor in logical pixels), otherwise 360x203.
#[cfg(any(feature = "tauri", test))]
fn music_pip_size(width: Option<f64>, height: Option<f64>, max: Option<(f64, f64)>) -> (f64, f64) {
    const DEFAULT: (f64, f64) = (360.0, 203.0); // 16:9 at 360 wide: the window is just the video
    let (min_w, min_h) = MUSIC_PIP_MIN_SIZE;
    match (width, height) {
        (Some(w), Some(h)) if w.is_finite() && h.is_finite() && w > 0.0 && h > 0.0 => {
            let (max_w, max_h) = max.unwrap_or((f64::MAX, f64::MAX));
            (w.min(max_w).max(min_w), h.min(max_h).max(min_h))
        }
        _ => DEFAULT,
    }
}

/// Opens the small always-on-top music window, or just raises it when it is
/// already open. It reopens where the user last dropped it (`x`/`y`, physical
/// pixels) when that spot is still on a connected monitor, otherwise at the
/// bottom-right of the primary monitor, and at its last size (`width`/`height`,
/// logical pixels). `async` because creating a window from a synchronous
/// command can deadlock on Windows.
#[cfg(feature = "tauri")]
#[tauri::command]
async fn open_music_pip(
    app_handle: AppHandle,
    x: Option<f64>,
    y: Option<f64>,
    width: Option<f64>,
    height: Option<f64>,
) -> Result<(), String> {
    if let Some(window) = app_handle.get_webview_window(MUSIC_PIP_LABEL) {
        let _ = window.show();
        let _ = window.set_focus();
        return Ok(());
    }
    let primary = app_handle.primary_monitor().ok().flatten();
    let max = primary.as_ref().map(|m| {
        let scale = m.scale_factor();
        (
            m.size().width as f64 / scale,
            m.size().height as f64 / scale,
        )
    });
    let (width, height) = music_pip_size(width, height, max);
    let builder = tauri::WebviewWindowBuilder::new(
        &app_handle,
        MUSIC_PIP_LABEL,
        // Same bundle as the main window; `main.tsx` picks the player view.
        tauri::WebviewUrl::App("index.html?pip=music".into()),
    )
    .title("Kai Music")
    .inner_size(width, height)
    .min_inner_size(MUSIC_PIP_MIN_SIZE.0, MUSIC_PIP_MIN_SIZE.1)
    .decorations(false)
    .always_on_top(true)
    .resizable(true)
    // Shown once it is in place, so it never flashes at a default spot.
    .visible(false)
    .focused(true);
    // A see-through window lets the player's Dim Opacity show the desktop
    // behind the video. On macOS this needs Tauri's `macos-private-api`
    // feature (enabled in Cargo.toml and `tauri.macos.conf.json`).
    let builder = builder
        .transparent(true)
        .background_color(tauri::window::Color(0, 0, 0, 0));
    #[cfg(target_os = "windows")]
    let builder = match webview2_browser_args() {
        Some(args) => builder.additional_browser_args(&args),
        None => builder,
    };
    let window = builder.build().map_err(|e| e.to_string())?;

    let saved = match (x, y) {
        (Some(x), Some(y)) if x.is_finite() && y.is_finite() => Some((x as i32, y as i32)),
        _ => None,
    };
    // A saved spot counts only while its title strip is on some monitor (one
    // may have been unplugged since).
    let on_screen = |(px, py): (i32, i32)| {
        app_handle.available_monitors().map_or(false, |monitors| {
            monitors.iter().any(|m| {
                let (mx, my) = (m.position().x, m.position().y);
                let (mw, mh) = (m.size().width as i32, m.size().height as i32);
                let (cx, cy) = (px + 40, py + 16);
                cx >= mx && cx < mx + mw && cy >= my && cy < my + mh
            })
        })
    };
    let position = saved.filter(|p| on_screen(*p)).or_else(|| {
        let monitor = primary.as_ref()?;
        let scale = monitor.scale_factor();
        let w = (width * scale) as i32;
        let h = (height * scale) as i32;
        let x = monitor.position().x + monitor.size().width as i32 - w - (24.0 * scale) as i32;
        let y = monitor.position().y + monitor.size().height as i32 - h - (64.0 * scale) as i32;
        Some((x, y))
    });
    if let Some((x, y)) = position {
        let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
    }
    let _ = window.show();
    let _ = window.set_focus();
    Ok(())
}

/// Closes the music window (a no-op when it is not open) and, when asked,
/// brings the main window back to the front.
#[cfg(feature = "tauri")]
#[tauri::command]
async fn close_music_pip(app_handle: AppHandle, focus_main: bool) {
    if let Some(window) = app_handle.get_webview_window(MUSIC_PIP_LABEL) {
        let _ = window.destroy();
    }
    if focus_main {
        if let Some(main) = app_handle.get_webview_window("main") {
            let _ = main.unminimize();
            let _ = main.show();
            let _ = main.set_focus();
        }
    }
}

/// Reports where the page draws its maximize button (CSS pixels, relative to
/// the window's client area; `None` clears it) so Windows 11 can show its
/// snap-layouts popup there. Returns whether the native hit test is active;
/// when it is, the button's hover / pressed look arrives as
/// `kai-maximize-button-state` events and a click maximizes natively.
#[cfg(feature = "tauri")]
#[tauri::command]
fn set_maximize_button_rect(
    window: tauri::WebviewWindow,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> bool {
    #[cfg(windows)]
    {
        let rect = snap_layouts::ButtonRect::from_css(
            x,
            y,
            width,
            height,
            window.scale_factor().unwrap_or(1.0),
        );
        let Ok(hwnd) = window.hwnd() else {
            return false;
        };
        let target = window.clone();
        snap_layouts::set_maximize_button_rect(hwnd.0 as isize, rect, move |state| {
            let _ = target.emit("kai-maximize-button-state", state.as_str());
        })
    }
    #[cfg(not(windows))]
    {
        let _ = (window, x, y, width, height);
        false
    }
}

#[cfg(feature = "tauri")]
#[tauri::command(async)]
fn open_external_url_cmd(url: String) -> Result<(), error::TerminalError> {
    shell::open_external_url(&url)
}

#[cfg(feature = "tauri")]
#[tauri::command(async)]
async fn search_youtube_video_cmd(query: String) -> Result<String, error::TerminalError> {
    shell::search_youtube_video(&query).await
}

#[cfg(feature = "tauri")]
#[tauri::command(async)]
async fn search_youtube_videos_cmd(
    query: String,
    limit: Option<usize>,
) -> Result<Vec<shell::YouTubeVideoItem>, error::TerminalError> {
    shell::search_youtube_videos(&query, limit.unwrap_or(8)).await
}

#[cfg(feature = "tauri")]
#[tauri::command(async)]
async fn fetch_youtube_playlist_cmd(
    playlist_id: String,
    limit: Option<usize>,
) -> Result<Vec<shell::YouTubeVideoItem>, error::TerminalError> {
    shell::fetch_youtube_playlist(&playlist_id, limit.unwrap_or(24)).await
}

#[cfg(feature = "tauri")]
#[tauri::command(async)]
fn get_available_shells() -> Vec<ShellProfile> {
    detect_available_shells()
}

#[cfg(feature = "tauri")]
#[tauri::command(async)]
fn get_ai_cli_status() -> Vec<AiCliStatus> {
    detect_ai_clis()
}

#[cfg(feature = "tauri")]
#[tauri::command(async)]
fn get_ai_cli_details() -> Vec<AiCliDetails> {
    detect_ai_cli_details()
}

#[cfg(feature = "tauri")]
#[tauri::command(async)]
fn check_ai_cli_path(id: String, custom_path: String) -> Result<AiCliDetails, String> {
    check_custom_ai_cli_path(&id, &custom_path)
}

#[cfg(feature = "tauri")]
#[tauri::command(async)]
fn get_kai_cli_launch_cmd() -> Result<Vec<String>, String> {
    get_kai_cli_launch()
}

#[cfg(feature = "tauri")]
#[tauri::command(async)]
fn setup_agent_mcp_cmd(
    id: String,
    launcher: Vec<String>,
    project_arg: String,
    force: bool,
    project_dir: Option<String>,
) -> Result<AgentSetupResult, String> {
    setup_agent_mcp(&id, launcher, &project_arg, force, project_dir)
}

#[cfg(feature = "tauri")]
#[tauri::command(async)]
fn get_agent_setup_snippet_cmd(id: String, project_arg: String) -> Result<String, String> {
    ai_cli::agent_setup_snippet(&id, &project_arg)
}

#[cfg(feature = "tauri")]
#[tauri::command(async)]
fn run_integration_rpc_cmd(app_handle: AppHandle, request_json: String) -> Result<String, String> {
    let emitter = app_handle.clone();
    let sink: integrations::SignInUrlSink = Box::new(move |url| {
        let _ = emitter.emit_to("main", "kai-integration:signin-url", url);
    });
    let bundled = app_handle
        .path()
        .resource_dir()
        .ok()
        .and_then(|dir| kai_cli::find_bundled_cli(&dir))
        .zip(kai_cli::find_node_exe())
        .map(|(script, node)| integrations::BundledCli { node, script });
    integrations::run_integration_rpc_with(&request_json, bundled.as_ref(), Some(sink))
}

/// Stops a browser sign-in that is waiting in the Integrations tab.
#[cfg(feature = "tauri")]
#[tauri::command]
fn cancel_integration_sign_in_cmd() -> bool {
    integrations::cancel_browser_sign_in()
}

#[cfg(feature = "tauri")]
#[tauri::command(async)]
fn get_git_info_cmd(cwd: String) -> GitInfo {
    get_git_info(&cwd)
}

#[cfg(feature = "tauri")]
#[tauri::command(async)]
fn run_git_action_cmd(cwd: String, action: String) -> Result<String, String> {
    run_git_action(&cwd, &action)
}

#[cfg(feature = "tauri")]
#[tauri::command(async)]
fn get_git_changes_cmd(cwd: String) -> Result<GitChangesSummary, String> {
    get_git_changes(&cwd)
}

#[cfg(feature = "tauri")]
#[tauri::command(async)]
fn get_git_diff_cmd(cwd: String, path: Option<String>, staged: bool) -> Result<String, String> {
    get_git_diff(&cwd, path.as_deref(), staged)
}

#[cfg(feature = "tauri")]
#[tauri::command(async)]
fn stage_git_file_cmd(cwd: String, path: String) -> Result<String, String> {
    stage_git_file(&cwd, &path)
}

#[cfg(feature = "tauri")]
#[tauri::command(async)]
fn unstage_git_file_cmd(cwd: String, path: String) -> Result<String, String> {
    unstage_git_file(&cwd, &path)
}

#[cfg(feature = "tauri")]
#[tauri::command(async)]
fn discard_git_file_cmd(cwd: String, path: String) -> Result<String, String> {
    discard_git_file(&cwd, &path)
}

#[cfg(feature = "tauri")]
#[tauri::command(async)]
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
fn clear_active_project_cmd() {
    active_project::clear_active_project();
}

#[cfg(feature = "tauri")]
#[tauri::command(async)]
fn open_project_in_editor(
    editor_path: Option<String>,
    cwd: String,
) -> Result<String, error::TerminalError> {
    open_in_editor(editor_path.as_deref(), &cwd)
}

#[cfg(feature = "tauri")]
#[tauri::command(async)]
fn clipboard_text_begin_cmd() -> Result<clipboard::ClipboardSession, error::TerminalError> {
    clipboard::clipboard_text_begin()
}

/// Next piece of the clipboard text held for session `id` (see `clipboard.rs`).
#[cfg(feature = "tauri")]
#[tauri::command(async)]
fn clipboard_text_chunk_cmd(
    id: u64,
    offset: usize,
    max: usize,
) -> Result<clipboard::ClipboardChunk, error::TerminalError> {
    clipboard::clipboard_text_chunk(id, offset, max)
}

/// Release the clipboard text held for session `id`.
#[cfg(feature = "tauri")]
#[tauri::command]
fn clipboard_text_end_cmd(id: u64) {
    clipboard::clipboard_text_end(id);
}

/// Paths of files on the clipboard, or of a PNG saved from a copied image.
#[cfg(feature = "tauri")]
#[tauri::command(async)]
fn read_clipboard_attachments_cmd() -> Result<Vec<String>, error::TerminalError> {
    clipboard::read_clipboard_attachments()
}

/// Open a Ctrl+clicked terminal link (any http/https site) in the browser.
#[cfg(feature = "tauri")]
#[tauri::command(async)]
fn open_terminal_link_cmd(url: String) -> Result<(), error::TerminalError> {
    shell::open_terminal_link(&url)
}

#[cfg(feature = "tauri")]
#[tauri::command(async)]
fn list_system_fonts_cmd() -> Vec<String> {
    fonts::list_system_fonts()
}

#[cfg(feature = "tauri")]
#[tauri::command(async)]
fn is_call_active_cmd() -> bool {
    call_watch::is_call_active()
}

#[cfg(feature = "tauri")]
#[tauri::command(async)]
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
    // A menu/Dock launch has a short PATH; take the login shell's so `az`,
    // `node` and `git` are found as in a terminal. Before any other thread starts.
    #[cfg(unix)]
    login_path::apply_login_shell_path();

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
            } else {
                // If there is no main window (e.g. stale/zombie process), terminate
                // so the new instance can start cleanly.
                std::process::exit(0);
            }
        }))
        .setup(|app| {
            // Release builds carry their own Node.js for the bundled CLI; use it
            // before anything looks for `node` (cheap: a few `stat` calls).
            if let Ok(resource_dir) = app.path().resource_dir() {
                kai_cli::register_bundled_node(&resource_dir);
            }
            call_watch::spawn_call_watcher(app.handle().clone());
            // First-run repair: installer-only users have no `kai` on PATH.
            // Off the UI thread so a slow PowerShell cold start can never
            // stall the first PTY spawn ("Not Responding on launch").
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                let resource_dir = handle.path().resource_dir().ok();
                let _ = kai_cli::ensure_kai_cli(resource_dir);
                // List "Kai Terminal" in VS Code / Cursor / … terminal dropdowns
                // (once per editor; a deleted entry stays deleted).
                let _ = editor_terminal::ensure_editor_terminal_profiles();
                // Sweep leftover update installers (>24h old) off the UI
                // thread: a Windows file lock can block the immediate
                // post-install delete, so the next start finishes the job.
                let _ = crate::updater::cleanup_stale_update_downloads(24 * 60 * 60);
            });
            Ok(())
        })
        .on_window_event(|window, event| match event {
            // Only the main window ends the app; closing the music
            // picture-in-picture window must leave the terminal running.
            tauri::WindowEvent::CloseRequested { .. } if window.label() == "main" => {
                // Hide at once, reap PTY children within a time limit, then exit.
                exit_now(window.app_handle());
            }
            tauri::WindowEvent::Destroyed if window.label() == MUSIC_PIP_LABEL => {
                let _ = window.app_handle().emit(MUSIC_PIP_CLOSED_EVENT, ());
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            close_app_window,
            set_maximize_button_rect,
            open_music_pip,
            close_music_pip,
            get_available_shells,
            get_ai_cli_status,
            get_ai_cli_details,
            check_ai_cli_path,
            get_kai_cli_launch_cmd,
            setup_agent_mcp_cmd,
            get_agent_setup_snippet_cmd,
            run_integration_rpc_cmd,
            cancel_integration_sign_in_cmd,
            get_git_info_cmd,
            run_git_action_cmd,
            get_git_changes_cmd,
            get_git_diff_cmd,
            stage_git_file_cmd,
            unstage_git_file_cmd,
            discard_git_file_cmd,
            open_project_in_editor,
            detect_installed_editors_cmd,
            is_call_active_cmd,
            clipboard_text_begin_cmd,
            clipboard_text_chunk_cmd,
            clipboard_text_end_cmd,
            read_clipboard_attachments_cmd,
            open_terminal_link_cmd,
            list_system_fonts_cmd,
            open_external_url_cmd,
            search_youtube_video_cmd,
            search_youtube_videos_cmd,
            fetch_youtube_playlist_cmd,
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
            get_active_project_cmd,
            clear_active_project_cmd,
            kai_cli::get_kai_cli_status_cmd,
            kai_cli::ensure_kai_cli_cmd,
            updater::download_update_asset_cmd,
            updater::launch_update_installer_cmd,
            updater::get_update_install_hint_cmd,
            updater::get_update_arch_cmd
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::ExitRequested { .. } = event {
                // Same bounded shutdown as closing the window.
                exit_now(app_handle);
            }
        });
}

#[cfg(test)]
mod music_pip_size_tests {
    use super::music_pip_size;

    #[test]
    fn defaults_when_nothing_saved() {
        assert_eq!(music_pip_size(None, None, None), (360.0, 203.0));
        assert_eq!(music_pip_size(Some(500.0), None, None), (360.0, 203.0));
        assert_eq!(
            music_pip_size(Some(f64::NAN), Some(300.0), None),
            (360.0, 203.0)
        );
    }

    #[test]
    fn keeps_a_saved_size() {
        assert_eq!(
            music_pip_size(Some(480.0), Some(270.0), Some((1920.0, 1080.0))),
            (480.0, 270.0)
        );
    }

    #[test]
    fn clamps_to_minimum_and_monitor() {
        assert_eq!(
            music_pip_size(Some(100.0), Some(80.0), None),
            (240.0, 150.0)
        );
        assert_eq!(
            music_pip_size(Some(4000.0), Some(3000.0), Some((1920.0, 1080.0))),
            (1920.0, 1080.0)
        );
    }
}

#[cfg(test)]
mod webview2_args_tests {
    use super::webview2_browser_args;

    #[test]
    fn come_from_the_windows_config_with_autoplay_allowed() {
        let args =
            webview2_browser_args().expect("tauri.windows.conf.json sets additionalBrowserArgs");
        assert!(args.contains("--autoplay-policy=no-user-gesture-required"));
    }
}
