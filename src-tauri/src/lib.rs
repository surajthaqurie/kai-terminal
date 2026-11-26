pub mod active_project;
pub mod ai_cli;
pub mod autostart;
#[cfg(feature = "tauri")]
pub mod blocking;
pub mod call_watch;
pub mod cli_guard;
pub mod clipboard;
pub mod close_requests;
pub mod diagnostics;
pub mod editor_terminal;
pub mod error;
pub mod fonts;
pub mod git;
pub mod integrations;
pub mod intelligence;
pub mod job_runner;
pub mod kai_cli;
pub mod login_path;
pub mod music_relay;
pub mod pty;
pub mod shared_agent;
pub mod shell;
pub mod shutdown;
pub mod snap_layouts;
pub mod terminal_windows;
#[cfg(feature = "tauri")]
pub mod update_verify;
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
    // The Shared Agent service ends its runs and stops sharing. On its own thread so
    // it never delays the terminals; the closed pipe ends it anyway if the process
    // exits first.
    let service_handle = app_handle.clone();
    std::thread::spawn(move || {
        let service: State<'_, shared_agent::SharedAgentService> = service_handle.state();
        service.stop();
    });
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

/// Closes the window that asked: the whole app when it is the last terminal window,
/// otherwise only that window (its shells are ended when it is destroyed).
#[cfg(feature = "tauri")]
#[tauri::command]
async fn close_app_window(window: tauri::WebviewWindow) {
    let app_handle = window.app_handle().clone();
    let open = terminal_windows::terminal_window_count(&app_handle);
    if terminal_windows::closing_ends_app(open) {
        shutdown_app(&app_handle);
    } else {
        let _ = window.destroy();
    }
}

/// The page answers a [`CLOSE_REQUESTED_EVENT`]: it has the question and deals with it (asks
/// the user, then closes through `close_app_window`, or leaves the window open). Without this
/// the close goes ahead after a short wait, so a page that cannot answer never traps the window.
#[cfg(feature = "tauri")]
#[tauri::command]
fn close_request_ack(
    window: tauri::WebviewWindow,
    requests: State<'_, close_requests::CloseRequests>,
) {
    requests.acknowledge(window.label());
}

/// Sent to a terminal window whose close was requested by the system (Alt+F4, the taskbar, the
/// window menu); the page asks before ending running commands.
#[cfg(feature = "tauri")]
const CLOSE_REQUESTED_EVENT: &str = "kai-close-requested";

/// Label of the detached music picture-in-picture window.
#[cfg(feature = "tauri")]
const MUSIC_PIP_LABEL: &str = "music-pip";

/// Sent to every window once the picture-in-picture window is gone, however it
/// was closed (its own button, Alt+F4, or [`close_music_pip`]).
#[cfg(feature = "tauri")]
const MUSIC_PIP_CLOSED_EVENT: &str = "kai-pip:closed";

/// Label of the Shared Agent chat when it is popped out into its own window.
#[cfg(feature = "tauri")]
const SHARED_CHAT_LABEL: &str = "shared-chat";

/// Sent to every window once the popped-out Shared Agent chat is gone.
#[cfg(feature = "tauri")]
const SHARED_CHAT_CLOSED_EVENT: &str = "kai-shared-chat:closed";

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
fn configured_browser_args() -> Option<String> {
    let conf: serde_json::Value = serde_json::from_str(WINDOWS_CONF).ok()?;
    let args = conf["app"]["windows"][0]["additionalBrowserArgs"].as_str()?;
    (!args.trim().is_empty()).then(|| args.to_string())
}

/// The WebView2 arguments every window of this process is built with, decided
/// once in `run` (see `browser_args_for`). Unset (tests): the configured ones.
#[cfg(any(all(feature = "tauri", target_os = "windows"), test))]
static WEBVIEW2_ARGS: std::sync::OnceLock<Option<String>> = std::sync::OnceLock::new();

#[cfg(any(all(feature = "tauri", target_os = "windows"), test))]
fn webview2_browser_args() -> Option<String> {
    WEBVIEW2_ARGS
        .get()
        .cloned()
        .unwrap_or_else(configured_browser_args)
}

/// Identifier of the end-to-end build (src-tauri/tauri.e2e.conf.json).
#[cfg(any(all(feature = "tauri", target_os = "windows"), test))]
const E2E_IDENTIFIER: &str = "com.kai.terminal.e2e";

/// WebView2 arguments for an app with `identifier`. msedgedriver attaches by
/// putting `--remote-debugging-port=0` (and its other switches) in
/// `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`, but WebView2 does not apply that
/// variable for an elevated process (a CI runner), so the browser never opens
/// its DevTools port and every session fails with "DevToolsActivePort file
/// doesn't exist". The end-to-end build therefore passes the driver's switches
/// itself. Only that build: the identifier is compiled in, so an environment
/// variable can never open a debugging port in the real app.
#[cfg(any(all(feature = "tauri", target_os = "windows"), test))]
fn browser_args_for(
    configured: Option<String>,
    identifier: &str,
    driver: Option<&str>,
) -> Option<String> {
    match driver {
        Some(extra) if identifier == E2E_IDENTIFIER && !extra.trim().is_empty() => Some(
            merge_browser_args(configured.as_deref().unwrap_or(""), extra),
        ),
        _ => configured,
    }
}

/// `base` followed by `extra`, each switch once, and every `--disable-features`
/// list folded into one (Chromium reads only one of them).
#[cfg(any(all(feature = "tauri", target_os = "windows"), test))]
fn merge_browser_args(base: &str, extra: &str) -> String {
    let mut disabled: Vec<&str> = Vec::new();
    let mut others: Vec<&str> = Vec::new();
    for arg in base.split_whitespace().chain(extra.split_whitespace()) {
        if let Some(list) = arg.strip_prefix("--disable-features=") {
            for feature in list.split(',').filter(|f| !f.is_empty()) {
                if !disabled.contains(&feature) {
                    disabled.push(feature);
                }
            }
        } else if !others.contains(&arg) {
            others.push(arg);
        }
    }
    let mut args = Vec::with_capacity(others.len() + 1);
    if !disabled.is_empty() {
        args.push(format!("--disable-features={}", disabled.join(",")));
    }
    args.extend(others.into_iter().map(str::to_string));
    args.join(" ")
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
        app_handle.available_monitors().is_ok_and(|monitors| {
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

/// Opens the Shared Agent chat in its own window, or raises it when it is
/// already open. A normal, resizable window with the system title bar.
#[cfg(feature = "tauri")]
#[tauri::command]
async fn open_shared_chat_window(app_handle: AppHandle) -> Result<(), String> {
    if let Some(window) = app_handle.get_webview_window(SHARED_CHAT_LABEL) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        return Ok(());
    }
    let builder = tauri::WebviewWindowBuilder::new(
        &app_handle,
        SHARED_CHAT_LABEL,
        // Same bundle as the main window; `main.tsx` picks the chat view.
        tauri::WebviewUrl::App("index.html?window=shared-chat".into()),
    )
    .title("Kai · Shared Agent chat")
    .inner_size(460.0, 640.0)
    .min_inner_size(340.0, 360.0)
    .resizable(true)
    .focused(true);
    #[cfg(target_os = "windows")]
    let builder = match webview2_browser_args() {
        Some(args) => builder.additional_browser_args(&args),
        None => builder,
    };
    builder.build().map_err(|e| e.to_string())?;
    Ok(())
}

/// Closes the popped-out Shared Agent chat (a no-op when it is not open).
#[cfg(feature = "tauri")]
#[tauri::command]
async fn close_shared_chat_window(app_handle: AppHandle) {
    if let Some(window) = app_handle.get_webview_window(SHARED_CHAT_LABEL) {
        let _ = window.destroy();
    }
}

/// URL of the local page that hosts the YouTube embed where the app's own
/// origin cannot control it (macOS / Linux; see `music_relay.rs`).
#[cfg(feature = "tauri")]
#[tauri::command]
fn music_relay_url() -> Result<String, String> {
    music_relay::relay_url()
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
        if let Some(main) = terminal_windows::primary_terminal_window(&app_handle) {
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
            // Only the window that owns the overlay hears its button's state.
            let _ = target.emit_to(target.label(), "kai-maximize-button-state", state.as_str());
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
    video_id: Option<String>,
) -> Result<Vec<shell::YouTubeVideoItem>, error::TerminalError> {
    shell::fetch_youtube_playlist(&playlist_id, limit.unwrap_or(24), video_id.as_deref()).await
}

#[cfg(feature = "tauri")]
#[tauri::command(async)]
async fn get_available_shells() -> Result<Vec<ShellProfile>, String> {
    blocking::run(detect_available_shells).await
}

#[cfg(feature = "tauri")]
#[tauri::command(async)]
async fn get_ai_cli_status() -> Result<Vec<AiCliStatus>, String> {
    blocking::run(detect_ai_clis).await
}

#[cfg(feature = "tauri")]
#[tauri::command(async)]
async fn get_ai_cli_details() -> Result<Vec<AiCliDetails>, String> {
    blocking::run(detect_ai_cli_details).await
}

#[cfg(feature = "tauri")]
#[tauri::command(async)]
async fn check_ai_cli_path(id: String, custom_path: String) -> Result<AiCliDetails, String> {
    blocking::run_flat(move || check_custom_ai_cli_path(&id, &custom_path)).await
}

#[cfg(feature = "tauri")]
#[tauri::command(async)]
fn get_kai_cli_launch_cmd() -> Result<Vec<String>, String> {
    get_kai_cli_launch()
}

#[cfg(feature = "tauri")]
#[tauri::command(async)]
async fn setup_agent_mcp_cmd(
    id: String,
    // There is deliberately no `launcher` argument: the command an agent is told to run is
    // resolved here, from the installed CLI. A launcher supplied by the webview would let a
    // compromised page persist an arbitrary command into `~/.claude.json` and friends (SEC-08).
    // The webview and this backend ship in one binary, so no older frontend sends one.
    project_arg: String,
    force: bool,
    project_dir: Option<String>,
) -> Result<AgentSetupResult, String> {
    blocking::run_flat(move || {
        let launcher = get_kai_cli_launch()?;
        setup_agent_mcp(&id, launcher, &project_arg, force, project_dir)
    })
    .await
}

#[cfg(feature = "tauri")]
#[tauri::command(async)]
fn get_agent_setup_snippet_cmd(id: String, project_arg: String) -> Result<String, String> {
    ai_cli::agent_setup_snippet(&id, &project_arg)
}

#[cfg(feature = "tauri")]
#[tauri::command(async)]
async fn run_integration_rpc_cmd(
    app_handle: AppHandle,
    window: tauri::WebviewWindow,
    request_json: String,
) -> Result<String, String> {
    // The sign-in link goes back to the window whose Integrations tab asked for it.
    let asker = window.label().to_string();
    // A browser sign-in waits for minutes: it must not hold an async worker (see `blocking`).
    blocking::run_flat(move || {
        let emitter = app_handle.clone();
        let sink: integrations::SignInUrlSink = Box::new(move |url| {
            let _ = emitter.emit_to(asker.as_str(), "kai-integration:signin-url", url);
        });
        let bundled = app_handle
            .path()
            .resource_dir()
            .ok()
            .and_then(|dir| kai_cli::find_bundled_cli(&dir))
            .zip(kai_cli::find_node_exe())
            .map(|(script, node)| integrations::BundledCli { node, script });
        integrations::run_integration_rpc_with(&request_json, bundled.as_ref(), Some(sink))
    })
    .await
}

/// Stops a browser sign-in that is waiting in the Integrations tab.
#[cfg(feature = "tauri")]
#[tauri::command]
fn cancel_integration_sign_in_cmd() -> bool {
    integrations::cancel_browser_sign_in()
}

/// One request to the Shared Agent service (started on first use). Answers come
/// back here; events the service pushes (chat text, joined-PC changes) reach the
/// window as `kai-shared-agent:event`.
#[cfg(feature = "tauri")]
#[tauri::command(async)]
async fn shared_agent_request_cmd(
    app_handle: AppHandle,
    request_json: String,
) -> Result<String, String> {
    // Waits for the service's answer (up to 45 s): off the async workers (see `blocking`).
    blocking::run_flat(move || {
        let service: State<'_, shared_agent::SharedAgentService> = app_handle.state();
        let emitter = app_handle.clone();
        let sink: shared_agent::EventSink = Arc::new(move |line| {
            // The popped-out chat window, when open, needs the chat text too.
            terminal_windows::emit_to_terminal_windows(
                &emitter,
                "kai-shared-agent:event",
                line.clone(),
            );
            if emitter.get_webview_window(SHARED_CHAT_LABEL).is_some() {
                let _ = emitter.emit_to(SHARED_CHAT_LABEL, "kai-shared-agent:event", line);
            }
        });
        let bundled = app_handle
            .path()
            .resource_dir()
            .ok()
            .and_then(|dir| kai_cli::find_bundled_cli(&dir))
            .zip(kai_cli::find_node_exe())
            .map(|(script, node)| integrations::BundledCli { node, script });
        service.request(&request_json, bundled.as_ref(), sink)
    })
    .await
}

/// Stops the Shared Agent service (sharing ends, every run is stopped).
#[cfg(feature = "tauri")]
#[tauri::command(async)]
fn shared_agent_stop_cmd(service: State<'_, shared_agent::SharedAgentService>) -> bool {
    service.stop()
}

#[cfg(feature = "tauri")]
#[tauri::command(async)]
async fn get_git_info_cmd(cwd: String) -> Result<GitInfo, String> {
    blocking::run(move || get_git_info(&cwd)).await
}

#[cfg(feature = "tauri")]
#[tauri::command(async)]
async fn run_git_action_cmd(cwd: String, action: String) -> Result<String, String> {
    blocking::run_flat(move || run_git_action(&cwd, &action)).await
}

#[cfg(feature = "tauri")]
#[tauri::command(async)]
async fn get_git_changes_cmd(cwd: String) -> Result<GitChangesSummary, String> {
    blocking::run_flat(move || get_git_changes(&cwd)).await
}

#[cfg(feature = "tauri")]
#[tauri::command(async)]
async fn get_git_diff_cmd(
    cwd: String,
    path: Option<String>,
    staged: bool,
) -> Result<String, String> {
    blocking::run_flat(move || get_git_diff(&cwd, path.as_deref(), staged)).await
}

#[cfg(feature = "tauri")]
#[tauri::command(async)]
async fn stage_git_file_cmd(cwd: String, path: String) -> Result<String, String> {
    blocking::run_flat(move || stage_git_file(&cwd, &path)).await
}

#[cfg(feature = "tauri")]
#[tauri::command(async)]
async fn unstage_git_file_cmd(cwd: String, path: String) -> Result<String, String> {
    blocking::run_flat(move || unstage_git_file(&cwd, &path)).await
}

#[cfg(feature = "tauri")]
#[tauri::command(async)]
async fn discard_git_file_cmd(cwd: String, path: String) -> Result<String, String> {
    blocking::run_flat(move || discard_git_file(&cwd, &path)).await
}

#[cfg(feature = "tauri")]
#[tauri::command(async)]
async fn get_project_intelligence_cmd(
    cwd: String,
) -> Result<intelligence::ProjectIntelligenceSummary, String> {
    blocking::run(move || intelligence::get_project_intelligence(&cwd)).await
}

/// Single source of truth for Code Mode: `kai code <path>` sets it,
/// `kai stop code` clears it. Never defaults to code, never falls back
/// to recent history. Works in dev and release builds (release WebViews
/// use a different localStorage file, so the CLI's state file + launch
/// env are authoritative — not a SQLite localStorage hack).
#[cfg(feature = "tauri")]
#[tauri::command(async)]
fn get_active_project_cmd() -> active_project::ActiveProject {
    active_project::get_active_project()
}

#[cfg(feature = "tauri")]
#[tauri::command(async)]
fn clear_active_project_cmd() {
    active_project::clear_active_project();
}

#[cfg(feature = "tauri")]
#[tauri::command(async)]
async fn open_project_in_editor(
    editor_path: Option<String>,
    cwd: String,
) -> Result<String, error::TerminalError> {
    blocking::run_terminal(move || open_in_editor(editor_path.as_deref(), &cwd)).await
}

#[cfg(feature = "tauri")]
#[tauri::command(async)]
async fn clipboard_text_begin_cmd() -> Result<clipboard::ClipboardSession, error::TerminalError> {
    blocking::run_terminal(clipboard::clipboard_text_begin).await
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
async fn read_clipboard_attachments_cmd() -> Result<Vec<String>, error::TerminalError> {
    blocking::run_terminal(clipboard::read_clipboard_attachments).await
}

/// Open a Ctrl+clicked terminal link (any http/https site) in the browser.
#[cfg(feature = "tauri")]
#[tauri::command(async)]
fn open_terminal_link_cmd(url: String) -> Result<(), error::TerminalError> {
    shell::open_terminal_link(&url)
}

#[cfg(feature = "tauri")]
#[tauri::command(async)]
async fn list_system_fonts_cmd() -> Result<Vec<String>, String> {
    blocking::run(fonts::list_system_fonts).await
}

/// The music player asks for call detection only while it needs it (playing, or paused
/// by a call and waiting for it to end); otherwise no process is started for it.
#[cfg(feature = "tauri")]
#[tauri::command]
fn call_watch_set_enabled(enabled: bool) {
    call_watch::call_watch_gate().set_enabled(enabled);
}

#[cfg(feature = "tauri")]
#[tauri::command(async)]
async fn is_call_active_cmd() -> Result<bool, String> {
    blocking::run(call_watch::is_call_active).await
}

#[cfg(feature = "tauri")]
#[tauri::command(async)]
async fn detect_installed_editors_cmd() -> Result<Vec<EditorInfo>, String> {
    blocking::run(detect_installed_editors).await
}

#[cfg(feature = "tauri")]
#[tauri::command(async)]
async fn get_diagnostics(app_handle: AppHandle) -> Result<diagnostics::DiagnosticsReport, String> {
    blocking::run(move || {
        let state: State<'_, PtyManager> = app_handle.state();
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
    })
    .await
}

#[cfg(feature = "tauri")]
// PTY and file/registry commands run off the main thread (`async`): Tauri runs
// plain sync commands ON the UI thread, so every keystroke write, resize and
// shell spawn (ConPTY creation takes 50-200 ms) blocked painting and input.
// Per-terminal ordering is kept by the frontend: writes are awaited in a
// queue and resizes go through a latest-wins serializer.
#[tauri::command(async)]
fn create_pty(
    app_handle: AppHandle,
    window: tauri::WebviewWindow,
    state: State<'_, PtyManager>,
    options: PtyCreateOptions,
) -> Result<PtySessionInfo, error::TerminalError> {
    // Events go to the window that created the session, and follow it if its tab
    // is moved to another window (`PtyManager::set_owner`), never to every window.
    let emitter = Arc::new(pty::TauriEventEmitter {
        app_handle,
        routes: state.routes(),
        default_owner: window.label().to_string(),
    });
    let info = state.create_pty(emitter, options)?;
    // Remember which window shows it: closing that window ends the session.
    state.set_owner(&info.id, window.label());
    Ok(info)
}

#[cfg(feature = "tauri")]
#[tauri::command(async)]
fn write_to_pty(
    state: State<'_, PtyManager>,
    id: String,
    data: String,
) -> Result<(), error::TerminalError> {
    state.write_to_pty(&id, &data)
}

#[cfg(feature = "tauri")]
#[tauri::command(async)]
fn resize_pty(
    state: State<'_, PtyManager>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), error::TerminalError> {
    state.resize_pty(&id, cols, rows)
}

#[cfg(feature = "tauri")]
#[tauri::command(async)]
fn close_pty(state: State<'_, PtyManager>, id: String) -> Result<(), error::TerminalError> {
    state.close_pty(&id)
}

/// The frontend has handed `bytes` of session `id`'s output to the terminal
/// emulator: frees credit so a flooding program can keep writing (flow control).
#[cfg(feature = "tauri")]
#[tauri::command(async)]
fn pty_ack(state: State<'_, PtyManager>, id: String, bytes: u64) {
    state.ack_output(&id, bytes);
}

/// Which of the given sessions have a command running (not just an idle shell).
/// Backs the "this will end running processes" confirmation before a close.
#[cfg(feature = "tauri")]
#[tauri::command(async)]
fn pty_busy_sessions(state: State<'_, PtyManager>, ids: Vec<String>) -> Vec<String> {
    state.busy_sessions(&ids)
}

#[cfg(feature = "tauri")]
#[tauri::command(async)]
fn get_autostart_enabled() -> bool {
    autostart::is_autostart_enabled()
}

#[cfg(feature = "tauri")]
#[tauri::command(async)]
fn set_autostart_enabled(enabled: bool) -> Result<(), error::TerminalError> {
    autostart::set_autostart_enabled(enabled)
}

#[cfg(feature = "tauri")]
#[tauri::command(async)]
fn get_session_info(state: State<'_, PtyManager>, id: String) -> Option<PtySessionInfo> {
    state.get_session_info(&id)
}

#[cfg(feature = "tauri")]
#[tauri::command(async)]
fn get_pty_cwd(state: State<'_, PtyManager>, id: String) -> Option<String> {
    state.get_session_cwd(&id)
}

#[cfg(feature = "tauri")]
#[tauri::command(async)]
fn get_system_terminal_config() -> shell::SystemTerminalConfig {
    shell::detect_system_terminal_config()
}

#[cfg(feature = "tauri")]
#[tauri::command]
fn get_app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[cfg(feature = "tauri")]
#[tauri::command(async)]
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

    #[allow(unused_mut)] // only Windows changes the context
    let mut context = tauri::generate_context!();
    // One set of WebView2 arguments for the config's windows and the ones made
    // in code (WebView2 refuses a window whose arguments differ).
    #[cfg(target_os = "windows")]
    {
        let driver = std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").ok();
        let args = browser_args_for(
            configured_browser_args(),
            &context.config().identifier,
            driver.as_deref(),
        );
        for window in context.config_mut().app.windows.iter_mut() {
            window.additional_browser_args = args.clone();
        }
        let _ = WEBVIEW2_ARGS.set(args);
    }

    tauri::Builder::default()
        .manage(pty_manager)
        .manage(terminal_windows::WindowSeeds::default())
        .manage(close_requests::CloseRequests::default())
        .manage(shared_agent::SharedAgentService::default())
        // Single-instance enforcement (Windows / Linux / macOS): a second
        // launch never starts a second process (no duplicate "ghost" app).
        // The plugin routes it here in the FIRST (already running) process.
        // A `kai <path>` / `kai code` launch focuses a terminal window and
        // forwards the path via `kai-open-project` (the frontend re-syncs Code
        // Mode from the state file the CLI already wrote). A plain launch of
        // the app (Start menu, Dock, desktop icon) opens one more window, the
        // way an editor does, so the user can have several. The second process
        // exits either way. The Node `isKaiAppRunning()` fast-path avoids the
        // spawn in the common case; this is the authoritative cross-OS
        // guarantee that closes the check-then-launch race (two rapid
        // `kai code .` calls) and the process-name false-negative
        // (AppImage/snap/renamed binaries, localized `tasklist`, truncated
        // `comm`).
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if let Some(window) = terminal_windows::primary_terminal_window(app) {
                if crate::cli_guard::is_bare_launch(&args) {
                    // Off this callback's thread: building a window waits on the
                    // main thread.
                    let handle = app.clone();
                    std::thread::spawn(move || {
                        let _ = terminal_windows::open_window(&handle, None, &[], None);
                    });
                } else {
                    let _ = window.unminimize();
                    let _ = window.show();
                    let _ = window.set_focus();
                }
                if let Some(path) = crate::cli_guard::gui_path_from_args(&args) {
                    let _ = app.emit_to(
                        window.label(),
                        "kai-open-project",
                        serde_json::json!({ "path": path }),
                    );
                } else {
                    // Still wake the frontend so it re-syncs Code Mode state
                    // (covers `kai code` written externally).
                    let _ = app.emit_to(window.label(), "kai-open-project", serde_json::json!({}));
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
            // Closing the LAST terminal window ends the app; closing the music
            // picture-in-picture window, or one of several terminal windows,
            // leaves the rest running.
            tauri::WindowEvent::CloseRequested { api, .. }
                if terminal_windows::is_terminal_label(window.label()) =>
            {
                let requests: State<'_, close_requests::CloseRequests> =
                    window.app_handle().state();
                match requests.on_close_requested(window.label()) {
                    close_requests::Decision::Ask(question) => {
                        // Hold the close back and let the page ask before it ends running
                        // commands. If the page cannot answer, the close goes ahead.
                        api.prevent_close();
                        let _ = window.emit_to(window.label(), CLOSE_REQUESTED_EVENT, ());
                        let waiting = window.clone();
                        std::thread::spawn(move || {
                            std::thread::sleep(close_requests::ANSWER_WAIT);
                            let requests: State<'_, close_requests::CloseRequests> =
                                waiting.app_handle().state();
                            if requests.approve_if_unanswered(waiting.label(), question) {
                                let _ = waiting.close();
                            }
                        });
                    }
                    close_requests::Decision::AlreadyAsking => api.prevent_close(),
                    close_requests::Decision::Allow => {
                        let open = terminal_windows::terminal_window_count(window.app_handle());
                        if terminal_windows::closing_ends_app(open) {
                            // Hide at once, reap PTY children within a time limit, then exit.
                            exit_now(window.app_handle());
                        }
                        // Otherwise the window just closes; `Destroyed` ends its shells.
                    }
                }
            }
            // A closed terminal window takes its shells with it. React cleanup is
            // not guaranteed once a webview is torn down, so the backend does it,
            // off the event thread (closing a Windows pseudo-console can block).
            tauri::WindowEvent::Destroyed
                if terminal_windows::is_terminal_label(window.label()) =>
            {
                let app = window.app_handle().clone();
                let label = window.label().to_string();
                std::thread::spawn(move || {
                    app.state::<close_requests::CloseRequests>().forget(&label);
                    app.state::<terminal_windows::WindowSeeds>().discard(&label);
                    let pty: State<'_, PtyManager> = app.state();
                    pty.close_sessions_owned_by(&label);
                });
            }
            tauri::WindowEvent::Destroyed if window.label() == MUSIC_PIP_LABEL => {
                let _ = window.app_handle().emit(MUSIC_PIP_CLOSED_EVENT, ());
            }
            tauri::WindowEvent::Destroyed if window.label() == SHARED_CHAT_LABEL => {
                let _ = window.app_handle().emit(SHARED_CHAT_CLOSED_EVENT, ());
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            close_app_window,
            close_request_ack,
            set_maximize_button_rect,
            open_music_pip,
            close_music_pip,
            open_shared_chat_window,
            close_shared_chat_window,
            music_relay_url,
            get_available_shells,
            get_ai_cli_status,
            get_ai_cli_details,
            check_ai_cli_path,
            get_kai_cli_launch_cmd,
            setup_agent_mcp_cmd,
            get_agent_setup_snippet_cmd,
            run_integration_rpc_cmd,
            cancel_integration_sign_in_cmd,
            shared_agent_request_cmd,
            shared_agent_stop_cmd,
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
            terminal_windows::open_terminal_window,
            terminal_windows::take_window_seed,
            terminal_windows::pty_handoff_begin,
            terminal_windows::pty_handoff_finish,
            create_pty,
            write_to_pty,
            resize_pty,
            close_pty,
            get_pty_cwd,
            pty_busy_sessions,
            pty_ack,
            call_watch_set_enabled,
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
        .build(context)
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
    use super::{browser_args_for, merge_browser_args, webview2_browser_args, E2E_IDENTIFIER};

    #[test]
    fn come_from_the_windows_config_with_autoplay_allowed() {
        let args =
            webview2_browser_args().expect("tauri.windows.conf.json sets additionalBrowserArgs");
        assert!(args.contains("--autoplay-policy=no-user-gesture-required"));
    }

    #[test]
    fn the_e2e_identifier_matches_the_e2e_config() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.e2e.conf.json")).unwrap();
        assert_eq!(conf["identifier"], E2E_IDENTIFIER);
    }

    const DRIVER: &str = "--disable-features=IgnoreDuplicateNavs,Prewarm --enable-automation \
                          --remote-debugging-port=0 --test-type=webdriver";

    #[test]
    fn the_e2e_build_takes_the_drivers_switches() {
        let args = browser_args_for(
            Some("--disable-features=AppFeature --autoplay-policy=no-user-gesture-required".into()),
            E2E_IDENTIFIER,
            Some(DRIVER),
        )
        .unwrap();
        assert_eq!(
            args,
            "--disable-features=AppFeature,IgnoreDuplicateNavs,Prewarm \
             --autoplay-policy=no-user-gesture-required --enable-automation \
             --remote-debugging-port=0 --test-type=webdriver"
        );
    }

    #[test]
    fn the_real_app_ignores_the_variable() {
        let configured = Some("--autoplay-policy=no-user-gesture-required".to_string());
        assert_eq!(
            browser_args_for(configured.clone(), "com.kai.terminal", Some(DRIVER)),
            configured
        );
        assert_eq!(
            browser_args_for(configured.clone(), E2E_IDENTIFIER, None),
            configured
        );
    }

    #[test]
    fn merging_keeps_each_switch_once() {
        assert_eq!(
            merge_browser_args(
                "--a --disable-features=X,Y",
                "--a --b --disable-features=Y,Z"
            ),
            "--disable-features=X,Y,Z --a --b"
        );
    }
}
