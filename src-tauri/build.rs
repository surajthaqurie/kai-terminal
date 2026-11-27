/// Tauri's default Windows manifest (Common Controls v6) plus the Windows
/// compatibility declaration. Without `supportedOS`, Windows treats the app as
/// a legacy one and refuses layered child windows (`WS_EX_LAYERED` on a
/// `WS_CHILD`), which the Windows 11 snap-layouts overlay needs
/// (`src/snap_layouts.rs`).
#[cfg(any(feature = "tauri", feature = "tauri-build"))]
const WINDOWS_APP_MANIFEST: &str = r#"<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <dependency>
    <dependentAssembly>
      <assemblyIdentity
        type="win32"
        name="Microsoft.Windows.Common-Controls"
        version="6.0.0.0"
        processorArchitecture="*"
        publicKeyToken="6595b64144ccf1df"
        language="*"
      />
    </dependentAssembly>
  </dependency>
  <compatibility xmlns="urn:schemas-microsoft-com:compatibility.v1">
    <application>
      <supportedOS Id="{e2011457-1546-43c5-a5fe-008deee3d3f0}"/>
      <supportedOS Id="{35138b9a-5d96-4fbd-8e2d-a2440225f93a}"/>
      <supportedOS Id="{4a2f28e3-53b9-4441-ba9c-d69d4a4a6e38}"/>
      <supportedOS Id="{1f676c76-80e1-4239-95bb-83d0f6d0da78}"/>
      <supportedOS Id="{8e0f7a12-bfb3-4fe8-b9a5-48fd50a15a9a}"/>
    </application>
  </compatibility>
</assembly>
"#;

/// tauri-build embeds the manifest above into the application binary only. An
/// executable that links the GUI stack (webview2-com) without a Common Controls
/// v6 manifest cannot even start on Windows (`STATUS_ENTRYPOINT_NOT_FOUND`;
/// observed with the `windows-gnu` toolchain), which would make the GUI-feature
/// integration tests (`tests/window_acl.rs`) unrunnable there. Give integration-test
/// executables the same manifest. `-tests` link args never apply to the application
/// binary, so it is not embedded twice, and Cargo does not apply them to the
/// library's own unit tests. Must run after `tauri_build::try_build` (the GNU
/// toolchain links the resource archive it produces).
#[cfg(any(feature = "tauri", feature = "tauri-build"))]
fn embed_manifest_in_test_binaries() {
    let target = |key: &str| std::env::var(key).unwrap_or_default();
    if target("CARGO_CFG_TARGET_OS") != "windows" {
        return;
    }
    let Some(out_dir) = std::env::var_os("OUT_DIR") else {
        return;
    };
    let out_dir = std::path::PathBuf::from(out_dir);
    match target("CARGO_CFG_TARGET_ENV").as_str() {
        "msvc" => {
            let path = out_dir.join("kai-test.manifest");
            if std::fs::write(&path, WINDOWS_APP_MANIFEST).is_ok() {
                println!("cargo:rustc-link-arg-tests=/MANIFEST:EMBED");
                println!(
                    "cargo:rustc-link-arg-tests=/MANIFESTINPUT:{}",
                    path.display()
                );
            }
        }
        "gnu" => {
            // tauri-build compiles the manifest (and icon) into this archive.
            let resource = out_dir.join("libresource.a");
            if resource.exists() {
                println!("cargo:rustc-link-arg-tests={}", resource.display());
            }
        }
        _ => {}
    }
}

/// Every command the webview can invoke: exactly the `generate_handler!` list in
/// `src/lib.rs` (the `tauriCapabilities` test fails when the two drift).
///
/// Declaring them here turns on Tauri's ACL for app commands: each one gets an
/// `allow-<name>` permission, and a window may call it only if one of its
/// capability files (`capabilities/*.json`) grants that permission. Without this
/// manifest every command was callable from every window, including the music
/// and chat windows, which embed third-party content.
#[cfg(any(feature = "tauri", feature = "tauri-build"))]
const APP_COMMANDS: &[&str] = &[
    "close_app_window",
    "close_request_ack",
    "set_maximize_button_rect",
    "open_music_pip",
    "close_music_pip",
    "open_shared_chat_window",
    "close_shared_chat_window",
    "music_relay_url",
    "get_available_shells",
    "get_ai_cli_status",
    "get_ai_cli_details",
    "check_ai_cli_path",
    "get_kai_cli_launch_cmd",
    "setup_agent_mcp_cmd",
    "get_agent_setup_snippet_cmd",
    "run_integration_rpc_cmd",
    "cancel_integration_sign_in_cmd",
    "shared_agent_request_cmd",
    "shared_agent_stop_cmd",
    "get_git_info_cmd",
    "run_git_action_cmd",
    "get_git_changes_cmd",
    "get_git_diff_cmd",
    "stage_git_file_cmd",
    "unstage_git_file_cmd",
    "discard_git_file_cmd",
    "open_project_in_editor",
    "detect_installed_editors_cmd",
    "is_call_active_cmd",
    "clipboard_text_begin_cmd",
    "clipboard_text_chunk_cmd",
    "clipboard_text_end_cmd",
    "read_clipboard_attachments_cmd",
    "open_terminal_link_cmd",
    "list_system_fonts_cmd",
    "open_external_url_cmd",
    "search_youtube_video_cmd",
    "search_youtube_videos_cmd",
    "fetch_youtube_playlist_cmd",
    "get_diagnostics",
    "open_terminal_window",
    "take_window_seed",
    "terminal_window_at",
    "send_tab_to_window",
    "take_incoming_tabs",
    "merge_terminal_windows",
    "pty_handoff_begin",
    "pty_handoff_finish",
    "create_pty",
    "write_to_pty",
    "resize_pty",
    "close_pty",
    "get_pty_cwd",
    "pty_busy_sessions",
    "pty_ack",
    "call_watch_set_enabled",
    "get_system_terminal_config",
    "get_app_version",
    "get_autostart_enabled",
    "set_autostart_enabled",
    "get_session_info",
    "list_sessions",
    "get_project_intelligence_cmd",
    "get_active_project_cmd",
    "clear_active_project_cmd",
    "get_kai_cli_status_cmd",
    "ensure_kai_cli_cmd",
    "download_update_asset_cmd",
    "launch_update_installer_cmd",
    "get_update_install_hint_cmd",
    "get_update_arch_cmd",
];

fn main() {
    #[cfg(any(feature = "tauri", feature = "tauri-build"))]
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(APP_COMMANDS))
            .windows_attributes(
                tauri_build::WindowsAttributes::new().app_manifest(WINDOWS_APP_MANIFEST),
            ),
    )
    .expect("failed to run tauri-build");
    #[cfg(any(feature = "tauri", feature = "tauri-build"))]
    embed_manifest_in_test_binaries();
}
