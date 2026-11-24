//! Runtime check of the per-window command ACL (SEC-04).
//!
//! Loads the application's REAL context — `tauri.conf.json`, the generated app ACL
//! manifest and `capabilities/*.json` — into Tauri's mock runtime, then invokes
//! commands the way a webview does, from windows with different labels.
//!
//! The command bodies below are stand-ins: the ACL looks only at a command's NAME
//! and the calling window's LABEL, so this proves what the capability files really
//! enforce without launching a GUI. Run with:
//!
//! ```text
//! cargo test --features gui-test --manifest-path src-tauri/Cargo.toml --test window_acl
//! ```
//!
//! (needs `dist/` — `npm run build` — because the context embeds the frontend).
#![cfg(feature = "gui-test")]

use tauri::ipc::{CallbackFn, InvokeBody};
use tauri::test::{get_ipc_response, mock_builder, INVOKE_KEY};
use tauri::webview::InvokeRequest;
use tauri::{App, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

#[tauri::command]
fn create_pty() -> &'static str {
    "spawned a shell"
}
#[tauri::command]
fn write_to_pty() -> &'static str {
    "wrote to a shell"
}
#[tauri::command]
fn pty_busy_sessions() -> &'static str {
    "busy"
}
#[tauri::command]
fn run_integration_rpc_cmd() -> &'static str {
    "rpc"
}
#[tauri::command]
fn download_update_asset_cmd() -> &'static str {
    "downloaded"
}
#[tauri::command]
fn launch_update_installer_cmd() -> &'static str {
    "installer started"
}
#[tauri::command]
fn setup_agent_mcp_cmd() -> &'static str {
    "agent config written"
}
#[tauri::command]
fn close_music_pip() -> &'static str {
    "closed pip"
}
#[tauri::command]
fn music_relay_url() -> &'static str {
    "relay"
}
#[tauri::command]
fn shared_agent_request_cmd() -> &'static str {
    "chat request"
}
#[tauri::command]
fn shared_agent_stop_cmd() -> &'static str {
    "chat stop"
}
#[tauri::command]
fn close_shared_chat_window() -> &'static str {
    "closed chat"
}

const ALL: [&str; 12] = [
    "create_pty",
    "write_to_pty",
    "pty_busy_sessions",
    "run_integration_rpc_cmd",
    "download_update_asset_cmd",
    "launch_update_installer_cmd",
    "setup_agent_mcp_cmd",
    "close_music_pip",
    "music_relay_url",
    "shared_agent_request_cmd",
    "shared_agent_stop_cmd",
    "close_shared_chat_window",
];

fn app() -> App<tauri::test::MockRuntime> {
    mock_builder()
        .invoke_handler(tauri::generate_handler![
            create_pty,
            write_to_pty,
            pty_busy_sessions,
            run_integration_rpc_cmd,
            download_update_asset_cmd,
            launch_update_installer_cmd,
            setup_agent_mcp_cmd,
            close_music_pip,
            music_relay_url,
            shared_agent_request_cmd,
            shared_agent_stop_cmd,
            close_shared_chat_window
        ])
        .build(tauri::generate_context!())
        .expect("build the app with its real ACL")
}

fn window(
    app: &App<tauri::test::MockRuntime>,
    label: &str,
) -> WebviewWindow<tauri::test::MockRuntime> {
    WebviewWindowBuilder::new(app, label, WebviewUrl::default())
        .build()
        .expect("create window")
}

/// Calls `command` from `window` like the page's own script would.
fn invoke(
    window: &WebviewWindow<tauri::test::MockRuntime>,
    command: &str,
) -> Result<String, String> {
    let url = if cfg!(any(windows, target_os = "android")) {
        "http://tauri.localhost"
    } else {
        "tauri://localhost"
    };
    get_ipc_response(
        window,
        InvokeRequest {
            cmd: command.into(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: url.parse().unwrap(),
            body: InvokeBody::default(),
            headers: Default::default(),
            invoke_key: INVOKE_KEY.to_string(),
        },
    )
    .map(|ok| ok.deserialize::<String>().unwrap())
    .map_err(|err| err.to_string())
}

fn assert_allowed(window: &WebviewWindow<tauri::test::MockRuntime>, command: &str) {
    let result = invoke(window, command);
    assert!(
        result.is_ok(),
        "window `{}` must be allowed to call `{command}`, got {result:?}",
        window.label()
    );
}

fn assert_denied(window: &WebviewWindow<tauri::test::MockRuntime>, command: &str) {
    let result = invoke(window, command);
    let err = result.expect_err(&format!(
        "window `{}` must NOT be able to call `{command}`",
        window.label()
    ));
    assert!(
        err.to_lowercase().contains("not allowed"),
        "`{command}` from `{}` must be rejected by the ACL, got: {err}",
        window.label()
    );
}

#[test]
fn terminal_windows_can_call_every_command() {
    let app = app();
    for label in ["main", "term-1", "term-27"] {
        let w = window(&app, label);
        for command in ALL {
            assert_allowed(&w, command);
        }
    }
}

#[test]
fn music_mini_window_cannot_start_processes_or_touch_the_system() {
    let app = app();
    let w = window(&app, "music-pip");
    assert_allowed(&w, "close_music_pip");
    assert_allowed(&w, "music_relay_url");
    for command in ALL
        .iter()
        .filter(|c| !["close_music_pip", "music_relay_url"].contains(c))
    {
        assert_denied(&w, command);
    }
}

#[test]
fn shared_chat_window_can_chat_but_not_start_processes() {
    let app = app();
    let w = window(&app, "shared-chat");
    for command in [
        "shared_agent_request_cmd",
        "shared_agent_stop_cmd",
        "close_shared_chat_window",
    ] {
        assert_allowed(&w, command);
    }
    for command in [
        "create_pty",
        "write_to_pty",
        "pty_busy_sessions",
        "run_integration_rpc_cmd",
        "download_update_asset_cmd",
        "launch_update_installer_cmd",
        "setup_agent_mcp_cmd",
        "close_music_pip",
        "music_relay_url",
    ] {
        assert_denied(&w, command);
    }
}

#[test]
fn a_window_with_no_capability_can_call_nothing() {
    let app = app();
    let w = window(&app, "some-other-window");
    for command in ALL {
        assert_denied(&w, command);
    }
}
