use kai::error::TerminalError;
use kai::pty::{
    PtyCreateOptions, PtyExitPayload, PtyManager, PtyOutputPayload, SessionStatus,
    TerminalEventEmitter,
};
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Test event emitter recording output payloads and process exit signals.
#[derive(Clone)]
struct TestEventEmitter {
    output_logs: Arc<Mutex<Vec<String>>>,
    exited: Arc<AtomicBool>,
    exit_code: Arc<Mutex<Option<i32>>>,
}

impl TestEventEmitter {
    fn new() -> (Self, Arc<Mutex<Vec<String>>>, Arc<AtomicBool>) {
        let logs = Arc::new(Mutex::new(Vec::new()));
        let exited = Arc::new(AtomicBool::new(false));
        let exit_code = Arc::new(Mutex::new(None));
        (
            Self {
                output_logs: logs.clone(),
                exited: exited.clone(),
                exit_code,
            },
            logs,
            exited,
        )
    }

    fn get_text(&self) -> String {
        if let Ok(l) = self.output_logs.lock() {
            l.join("")
        } else {
            String::new()
        }
    }

    fn wait_for_output(&self, expected: &str, timeout_secs: u64) -> bool {
        let start = Instant::now();
        while start.elapsed() < Duration::from_secs(timeout_secs) {
            if self.get_text().contains(expected) {
                return true;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        false
    }
}

impl TerminalEventEmitter for TestEventEmitter {
    fn emit_output(&self, payload: PtyOutputPayload) {
        if let Ok(mut logs) = self.output_logs.lock() {
            logs.push(payload.data);
        }
    }

    fn emit_exit(&self, payload: PtyExitPayload) {
        self.exited.store(true, Ordering::SeqCst);
        if let Ok(mut code) = self.exit_code.lock() {
            *code = payload.exit_code;
        }
    }
}

fn default_test_shell() -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        Some(std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".to_string()))
    }
    #[cfg(not(target_os = "windows"))]
    {
        None
    }
}

// ---------------------------------------------------------------------------
// 1. PTY Creation and Shell Startup
// ---------------------------------------------------------------------------
#[test]
fn test_01_pty_creation_and_shell_startup() {
    let manager = PtyManager::new();
    let (emitter, _logs, _) = TestEventEmitter::new();

    let mut custom_env = HashMap::new();
    custom_env.insert(
        "INIT_TEST_ENV_VAR".to_string(),
        "CUSTOM_ENV_VAL_999".to_string(),
    );

    let session_info = manager
        .create_pty(
            Arc::new(emitter.clone()),
            PtyCreateOptions {
                shell_path: default_test_shell(),
                args: None,
                cwd: None,
                cols: 90,
                rows: 30,
                env: Some(custom_env),
            },
        )
        .expect("Failed to create default shell PTY session");

    std::thread::sleep(Duration::from_millis(500));

    assert!(
        !session_info.id.is_empty(),
        "Session ID should be valid UUID"
    );
    assert_eq!(session_info.cols, 90);
    assert_eq!(session_info.rows, 30);
    assert_eq!(session_info.status, SessionStatus::Connected);

    // Verify passed environment variable
    #[cfg(not(target_os = "windows"))]
    let env_cmd = "echo $INIT_TEST_ENV_VAR\n";
    #[cfg(target_os = "windows")]
    let env_cmd = "echo %INIT_TEST_ENV_VAR%\r\n";

    manager.write_to_pty(&session_info.id, env_cmd).unwrap();
    // Generous budget: shell startup + first output can stall for seconds
    // on loaded machines (busy dev desktops, AV-hooked CI runners). The
    // poll returns early on success, so this costs nothing on fast hosts.
    assert!(
        emitter.wait_for_output("CUSTOM_ENV_VAL_999", 15),
        "Custom environment variables passed to create_pty must be present in shell"
    );

    manager.close_pty(&session_info.id).unwrap();
}

// ---------------------------------------------------------------------------
// 2. Persistent Shell Variables
// ---------------------------------------------------------------------------
#[test]
fn test_02_persistent_shell_variables() {
    let manager = PtyManager::new();
    let (emitter, _, _) = TestEventEmitter::new();

    let session = manager
        .create_pty(
            Arc::new(emitter.clone()),
            PtyCreateOptions {
                shell_path: default_test_shell(),
                args: None,
                cwd: None,
                cols: 80,
                rows: 24,
                env: None,
            },
        )
        .expect("Failed to spawn PTY session");

    // Write 1: Set persistent variable
    #[cfg(not(target_os = "windows"))]
    let set_var_cmd = "STATE_VAR_123=PERSISTENT_DATA_VALUE\n";
    #[cfg(target_os = "windows")]
    let set_var_cmd = "set STATE_VAR_123=PERSISTENT_DATA_VALUE\r\n";

    manager.write_to_pty(&session.id, set_var_cmd).unwrap();
    std::thread::sleep(Duration::from_millis(500));

    // Write 2: Access variable in second command
    #[cfg(not(target_os = "windows"))]
    let read_var_cmd = "echo $STATE_VAR_123\n";
    #[cfg(target_os = "windows")]
    let read_var_cmd = "echo %STATE_VAR_123%\r\n";

    manager.write_to_pty(&session.id, read_var_cmd).unwrap();

    assert!(
        emitter.wait_for_output("PERSISTENT_DATA_VALUE", 5),
        "Shell variable state must persist across multiple write calls within same PTY session"
    );

    manager.close_pty(&session.id).unwrap();
}

// ---------------------------------------------------------------------------
// 3. Input/Output Correctness
// ---------------------------------------------------------------------------
#[test]
fn test_03_input_output_correctness() {
    let manager = PtyManager::new();
    let (emitter, _, _) = TestEventEmitter::new();

    let session = manager
        .create_pty(
            Arc::new(emitter.clone()),
            PtyCreateOptions {
                shell_path: default_test_shell(),
                args: None,
                cwd: None,
                cols: 80,
                rows: 24,
                env: None,
            },
        )
        .expect("Failed to spawn PTY session");

    std::thread::sleep(Duration::from_millis(500));

    let special_payload = "ECHO_SPEC_CHARS:!@#$%^&*()_+-=[]{}|;:,.<>?/~`";
    #[cfg(not(target_os = "windows"))]
    let echo_cmd = format!("echo '{}'\n", special_payload);
    #[cfg(target_os = "windows")]
    let echo_cmd = format!("echo \"{}\"\r\n", special_payload);

    manager.write_to_pty(&session.id, &echo_cmd).unwrap();

    assert!(
        emitter.wait_for_output(special_payload, 5),
        "PTY I/O must accurately reflect complex special characters"
    );

    manager.close_pty(&session.id).unwrap();
}

// ---------------------------------------------------------------------------
// 4. ANSI Colors and Unicode
// ---------------------------------------------------------------------------
#[test]
fn test_04_ansi_colors_and_unicode() {
    let manager = PtyManager::new();
    let (emitter, _, _) = TestEventEmitter::new();

    let session = manager
        .create_pty(
            Arc::new(emitter.clone()),
            PtyCreateOptions {
                shell_path: default_test_shell(),
                args: None,
                cwd: None,
                cols: 100,
                rows: 30,
                env: None,
            },
        )
        .expect("Failed to spawn PTY session");

    // Test ANSI color escape sequences (RGB 24-bit, 256-color, bold, italic)
    let color_text = "\x1b[38;2;255;100;50mRGB_COLOR_TEST\x1b[0m \x1b[1mBOLD_TEXT\x1b[0m";
    // Multi-byte UTF-8 Unicode characters (Emojis, CJK, accents)
    let unicode_text = "UNICODE_TEST_🚀_💻_漢字_café_Über";

    #[cfg(not(target_os = "windows"))]
    let echo_cmd = format!("echo \"{} {}\"\n", color_text, unicode_text);
    #[cfg(target_os = "windows")]
    let echo_cmd = format!("echo {} {}\r\n", color_text, unicode_text);

    manager.write_to_pty(&session.id, &echo_cmd).unwrap();

    assert!(
        emitter.wait_for_output("RGB_COLOR_TEST", 5),
        "ANSI color escape sequences must be preserved in output stream"
    );
    assert!(
        emitter.wait_for_output("UNICODE_TEST_🚀_💻_漢字_café_Über", 5),
        "Multi-byte UTF-8 Unicode characters (emojis, CJK, accents) must stream cleanly without replacement characters"
    );

    manager.close_pty(&session.id).unwrap();
}

// ---------------------------------------------------------------------------
// 5. Terminal Resizing
// ---------------------------------------------------------------------------
#[test]
fn test_05_terminal_resizing() {
    let manager = PtyManager::new();
    let (emitter, _, _) = TestEventEmitter::new();

    let session = manager
        .create_pty(
            Arc::new(emitter),
            PtyCreateOptions {
                shell_path: default_test_shell(),
                args: None,
                cwd: None,
                cols: 80,
                rows: 24,
                env: None,
            },
        )
        .expect("Failed to spawn PTY session");

    // Initial size check
    let info1 = manager.get_session_info(&session.id).unwrap();
    assert_eq!(info1.cols, 80);
    assert_eq!(info1.rows, 24);

    // Step 1: Resize to 120x40
    manager.resize_pty(&session.id, 120, 40).unwrap();
    let info2 = manager.get_session_info(&session.id).unwrap();
    assert_eq!(info2.cols, 120);
    assert_eq!(info2.rows, 40);

    // Step 2: Resize to 200x60
    manager.resize_pty(&session.id, 200, 60).unwrap();
    let info3 = manager.get_session_info(&session.id).unwrap();
    assert_eq!(info3.cols, 200);
    assert_eq!(info3.rows, 60);

    // Step 3: Resize down to 40x10
    manager.resize_pty(&session.id, 40, 10).unwrap();
    let info4 = manager.get_session_info(&session.id).unwrap();
    assert_eq!(info4.cols, 40);
    assert_eq!(info4.rows, 10);

    manager.close_pty(&session.id).unwrap();
}

// ---------------------------------------------------------------------------
// 6. Long-running Interactive Processes
// ---------------------------------------------------------------------------
#[test]
fn test_06_long_running_interactive_processes() {
    let manager = PtyManager::new();
    let (emitter, _, _) = TestEventEmitter::new();

    let session = manager
        .create_pty(
            Arc::new(emitter.clone()),
            PtyCreateOptions {
                shell_path: default_test_shell(),
                args: None,
                cwd: None,
                cols: 80,
                rows: 24,
                env: None,
            },
        )
        .expect("Failed to spawn PTY session");

    // Execute 1 second delay command
    #[cfg(not(target_os = "windows"))]
    let sleep_cmd = "sleep 1 && echo LONG_RUNNING_FINISHED\n";
    #[cfg(target_os = "windows")]
    let sleep_cmd = "timeout /t 1 >nul & echo LONG_RUNNING_FINISHED\r\n";

    manager.write_to_pty(&session.id, sleep_cmd).unwrap();

    // Verify session remains Connected during background execution
    let info = manager.get_session_info(&session.id).unwrap();
    assert_eq!(info.status, SessionStatus::Connected);

    assert!(
        emitter.wait_for_output("LONG_RUNNING_FINISHED", 6),
        "Long-running process output must be streamed to completion without blocking manager"
    );

    manager.close_pty(&session.id).unwrap();
}

// ---------------------------------------------------------------------------
// 7. Ctrl+C and Supported Process Signals
// ---------------------------------------------------------------------------
#[test]
fn test_07_ctrl_c_and_supported_signals() {
    let manager = PtyManager::new();
    let (emitter, _, _) = TestEventEmitter::new();

    let session = manager
        .create_pty(
            Arc::new(emitter.clone()),
            PtyCreateOptions {
                shell_path: default_test_shell(),
                args: None,
                cwd: None,
                cols: 80,
                rows: 24,
                env: None,
            },
        )
        .expect("Failed to spawn PTY session");

    // Start a 30 second sleep process
    #[cfg(not(target_os = "windows"))]
    {
        manager.write_to_pty(&session.id, "sleep 30\n").unwrap();
        std::thread::sleep(Duration::from_millis(500));

        // Send Ctrl+C interrupt (\x03)
        manager.interrupt_pty(&session.id).unwrap();

        // Send prompt echo check after interrupt
        manager
            .write_to_pty(&session.id, "echo INTERRUPT_VERIFIED\n")
            .unwrap();

        assert!(
            emitter.wait_for_output("INTERRUPT_VERIFIED", 5),
            "Ctrl+C signal interrupt must cancel foreground execution and return shell control"
        );
    }

    // Windows ConPTY does not translate an ETX (\x03) byte into a
    // CTRL_C_EVENT for console apps like `ping`, so a blocking
    // foreground process cannot be cancelled via a byte write. Assert
    // the non-destructive contract instead: interrupt on an idle shell
    // must succeed and the shell must stay responsive.
    #[cfg(target_os = "windows")]
    {
        std::thread::sleep(Duration::from_millis(1000));

        manager.interrupt_pty(&session.id).unwrap();
        manager
            .write_to_pty(&session.id, "echo INTERRUPT_VERIFIED\r\n")
            .unwrap();

        assert!(
            emitter.wait_for_output("INTERRUPT_VERIFIED", 5),
            "Ctrl+C interrupt on idle Windows shell must leave shell responsive"
        );
    }

    manager.close_pty(&session.id).unwrap();
}

// ---------------------------------------------------------------------------
// 8. High-volume Output and Memory Usage
// ---------------------------------------------------------------------------
#[test]
fn test_08_high_volume_output_and_memory() {
    let manager = PtyManager::new();
    let (emitter, _, _) = TestEventEmitter::new();

    let session = manager
        .create_pty(
            Arc::new(emitter.clone()),
            PtyCreateOptions {
                shell_path: default_test_shell(),
                args: None,
                cwd: None,
                cols: 100,
                rows: 30,
                env: None,
            },
        )
        .expect("Failed to spawn PTY session");

    std::thread::sleep(Duration::from_millis(500));

    // Generate high-volume loop output (500 iterations yielding ~25 KB output)
    #[cfg(not(target_os = "windows"))]
    let high_vol_cmd = "i=1; while [ $i -le 500 ]; do echo \"HIGH_VOL_LINE_${i}_ABCDEFGHIJKLMNOPQRSTUVWXYZ\"; i=$((i+1)); done\n";
    #[cfg(target_os = "windows")]
    let high_vol_cmd =
        "for /l %i in (1,1,500) do echo HIGH_VOL_LINE_%i_ABCDEFGHIJKLMNOPQRSTUVWXYZ\r\n";

    manager.write_to_pty(&session.id, high_vol_cmd).unwrap();

    assert!(
        emitter.wait_for_output("HIGH_VOL_LINE_500_", 20),
        "High-volume terminal output (500 lines) must be streamed completely without loss or memory crashes"
    );

    manager.close_pty(&session.id).unwrap();
}

// ---------------------------------------------------------------------------
// 9. Invalid Shells and Working Directories
// ---------------------------------------------------------------------------
#[test]
fn test_09_invalid_shells_and_working_directories() {
    let manager = PtyManager::new();
    let (emitter, _, _) = TestEventEmitter::new();

    // Case 1: Invalid shell executable path
    let shell_err = manager.create_pty(
        Arc::new(emitter.clone()),
        PtyCreateOptions {
            shell_path: Some("/non_existent_shell_binary_xyz_12345".to_string()),
            args: None,
            cwd: None,
            cols: 80,
            rows: 24,
            env: None,
        },
    );

    assert!(shell_err.is_err(), "Invalid shell path must return error");
    match shell_err {
        Err(TerminalError::ShellNotFound(msg)) => {
            assert!(msg.contains("non_existent_shell_binary_xyz_12345"));
        }
        Err(other) => panic!("Expected ShellNotFound, got {:?}", other),
        Ok(_) => panic!("Expected error for invalid shell path"),
    }

    // Case 2: Invalid working directory
    let cwd_err = manager.create_pty(
        Arc::new(emitter.clone()),
        PtyCreateOptions {
            shell_path: None,
            args: None,
            cwd: Some("/non_existent_working_directory_abc_99999".to_string()),
            cols: 80,
            rows: 24,
            env: None,
        },
    );

    assert!(
        cwd_err.is_err(),
        "Invalid working directory must return error"
    );
    match cwd_err {
        Err(TerminalError::InvalidDirectory(msg)) => {
            assert!(msg.contains("non_existent_working_directory_abc_99999"));
        }
        Err(other) => panic!("Expected InvalidDirectory, got {:?}", other),
        Ok(_) => panic!("Expected error for invalid cwd"),
    }
}

// ---------------------------------------------------------------------------
// 10. Multiple Simultaneous Sessions
// ---------------------------------------------------------------------------
#[test]
fn test_10_multiple_simultaneous_sessions() {
    let manager = PtyManager::new();
    let session_count = 8;
    let mut sessions = Vec::new();
    let mut emitters = Vec::new();

    for i in 0..session_count {
        let (emitter, _, _) = TestEventEmitter::new();
        let session = manager
            .create_pty(
                Arc::new(emitter.clone()),
                PtyCreateOptions {
                    shell_path: default_test_shell(),
                    args: None,
                    cwd: None,
                    cols: 80,
                    rows: 24,
                    env: None,
                },
            )
            .unwrap_or_else(|_| panic!("Failed to spawn concurrent session {}", i));

        sessions.push(session);
        emitters.push(emitter);
    }

    assert_eq!(
        manager.list_sessions().len(),
        session_count,
        "Manager must track all concurrent active sessions"
    );

    // Write unique distinct markers to each concurrent session in parallel
    for (i, session) in sessions.iter().enumerate() {
        let marker = format!("CONCURRENT_SESSION_MARKER_{}", i);
        #[cfg(not(target_os = "windows"))]
        let cmd = format!("echo {}\n", marker);
        #[cfg(target_os = "windows")]
        let cmd = format!("echo {}\r\n", marker);

        manager.write_to_pty(&session.id, &cmd).unwrap();
    }

    // Verify session data isolation: each session receives only its own marker
    for (i, emitter) in emitters.iter().enumerate() {
        let expected_marker = format!("CONCURRENT_SESSION_MARKER_{}", i);
        assert!(
            emitter.wait_for_output(&expected_marker, 5),
            "Concurrent session {} must receive its unique output marker",
            i
        );
    }

    // Clean up all sessions
    for session in sessions {
        manager.close_pty(&session.id).unwrap();
    }

    assert!(
        manager.list_sessions().is_empty(),
        "All sessions should be closed"
    );
}

// ---------------------------------------------------------------------------
// 11. Child Process Cleanup
// ---------------------------------------------------------------------------
#[test]
fn test_11_child_process_cleanup() {
    let manager = PtyManager::new();
    let (emitter, _, _) = TestEventEmitter::new();

    let session = manager
        .create_pty(
            Arc::new(emitter),
            PtyCreateOptions {
                shell_path: default_test_shell(),
                args: None,
                cwd: None,
                cols: 80,
                rows: 24,
                env: None,
            },
        )
        .expect("Failed to spawn PTY session");

    let pid = session.pid;
    let session_id = session.id.clone();

    assert!(
        manager.get_session_info(&session_id).is_some(),
        "Session info must exist prior to close"
    );

    // Explicitly close session
    manager.close_pty(&session_id).unwrap();

    assert!(
        manager.get_session_info(&session_id).is_none(),
        "Session info must be removed after close"
    );

    // Verify process cleanup (PID no longer tracked in active manager)
    if let Some(pid_num) = pid {
        assert!(
            !manager
                .list_sessions()
                .iter()
                .any(|s| s.pid == Some(pid_num)),
            "Reaped PID should no longer be present in active session list"
        );
    }
}

// ---------------------------------------------------------------------------
// 12. Application Startup and Shutdown
// ---------------------------------------------------------------------------
#[test]
fn test_12_application_startup_and_shutdown() {
    let manager = PtyManager::new();
    let session_ids: Vec<String> = (0..3)
        .map(|_| {
            let (emitter, _, _) = TestEventEmitter::new();
            let session = manager
                .create_pty(
                    Arc::new(emitter),
                    PtyCreateOptions {
                        shell_path: default_test_shell(),
                        args: None,
                        cwd: None,
                        cols: 80,
                        rows: 24,
                        env: None,
                    },
                )
                .expect("Failed to spawn PTY session");
            session.id
        })
        .collect();

    assert_eq!(manager.list_sessions().len(), 3);

    // Simulate application exit shutdown procedure
    manager.close_all();

    assert!(
        manager.list_sessions().is_empty(),
        "close_all() must terminate all child process sessions on application exit"
    );

    for id in session_ids {
        assert!(manager.get_session_info(&id).is_none());
    }
}

// ---------------------------------------------------------------------------
// 13. Real AI CLI Compatibility Interoperability Test
// ---------------------------------------------------------------------------

/// True when `p` names a launchable file: existence on all OSes, plus the
/// executable bit on Unix (Windows uses PATHEXT instead — see below).
#[cfg(not(target_os = "windows"))]
fn is_launchable_file(p: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    p.is_file()
        && p.metadata()
            .map(|m| m.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
}

#[cfg(target_os = "windows")]
fn is_launchable_file(p: &Path) -> bool {
    p.is_file()
}

/// Cross-platform executable discovery for a candidate name.
/// Absolute (or slash-containing) paths are returned as-is when they exist.
/// Bare names are resolved through PATH — honoring PATHEXT (`.EXE`, `.CMD`,
/// …) on Windows, where extensionless lookups otherwise always miss.
fn resolve_cli_candidate(cand: &str) -> Option<String> {
    let p = Path::new(cand);
    if p.is_absolute() || cand.contains('/') || cand.contains('\\') {
        return p.exists().then(|| cand.to_string());
    }
    let path_env = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_env) {
        let direct = dir.join(cand);
        if is_launchable_file(&direct) {
            return Some(direct.to_string_lossy().to_string());
        }
        #[cfg(target_os = "windows")]
        {
            let pathext =
                std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string());
            for ext in pathext.split(';') {
                let ext = ext.trim();
                if ext.is_empty() {
                    continue;
                }
                let with_ext = dir.join(format!("{}{}", cand, ext.to_lowercase()));
                if with_ext.exists() {
                    return Some(with_ext.to_string_lossy().to_string());
                }
            }
        }
    }
    None
}

/// Author-machine agy install, expanded via $HOME/$USERPROFILE so the probe
/// works for any user on Linux/macOS/Windows instead of one hardcoded path.
fn home_agy_candidate() -> Option<String> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .ok()?;
    let p = Path::new(&home).join(".local").join("bin").join("agy");
    p.exists().then(|| p.to_string_lossy().to_string())
}

#[test]
fn test_13_real_ai_cli_compatibility() {
    let mut found_cli_path = home_agy_candidate();
    if found_cli_path.is_none() {
        for cand in ["agy", "claude", "gemini", "codex"] {
            if let Some(resolved) = resolve_cli_candidate(cand) {
                found_cli_path = Some(resolved);
                break;
            }
        }
    }

    if found_cli_path.is_none() {
        // Log clear diagnostic fallback when no AI CLI binary is pre-installed on host
        eprintln!(
            "NOTE: No real AI CLI binary found on PATH or at $HOME/.local/bin/agy on this runner host. AI CLI integration test reported as skipped/supported target."
        );
        return;
    }

    let cli_path = found_cli_path.unwrap();
    println!(
        "Testing real AI CLI compatibility with binary at: {}",
        cli_path
    );

    let manager = PtyManager::new();
    let (emitter, _, _) = TestEventEmitter::new();

    // Launch AI CLI --help directly in PTY master
    let session = manager
        .create_pty(
            Arc::new(emitter.clone()),
            PtyCreateOptions {
                shell_path: Some(cli_path.clone()),
                args: Some(vec!["--help".to_string()]),
                cwd: None,
                cols: 100,
                rows: 30,
                env: None,
            },
        )
        .expect("Failed to launch real AI CLI in PTY session");

    assert!(
        emitter.wait_for_output("Usage", 6)
            || emitter.wait_for_output("Options", 6)
            || emitter.wait_for_output("agy", 6),
        "AI CLI help output must stream cleanly over PTY master"
    );

    manager.close_pty(&session.id).unwrap();
}

// ---------------------------------------------------------------------------
// 13a. Executable Discovery Probe (hermetic, runs on every OS)
// ---------------------------------------------------------------------------
#[test]
fn test_13a_cli_candidate_path_probe() {
    // The host shell exists on PATH on every supported runner, so PATH /
    // PATHEXT discovery is verified natively even when no AI CLI is
    // installed (in which case test_13 reports its documented skip).
    #[cfg(not(target_os = "windows"))]
    let known = "sh";
    #[cfg(target_os = "windows")]
    let known = "cmd";
    let resolved = resolve_cli_candidate(known);
    assert!(
        resolved.is_some(),
        "PATH probe must resolve the host shell ({}) on this runner",
        known
    );
    assert!(
        resolve_cli_candidate("kai-definitely-not-a-real-binary-xyz-999").is_none(),
        "PATH probe must return None for unknown names"
    );
}

// ---------------------------------------------------------------------------
// 14. Shell Exit Command Terminates Session Cleanly
// ---------------------------------------------------------------------------
#[test]
fn test_14_exit_command_terminates_session() {
    let manager = PtyManager::new();
    let (emitter, _, exited) = TestEventEmitter::new();

    let session = manager
        .create_pty(
            Arc::new(emitter.clone()),
            PtyCreateOptions {
                shell_path: default_test_shell(),
                args: None,
                cwd: None,
                cols: 80,
                rows: 24,
                env: None,
            },
        )
        .expect("Failed to launch shell for exit test");

    let session_id = session.id.clone();
    assert!(
        manager.get_session_info(&session_id).is_some(),
        "Session must be active initially"
    );

    // Send exit command to shell
    #[cfg(not(target_os = "windows"))]
    let exit_cmd = "exit\n";
    #[cfg(target_os = "windows")]
    let exit_cmd = "exit\r\n";

    manager
        .write_to_pty(&session_id, exit_cmd)
        .expect("Failed to write exit command to PTY");

    // Wait up to 15 seconds for shell process to exit and emit exit event
    // (generous for loaded hosts; returns early on success).
    let start = Instant::now();
    while start.elapsed() < Duration::from_secs(15) {
        if exited.load(Ordering::SeqCst) {
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }

    assert!(
        exited.load(Ordering::SeqCst),
        "PtyManager must emit exit event when shell exits after `exit` command"
    );

    // Verify session was automatically cleaned up from manager
    assert!(
        manager.get_session_info(&session_id).is_none(),
        "Session must be removed from manager map after shell exits"
    );
}

// ---------------------------------------------------------------------------
// 15. Live Kill Test: close_pty / close_all really terminate OS processes
// ---------------------------------------------------------------------------

/// OS-level liveness probe (does not rely on PtyManager bookkeeping).
fn process_alive(pid: u32) -> bool {
    #[cfg(not(target_os = "windows"))]
    {
        std::process::Command::new("kill")
            .args(["-0", &pid.to_string()])
            .stderr(std::process::Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }
    #[cfg(target_os = "windows")]
    {
        let out = std::process::Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/NH", "/FO", "CSV"])
            .output();
        match out {
            Ok(o) => String::from_utf8_lossy(&o.stdout).contains(&format!("\"{pid}\"")),
            Err(_) => false,
        }
    }
}

fn wait_until_dead(pid: u32, timeout_secs: u64) -> bool {
    let start = Instant::now();
    while start.elapsed() < Duration::from_secs(timeout_secs) {
        if !process_alive(pid) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    !process_alive(pid)
}

/// Extracts the first `CHILDPID:<digits>` marker from terminal output.
fn parse_child_pid(text: &str) -> Option<u32> {
    text.match_indices("CHILDPID:").find_map(|(i, m)| {
        let digits: String = text[i + m.len()..]
            .chars()
            .take_while(|c| c.is_ascii_digit())
            .collect();
        digits.parse().ok()
    })
}

#[test]
fn test_15_close_pty_kills_real_os_processes() {
    let manager = PtyManager::new();
    let (emitter, _, _) = TestEventEmitter::new();

    let session = manager
        .create_pty(
            Arc::new(emitter.clone()),
            PtyCreateOptions {
                shell_path: default_test_shell(),
                args: None,
                cwd: None,
                cols: 80,
                rows: 24,
                env: None,
            },
        )
        .expect("Failed to spawn PTY session");

    let shell_pid = session.pid.expect("PTY session must report a shell PID");
    assert!(
        process_alive(shell_pid),
        "Shell PID {shell_pid} must be alive before close"
    );

    // Start a long-running foreground child that reports its own PID.
    #[cfg(not(target_os = "windows"))]
    let cmd = "sh -c 'echo CHILDPID:$$; exec sleep 300'\n";
    #[cfg(target_os = "windows")]
    let cmd =
        "powershell -NoProfile -Command \"Write-Output ('CHILDPID:' + $PID); Start-Sleep 300\"\r\n";
    manager
        .write_to_pty(&session.id, cmd)
        .expect("Failed to start child process");

    // Cold PowerShell start-up on the emulated windows-aarch64 runner can take
    // well over 20s, so give the child a generous window to report its PID.
    let start = Instant::now();
    let mut child_pid = None;
    while start.elapsed() < Duration::from_secs(90) {
        child_pid = parse_child_pid(&emitter.get_text());
        if child_pid.is_some() {
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    let child_pid = child_pid.expect("Child process never reported its PID");
    assert!(
        process_alive(child_pid),
        "Child PID {child_pid} must be alive before close"
    );

    manager.close_pty(&session.id).unwrap();

    assert!(
        wait_until_dead(shell_pid, 10),
        "Shell PID {shell_pid} must be gone from the OS after close_pty"
    );
    assert!(
        wait_until_dead(child_pid, 10),
        "Foreground child PID {child_pid} must be gone from the OS after close_pty"
    );
}

#[test]
fn test_15b_close_all_kills_every_shell_process() {
    let manager = PtyManager::new();
    let pids: Vec<u32> = (0..3)
        .map(|_| {
            let (emitter, _, _) = TestEventEmitter::new();
            manager
                .create_pty(
                    Arc::new(emitter),
                    PtyCreateOptions {
                        shell_path: default_test_shell(),
                        args: None,
                        cwd: None,
                        cols: 80,
                        rows: 24,
                        env: None,
                    },
                )
                .expect("Failed to spawn PTY session")
                .pid
                .expect("PTY session must report a shell PID")
        })
        .collect();

    for pid in &pids {
        assert!(
            process_alive(*pid),
            "Shell PID {pid} must be alive before close_all"
        );
    }

    manager.close_all();

    for pid in pids {
        assert!(
            wait_until_dead(pid, 10),
            "Shell PID {pid} must be gone from the OS after close_all"
        );
    }
}

// ---------------------------------------------------------------------------
// 16. WSL shell round trip (opt-in: set KAI_TEST_WSL=1 on a Windows host that
// has a WSL distribution; the `wsl` job in ci.yml does). Everywhere else it
// prints a NOTE and passes, the same way test_13 does without an AI CLI.
//
// Before opening a PTY the test runs a bounded, stdin-less `wsl.exe -e true`
// probe: an uninitialised distribution (first-run "create a default Unix user"
// prompt), a missing distribution or a hung WSL service then fails fast with a
// named cause instead of timing out on a marker that can never appear.
// ---------------------------------------------------------------------------

/// Decodes `wsl.exe` output: its own messages are UTF-16LE when piped, while
/// output of the Linux side is UTF-8.
fn decode_wsl_output(bytes: &[u8]) -> String {
    if bytes.contains(&0) {
        let units: Vec<u16> = bytes
            .chunks(2)
            .filter(|c| c.len() == 2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        String::from_utf16_lossy(&units)
            .trim_start_matches('\u{feff}')
            .to_string()
    } else {
        String::from_utf8_lossy(bytes).into_owned()
    }
}

/// Names the likely cause when WSL output shows a known first-run or setup
/// failure; `None` when the text is not recognisably one of them.
fn wsl_diagnosis(text: &str) -> Option<&'static str> {
    let t = text.to_lowercase();
    if t.contains("create a default unix user account")
        || t.contains("enter new unix username")
        || t.contains("installation successful")
    {
        Some(
            "the WSL distribution is not initialised (first-run user prompt); \
             install it non-interactively, e.g. with Vampire/setup-wsl or `wsl --install -d <distro> --no-launch` \
             followed by `<distro> install --root`",
        )
    } else if t.contains("no installed distributions")
        || t.contains("has no installed distributions")
        || t.contains("there is no distribution with the supplied name")
    {
        Some("no WSL distribution is installed or registered under that name (`wsl --list --verbose`)")
    } else if t.contains("wsl2 is not supported")
        || t.contains("virtual machine platform")
        || t.contains("hcs_e_")
        || t.contains("wsl_e_")
    {
        Some("WSL2 cannot start on this host (virtualization or optional feature missing)")
    } else {
        None
    }
}

#[test]
fn test_16b_wsl_output_decoding_and_diagnosis() {
    // UTF-16LE with BOM, as `wsl.exe` writes when stdout is a pipe.
    let mut utf16 = vec![0xff, 0xfe];
    for u in "Create a default Unix user account: ".encode_utf16() {
        utf16.extend_from_slice(&u.to_le_bytes());
    }
    let decoded = decode_wsl_output(&utf16);
    assert!(decoded.starts_with("Create a default"), "got {decoded:?}");
    assert!(wsl_diagnosis(&decoded).unwrap().contains("not initialised"));
    assert_eq!(
        decode_wsl_output(b"5.15.0-microsoft\n"),
        "5.15.0-microsoft\n"
    );

    assert!(wsl_diagnosis("Enter new UNIX username:")
        .unwrap()
        .contains("not initialised"));
    assert!(
        wsl_diagnosis("Windows Subsystem for Linux has no installed distributions.")
            .unwrap()
            .contains("no WSL distribution")
    );
    assert!(wsl_diagnosis("HCS_E_HYPERV_NOT_INSTALLED")
        .unwrap()
        .contains("WSL2 cannot start"));
    assert!(wsl_diagnosis("KAI_WSL_1").is_none());
}

/// Runs `wsl.exe <args>` with no stdin and a hard timeout (kill + reap on
/// expiry). Returns the exit code and decoded stdout+stderr.
#[cfg(target_os = "windows")]
fn run_wsl_probe(args: &[&str], timeout: Duration) -> Result<(Option<i32>, String), String> {
    use std::io::Read;
    use std::process::{Command, Stdio};
    let mut child = Command::new("wsl.exe")
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("could not start wsl.exe: {e}"))?;
    // Drain both pipes on threads so a chatty child cannot block on a full pipe.
    let mut out = child.stdout.take().expect("piped stdout");
    let mut err = child.stderr.take().expect("piped stderr");
    let out_t = std::thread::spawn(move || {
        let mut b = Vec::new();
        let _ = out.read_to_end(&mut b);
        b
    });
    let err_t = std::thread::spawn(move || {
        let mut b = Vec::new();
        let _ = err.read_to_end(&mut b);
        b
    });
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
        }
    };
    let mut text = decode_wsl_output(&out_t.join().unwrap_or_default());
    text.push_str(&decode_wsl_output(&err_t.join().unwrap_or_default()));
    match status {
        Some(s) => Ok((s.code(), text)),
        None => Err(format!(
            "`wsl.exe {}` did not finish within {}s (hung WSL service or an interactive prompt). Output so far: {}",
            args.join(" "),
            timeout.as_secs(),
            text.trim()
        )),
    }
}

#[test]
fn test_16_wsl_shell_round_trip() {
    if std::env::var("KAI_TEST_WSL").as_deref() != Ok("1") {
        println!("NOTE: KAI_TEST_WSL!=1, skipping the WSL shell round trip");
        return;
    }
    #[cfg(not(target_os = "windows"))]
    {
        println!("NOTE: WSL only exists on Windows, skipping the WSL shell round trip");
    }
    #[cfg(target_os = "windows")]
    {
        match run_wsl_probe(&["-e", "true"], Duration::from_secs(120)) {
            Ok((Some(0), _)) => {}
            Ok((code, text)) => panic!(
                "WSL preflight `wsl.exe -e true` failed (exit {code:?}): {}. Output: {}",
                wsl_diagnosis(&text).unwrap_or("cause not recognised, see output"),
                text.trim()
            ),
            Err(msg) => panic!(
                "WSL preflight failed: {} ({})",
                msg,
                wsl_diagnosis(&msg).unwrap_or("cause not recognised")
            ),
        }

        let manager = PtyManager::new();
        let (emitter, _, _) = TestEventEmitter::new();
        let session = manager
            .create_pty(
                Arc::new(emitter.clone()),
                PtyCreateOptions {
                    shell_path: Some("wsl.exe".to_string()),
                    args: None,
                    cwd: None,
                    cols: 80,
                    rows: 24,
                    env: None,
                },
            )
            .expect("wsl.exe must start under ConPTY");

        // The typed line contains `$(grep ...)`, never the literal marker, so
        // `KAI_WSL_1` can only come from the Linux side evaluating it:
        // /proc/version of a WSL kernel mentions "microsoft".
        manager
            .write_to_pty(
                &session.id,
                "echo KAI_WSL_$(grep -ci microsoft /proc/version)\n",
            )
            .unwrap();
        // Poll in 1 s steps so a first-run prompt (which only appears on a
        // console, never through the pipe preflight above) fails within a
        // second of showing up instead of after the full wait.
        let mut seen = false;
        for _ in 0..60 {
            if emitter.wait_for_output("KAI_WSL_1", 1) {
                seen = true;
                break;
            }
            if wsl_diagnosis(&emitter.get_text()).is_some() {
                break;
            }
        }
        assert!(
            seen,
            "A WSL shell must evaluate commands inside the Linux kernel ({}). Output: {}",
            wsl_diagnosis(&emitter.get_text()).unwrap_or("cause not recognised"),
            emitter.get_text()
        );

        // KAI_TERMINAL must cross into the Linux shell (via WSLENV), or
        // `kai <agent>` refuses to run there. As above, the typed line holds
        // `${KAI_TERMINAL:-unset}`, never the `KAI_ENV_1` marker itself.
        manager
            .write_to_pty(&session.id, "echo KAI_ENV_${KAI_TERMINAL:-unset}\n")
            .unwrap();
        assert!(
            emitter.wait_for_output("KAI_ENV_1", 30),
            "KAI_TERMINAL must reach the WSL shell through WSLENV. Output: {}",
            emitter.get_text()
        );

        manager.close_pty(&session.id).unwrap();
    }
}

// ---------------------------------------------------------------------------
// 17. Session lifecycle churn never stalls the manager (REL-01)
// ---------------------------------------------------------------------------
/// Sessions exit on their own, are closed explicitly while busy, and are closed
/// while their child is exiting — all at once — while another thread keeps
/// using the manager-wide state. The global sessions lock must never be held
/// across a blocking native close, so no operation may stall for long.
#[test]
fn test_17_lifecycle_churn_does_not_stall_manager() {
    let manager = Arc::new(PtyManager::new());

    #[cfg(target_os = "windows")]
    let (busy_cmd, exit_cmd) = ("ping -n 300 127.0.0.1\r\n", "exit\r\n");
    #[cfg(not(target_os = "windows"))]
    let (busy_cmd, exit_cmd) = ("sleep 300\n", "exit\n");

    let spawn_session = |manager: &PtyManager| {
        let (emitter, _, _) = TestEventEmitter::new();
        manager
            .create_pty(
                Arc::new(emitter),
                PtyCreateOptions {
                    shell_path: default_test_shell(),
                    args: None,
                    cwd: None,
                    cols: 80,
                    rows: 24,
                    env: None,
                },
            )
            .expect("spawn session")
    };

    // Observer: hammers the manager-wide lock and records the worst latency.
    let stop = Arc::new(AtomicBool::new(false));
    let worst_ms = Arc::new(Mutex::new(0u128));
    let observer = {
        let (manager, stop, worst_ms) = (manager.clone(), stop.clone(), worst_ms.clone());
        std::thread::spawn(move || {
            while !stop.load(Ordering::SeqCst) {
                let t = Instant::now();
                let _ = manager.list_sessions();
                let _ = manager.resize_pty("no-such-session", 100, 30);
                let ms = t.elapsed().as_millis();
                if let Ok(mut w) = worst_ms.lock() {
                    *w = (*w).max(ms);
                }
                std::thread::sleep(Duration::from_millis(5));
            }
        })
    };

    for _round in 0..3 {
        let busy = spawn_session(&manager);
        let exiting = spawn_session(&manager);
        let racing = spawn_session(&manager);
        let idle = spawn_session(&manager);

        manager.write_to_pty(&busy.id, busy_cmd).unwrap();
        // The child of `exiting` terminates by itself ...
        manager.write_to_pty(&exiting.id, exit_cmd).unwrap();
        // ... while `racing` is closed at about the moment it exits.
        manager.write_to_pty(&racing.id, exit_cmd).unwrap();
        manager.close_pty(&racing.id).unwrap();
        // Resize while others are tearing down.
        manager.resize_pty(&idle.id, 120, 40).unwrap();
        manager.close_pty(&busy.id).unwrap();
        manager.close_pty(&idle.id).unwrap();
        // Closing an already-exited or already-closed session is a no-op.
        manager.close_pty(&exiting.id).unwrap();
        manager.close_pty(&racing.id).unwrap();
    }

    // Every session must be gone from the map shortly after the churn.
    let deadline = Instant::now() + Duration::from_secs(10);
    while !manager.list_sessions().is_empty() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(
        manager.list_sessions().is_empty(),
        "all churned sessions must be cleaned up"
    );

    stop.store(true, Ordering::SeqCst);
    observer.join().unwrap();
    let worst = *worst_ms.lock().unwrap();
    assert!(
        worst < 2_000,
        "manager-wide operations stalled for {worst} ms during session teardown"
    );
}

// ---------------------------------------------------------------------------
// 18. Running-command detection backs the close confirmation (FUNC-02)
// ---------------------------------------------------------------------------
#[test]
fn test_18_busy_sessions_reports_running_commands_only() {
    let manager = PtyManager::new();
    let (emitter, _, _) = TestEventEmitter::new();
    let session = manager
        .create_pty(
            Arc::new(emitter.clone()),
            PtyCreateOptions {
                shell_path: default_test_shell(),
                args: None,
                cwd: None,
                cols: 80,
                rows: 24,
                env: None,
            },
        )
        .expect("spawn session");
    let ids = vec![session.id.clone(), "no-such-session".to_string()];

    // Let the prompt settle: an idle shell is not "running something".
    std::thread::sleep(Duration::from_millis(1500));
    assert!(
        manager.busy_sessions(&ids).is_empty(),
        "an idle shell prompt must not be reported as busy"
    );

    // A foreground command makes it busy (and only that session, never an unknown id).
    #[cfg(target_os = "windows")]
    let long_cmd = "ping -n 60 127.0.0.1\r\n";
    #[cfg(not(target_os = "windows"))]
    let long_cmd = "sleep 60\n";
    manager.write_to_pty(&session.id, long_cmd).unwrap();

    let deadline = Instant::now() + Duration::from_secs(15);
    let mut busy = Vec::new();
    while Instant::now() < deadline {
        busy = manager.busy_sessions(&ids);
        if !busy.is_empty() {
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    assert_eq!(
        busy,
        vec![session.id.clone()],
        "a running foreground command must be reported busy"
    );

    // Closing it ends the session; a closed session is never reported busy.
    manager.close_pty(&session.id).unwrap();
    assert!(manager.busy_sessions(&ids).is_empty());
}

// ---------------------------------------------------------------------------
// 19-21. Output flow control (PERF-01 / PERF-02)
// ---------------------------------------------------------------------------

/// Writes `lines` numbered lines (`L0000001 ...` padded to 80 bytes) to a temp file
/// and returns its path.
fn write_numbered_file(tag: &str, lines: usize) -> std::path::PathBuf {
    let path = std::env::temp_dir().join(format!("kai-flow-{tag}-{}.txt", std::process::id()));
    let mut text = String::with_capacity(lines * 82);
    for n in 1..=lines {
        text.push_str(&format!("L{n:07} {}\n", "x".repeat(70)));
    }
    std::fs::write(&path, text).unwrap();
    path
}

/// The command that prints `file` to the terminal.
fn cat_command(file: &std::path::Path) -> String {
    #[cfg(target_os = "windows")]
    return format!("type \"{}\"\r\n", file.display());
    #[cfg(not(target_os = "windows"))]
    return format!("cat '{}'\n", file.display());
}

/// Receives output like the frontend does and (optionally) acknowledges it.
struct FlowEmitter {
    bytes: Arc<std::sync::atomic::AtomicU64>,
    text: Arc<Mutex<String>>,
    exited: Arc<AtomicBool>,
    acks: Option<std::sync::mpsc::Sender<u64>>,
}

impl TerminalEventEmitter for FlowEmitter {
    fn emit_output(&self, payload: PtyOutputPayload) {
        self.bytes
            .fetch_add(payload.data.len() as u64, Ordering::SeqCst);
        if let Ok(mut t) = self.text.lock() {
            t.push_str(&payload.data);
        }
        if let Some(acks) = &self.acks {
            let _ = acks.send(payload.data.len() as u64);
        }
    }
    fn emit_exit(&self, _payload: PtyExitPayload) {
        self.exited.store(true, Ordering::SeqCst);
    }
}

struct FlowSession {
    info: kai::pty::PtySessionInfo,
    bytes: Arc<std::sync::atomic::AtomicU64>,
    text: Arc<Mutex<String>>,
    exited: Arc<AtomicBool>,
    peak_in_flight: Arc<Mutex<u64>>,
}

/// Starts a shell whose output goes to a simulated frontend. With `ack_delay`, the
/// frontend takes that long per chunk to hand it to the emulator and then
/// acknowledges it; with `None` it never acknowledges (a stalled consumer).
fn start_flow_session(manager: &Arc<PtyManager>, ack_delay: Option<Duration>) -> FlowSession {
    let bytes = Arc::new(std::sync::atomic::AtomicU64::new(0));
    let text = Arc::new(Mutex::new(String::new()));
    let exited = Arc::new(AtomicBool::new(false));
    let peak = Arc::new(Mutex::new(0u64));
    let (tx, rx) = std::sync::mpsc::channel::<u64>();
    let emitter = FlowEmitter {
        bytes: bytes.clone(),
        text: text.clone(),
        exited: exited.clone(),
        acks: ack_delay.map(|_| tx),
    };
    let info = manager
        .create_pty(
            Arc::new(emitter),
            PtyCreateOptions {
                shell_path: default_test_shell(),
                args: None,
                cwd: None,
                cols: 200,
                rows: 50,
                env: None,
            },
        )
        .expect("spawn session");
    if let Some(delay) = ack_delay {
        let (manager, id, peak) = (manager.clone(), info.id.clone(), peak.clone());
        std::thread::spawn(move || {
            while let Ok(n) = rx.recv() {
                if let Some(in_flight) = manager.output_in_flight(&id) {
                    let mut p = peak.lock().unwrap();
                    *p = (*p).max(in_flight);
                }
                std::thread::sleep(delay);
                manager.ack_output(&id, n);
            }
        });
    }
    FlowSession {
        info,
        bytes,
        text,
        exited,
        peak_in_flight: peak,
    }
}

/// Numbers of the `L0000001`-style lines found in `text`, in the order they appear.
fn line_numbers(text: &str) -> Vec<usize> {
    let bytes = text.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i + 8 <= bytes.len() {
        if bytes[i] == b'L' && bytes[i + 1..i + 8].iter().all(u8::is_ascii_digit) {
            out.push(text[i + 1..i + 8].parse().unwrap());
            i += 8;
        } else {
            i += 1;
        }
    }
    out
}

#[test]
fn test_19_flood_is_delivered_byte_exact_in_order_with_bounded_in_flight() {
    let manager = Arc::new(PtyManager::new());
    // A consumer far slower than the shell (~1.6 MB/s): without flow control the bytes in flight would pile up.
    let s = start_flow_session(&manager, Some(Duration::from_millis(40)));
    std::thread::sleep(Duration::from_millis(1200));

    const LINES: usize = 30_000; // ~2.4 MB: more than twice the 1 MiB high-water mark
    let file = write_numbered_file("exact", LINES);
    manager
        .write_to_pty(&s.info.id, &cat_command(&file))
        .expect("write");

    let deadline = Instant::now() + Duration::from_secs(120);
    let last = format!("L{LINES:07}");
    while Instant::now() < deadline && !s.text.lock().unwrap().contains(&last) {
        std::thread::sleep(Duration::from_millis(100));
    }
    let got = s.text.lock().unwrap().clone();
    assert!(got.contains(&last), "the last line never arrived");

    // Every line, once, in order: nothing dropped, nothing reordered, nothing duplicated.
    let numbers = line_numbers(&got);
    let found = numbers.iter().filter(|n| **n >= 1 && **n <= LINES).count();
    assert_eq!(found, LINES, "{} lines were lost", LINES - found.min(LINES));
    assert!(
        numbers.windows(2).all(|w| w[0] < w[1]),
        "lines arrived out of order or duplicated"
    );

    // The bound: never more than the high-water mark plus one batch (~98 KiB) in flight.
    let peak = *s.peak_in_flight.lock().unwrap();
    assert!(
        peak <= kai::pty::FLOW_HIGH_WATER_BYTES + 160 * 1024,
        "in flight reached {peak} bytes; flow control did not bound it"
    );
    manager.close_pty(&s.info.id).unwrap();
    let _ = std::fs::remove_file(file);
}

#[test]
fn test_20_stalled_consumer_stops_the_producer_and_close_returns_promptly() {
    let manager = Arc::new(PtyManager::new());
    // A consumer that never acknowledges anything.
    let s = start_flow_session(&manager, None);
    std::thread::sleep(Duration::from_millis(1200));

    let file = write_numbered_file("stall", 250_000); // ~20 MB, far above the mark
    manager
        .write_to_pty(&s.info.id, &cat_command(&file))
        .expect("write");

    // The shell is held at the bound instead of being drained into memory.
    std::thread::sleep(Duration::from_secs(4));
    let settled = s.bytes.load(Ordering::SeqCst);
    std::thread::sleep(Duration::from_secs(2));
    let later = s.bytes.load(Ordering::SeqCst);
    let ceiling = kai::pty::FLOW_HIGH_WATER_BYTES + 512 * 1024;
    assert!(
        later <= ceiling,
        "{later} bytes reached the stalled frontend (limit {ceiling}): output is not bounded"
    );
    assert_eq!(settled, later, "output must stop, not just slow down");
    assert!(
        manager.output_in_flight(&s.info.id).unwrap() >= kai::pty::FLOW_HIGH_WATER_BYTES,
        "the session should be waiting at the high-water mark"
    );

    // Input still works while the output side is held: writes never depend on draining.
    let t = Instant::now();
    manager
        .write_to_pty(&s.info.id, "\x03")
        .expect("input while paused");
    assert!(
        t.elapsed() < Duration::from_secs(1),
        "input stalled behind output"
    );

    // Closing must not wait for a consumer that will never acknowledge.
    let t = Instant::now();
    manager.close_pty(&s.info.id).unwrap();
    assert!(
        t.elapsed() < Duration::from_secs(2),
        "close_pty took {:?} with a stalled consumer",
        t.elapsed()
    );
    // The shell must actually go away (a reader blocked on a full channel would keep the
    // waiter, and so the process teardown, waiting). Closing on purpose reports no exit event.
    if let Some(pid) = s.info.pid {
        assert!(
            wait_until_dead(pid, 15),
            "the shell of a closed, paused session never went away"
        );
    }
    assert!(
        !s.exited.load(Ordering::SeqCst),
        "an explicit close reports no exit event"
    );
    let _ = std::fs::remove_file(file);
}

#[test]
fn test_21_a_session_that_ends_while_paused_still_reports_its_exit() {
    let manager = Arc::new(PtyManager::new());
    let s = start_flow_session(&manager, None);
    std::thread::sleep(Duration::from_millis(1200));

    let file = write_numbered_file("exit", 120_000);
    #[cfg(target_os = "windows")]
    let command = format!("type \"{}\" & exit\r\n", file.display());
    #[cfg(not(target_os = "windows"))]
    let command = format!("cat '{}'; exit\n", file.display());
    manager.write_to_pty(&s.info.id, &command).expect("write");

    // The consumer never acknowledges; the shell is blocked mid-output and so cannot exit.
    std::thread::sleep(Duration::from_secs(3));
    assert!(s.bytes.load(Ordering::SeqCst) > 0);
    assert!(!s.exited.load(Ordering::SeqCst), "it is blocked on output");

    // The consumer comes back and acknowledges everything it was sent.
    let deadline = Instant::now() + Duration::from_secs(120);
    while Instant::now() < deadline && !s.exited.load(Ordering::SeqCst) {
        let in_flight = manager.output_in_flight(&s.info.id).unwrap_or(0);
        manager.ack_output(&s.info.id, in_flight);
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(
        s.exited.load(Ordering::SeqCst),
        "after the consumer resumed, the shell finished and its exit was reported"
    );
    let _ = std::fs::remove_file(file);
}

// ---------------------------------------------------------------------------
// 22. The child process sees the new size (CI-05)
// ---------------------------------------------------------------------------
// `test_05` only checks the size the manager stores. What matters is that the program inside
// the terminal is told: `stty size` (Unix) and `mode con` (Windows console) ask the terminal.
#[test]
fn test_22_the_child_observes_a_resize() {
    let manager = PtyManager::new();
    let (emitter, _, _) = TestEventEmitter::new();
    let session = manager
        .create_pty(
            Arc::new(emitter.clone()),
            PtyCreateOptions {
                shell_path: default_test_shell(),
                args: None,
                cwd: None,
                cols: 80,
                rows: 24,
                env: None,
            },
        )
        .expect("Failed to spawn PTY session");
    std::thread::sleep(Duration::from_millis(500));

    manager.resize_pty(&session.id, 132, 41).unwrap();
    std::thread::sleep(Duration::from_millis(300));

    #[cfg(not(target_os = "windows"))]
    {
        manager.write_to_pty(&session.id, "stty size\n").unwrap();
        assert!(
            emitter.wait_for_output("41 132", 5),
            "the shell must report the new size, got: {}",
            emitter.get_text()
        );
    }
    #[cfg(target_os = "windows")]
    {
        manager.write_to_pty(&session.id, "mode con\r\n").unwrap();
        let reported = |text: &str| {
            // "    Columns:        132"
            text.lines().any(|l| {
                let l = l.trim();
                l.starts_with("Columns:") && l.trim_start_matches("Columns:").trim() == "132"
            })
        };
        let start = Instant::now();
        while start.elapsed() < Duration::from_secs(5) && !reported(&emitter.get_text()) {
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(
            reported(&emitter.get_text()),
            "the console must report 132 columns, got: {}",
            emitter.get_text()
        );
    }

    // And back down: the child follows the terminal both ways.
    manager.resize_pty(&session.id, 60, 12).unwrap();
    std::thread::sleep(Duration::from_millis(300));
    #[cfg(not(target_os = "windows"))]
    {
        manager.write_to_pty(&session.id, "stty size\n").unwrap();
        assert!(
            emitter.wait_for_output("12 60", 5),
            "got: {}",
            emitter.get_text()
        );
    }
    #[cfg(target_os = "windows")]
    {
        manager.write_to_pty(&session.id, "mode con\r\n").unwrap();
        let start = Instant::now();
        let narrow = |text: &str| {
            text.lines().any(|l| {
                let l = l.trim();
                l.starts_with("Columns:") && l.trim_start_matches("Columns:").trim() == "60"
            })
        };
        while start.elapsed() < Duration::from_secs(5) && !narrow(&emitter.get_text()) {
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(
            narrow(&emitter.get_text()),
            "the console must report 60 columns, got: {}",
            emitter.get_text()
        );
    }

    manager.close_pty(&session.id).unwrap();
}

// ---------------------------------------------------------------------------
// 23. An explicit close reports no exit; a shell that ignores SIGHUP is still ended
// ---------------------------------------------------------------------------
#[test]
fn test_23_explicit_close_emits_no_exit_event() {
    let manager = PtyManager::new();
    let (emitter, _, exited) = TestEventEmitter::new();
    let session = manager
        .create_pty(
            Arc::new(emitter.clone()),
            PtyCreateOptions {
                shell_path: default_test_shell(),
                args: None,
                cwd: None,
                cols: 80,
                rows: 24,
                env: None,
            },
        )
        .expect("Failed to spawn PTY session");
    std::thread::sleep(Duration::from_millis(500));

    manager.close_pty(&session.id).unwrap();

    // The shell dies and the waiter runs; if it were going to report, it would have by now.
    // (The code a killed child leaves behind, 1 on Windows, reads as a crash.)
    std::thread::sleep(Duration::from_millis(1500));
    assert!(
        !exited.load(Ordering::SeqCst),
        "closing a session on purpose must not produce an exit event"
    );
}

#[test]
fn test_23b_a_shell_that_exits_by_itself_still_reports_its_code() {
    let manager = PtyManager::new();
    let (emitter, _, exited) = TestEventEmitter::new();
    let session = manager
        .create_pty(
            Arc::new(emitter.clone()),
            PtyCreateOptions {
                shell_path: default_test_shell(),
                args: None,
                cwd: None,
                cols: 80,
                rows: 24,
                env: None,
            },
        )
        .expect("Failed to spawn PTY session");
    std::thread::sleep(Duration::from_millis(500));
    #[cfg(target_os = "windows")]
    manager.write_to_pty(&session.id, "exit 7\r\n").unwrap();
    #[cfg(not(target_os = "windows"))]
    manager.write_to_pty(&session.id, "exit 7\n").unwrap();

    let start = Instant::now();
    while start.elapsed() < Duration::from_secs(10) && !exited.load(Ordering::SeqCst) {
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(
        exited.load(Ordering::SeqCst),
        "a shell that exits on its own must report it"
    );
    let _ = manager.close_pty(&session.id);
}

#[cfg(unix)]
#[test]
fn test_23c_close_ends_a_shell_that_ignores_sighup() {
    let manager = PtyManager::new();
    let (emitter, _, _) = TestEventEmitter::new();
    let session = manager
        .create_pty(
            Arc::new(emitter.clone()),
            PtyCreateOptions {
                shell_path: Some("/bin/sh".to_string()),
                // The shell ignores SIGHUP and then stays alive: SIGHUP alone cannot end it.
                args: Some(vec![
                    "-c".to_string(),
                    "trap '' HUP; while true; do sleep 1; done".to_string(),
                ]),
                cwd: None,
                cols: 80,
                rows: 24,
                env: None,
            },
        )
        .expect("Failed to spawn PTY session");
    let pid = session.pid.expect("pid");
    std::thread::sleep(Duration::from_millis(500));
    assert!(process_alive(pid));

    manager.close_pty(&session.id).unwrap();

    // The grace period is 500 ms; the shell must be gone shortly after, not at app exit.
    assert!(
        wait_until_dead(pid, 5),
        "a shell that ignores SIGHUP must still be killed after the grace period"
    );
}

// ---------------------------------------------------------------------------
// 24. Throughput floor with a prompt consumer (CI-06)
// ---------------------------------------------------------------------------
// Flow control must hold a flooding program back from a SLOW reader, never throttle a prompt one.
// Measured on the development machine (Windows, ConPTY) a prompt consumer receives about 1.3 MB/s
// of `type`/`cat` output. The floor is a fifth of that: loose enough for a loaded CI runner, tight
// enough to catch flow control, batching or the output path becoming an order of magnitude slower.
#[test]
fn test_24_a_prompt_consumer_keeps_up_with_a_flood() {
    const FLOOR_BYTES_PER_SEC: f64 = 260_000.0;
    let manager = Arc::new(PtyManager::new());
    let s = start_flow_session(&manager, Some(Duration::ZERO));
    std::thread::sleep(Duration::from_millis(1200));

    const LINES: usize = 30_000; // ~2.4 MB
    let file = write_numbered_file("floor", LINES);
    let started = Instant::now();
    manager
        .write_to_pty(&s.info.id, &cat_command(&file))
        .expect("write");

    let last = format!("L{LINES:07}");
    let deadline = Instant::now() + Duration::from_secs(60);
    while Instant::now() < deadline && !s.text.lock().unwrap().contains(&last) {
        std::thread::sleep(Duration::from_millis(20));
    }
    let elapsed = started.elapsed();
    let received = s.bytes.load(Ordering::SeqCst) as f64;
    assert!(
        s.text.lock().unwrap().contains(&last),
        "the flood never completed"
    );
    let rate = received / elapsed.as_secs_f64();
    println!("flood throughput with a prompt consumer: {rate:.0} bytes/s over {elapsed:?}");
    assert!(
        rate >= FLOOR_BYTES_PER_SEC,
        "throughput fell to {rate:.0} bytes/s (floor {FLOOR_BYTES_PER_SEC:.0}); \
         the output path or flow control has become much slower"
    );
    manager.close_pty(&s.info.id).unwrap();
    let _ = std::fs::remove_file(file);
}

// ---------------------------------------------------------------------------
// 25. PowerShell, the default shell on Windows (CI-05: the other tests use cmd.exe there)
// ---------------------------------------------------------------------------
#[cfg(target_os = "windows")]
#[test]
fn test_25_powershell_round_trip_and_resize() {
    let manager = PtyManager::new();
    let (emitter, _, _) = TestEventEmitter::new();
    let session = manager
        .create_pty(
            Arc::new(emitter.clone()),
            PtyCreateOptions {
                shell_path: Some("powershell.exe".to_string()),
                args: Some(vec!["-NoLogo".to_string(), "-NoProfile".to_string()]),
                cwd: None,
                cols: 80,
                rows: 24,
                env: None,
            },
        )
        .expect("Failed to spawn PowerShell");

    // A cold PowerShell start (fresh CI runner, .NET not warmed, ARM64) can take well over 20 s;
    // wait for its prompt before typing, so the time limit below is about running a command.
    assert!(
        emitter.wait_for_output("PS ", 120),
        "PowerShell never showed its prompt, got: {}",
        emitter.get_text()
    );

    // Built from parts so the typed command itself never matches.
    manager
        .write_to_pty(&session.id, "Write-Output ('KAI' + 'PS' + (20 + 5))\r")
        .unwrap();
    assert!(
        emitter.wait_for_output("KAIPS25", 20),
        "PowerShell must run a command, got: {}",
        emitter.get_text()
    );

    manager.resize_pty(&session.id, 132, 41).unwrap();
    std::thread::sleep(Duration::from_millis(300));
    manager
        .write_to_pty(
            &session.id,
            "Write-Output ('W=' + $Host.UI.RawUI.WindowSize.Width + ';')\r",
        )
        .unwrap();
    assert!(
        emitter.wait_for_output("W=132;", 10),
        "PowerShell must see the new width, got: {}",
        emitter.get_text()
    );
    manager.close_pty(&session.id).unwrap();
}

// ---------------------------------------------------------------------------
// 26. Keystroke-to-echo latency (CI-06: what a terminal is judged on had no gate)
// ---------------------------------------------------------------------------
#[test]
fn test_26_keystroke_echo_latency_stays_interactive() {
    // Measured on a Windows desktop: median 8 ms, worst 20 ms. The limits are far above that
    // because CI runners (virtualized, antivirus-hooked) have not been measured yet: they catch a
    // real regression (a stalled reader, a batching delay on the output path), not noise.
    // Tighten them once CI numbers exist (the println below reports them).
    const MEDIAN_LIMIT: Duration = Duration::from_millis(150);
    const WORST_LIMIT: Duration = Duration::from_millis(1500);

    let manager = PtyManager::new();
    let (emitter, _, _) = TestEventEmitter::new();
    let session = manager
        .create_pty(
            Arc::new(emitter.clone()),
            PtyCreateOptions {
                shell_path: default_test_shell(),
                args: None,
                cwd: None,
                cols: 120,
                rows: 30,
                env: None,
            },
        )
        .expect("Failed to spawn PTY session");
    #[cfg(target_os = "windows")]
    let (ready, comment, newline) = ("echo READY%TIME:~0,0%\r\n", "rem", "\r\n");
    #[cfg(not(target_os = "windows"))]
    let (ready, comment, newline) = ("echo READY$((0))\n", ":", "\n");
    manager.write_to_pty(&session.id, ready).unwrap();
    assert!(
        emitter.wait_for_output("READY", 20),
        "shell never started: {}",
        emitter.get_text()
    );
    std::thread::sleep(Duration::from_millis(300));

    let mut samples = Vec::new();
    for i in 0..25 {
        let token = format!("K{i:03}Q");
        let started = Instant::now();
        manager
            .write_to_pty(&session.id, &format!("{comment} {token}"))
            .unwrap();
        while started.elapsed() < Duration::from_secs(5) && !emitter.get_text().contains(&token) {
            std::thread::sleep(Duration::from_millis(1));
        }
        assert!(
            emitter.get_text().contains(&token),
            "typed text never echoed: {token}"
        );
        samples.push(started.elapsed());
        manager.write_to_pty(&session.id, newline).unwrap();
        std::thread::sleep(Duration::from_millis(40));
    }
    samples.sort();
    let median = samples[samples.len() / 2];
    let worst = *samples.last().unwrap();
    println!(
        "keystroke echo latency: median {median:?}, worst {worst:?} over {} keystroke runs",
        samples.len()
    );
    assert!(
        median <= MEDIAN_LIMIT,
        "median echo latency {median:?} is over {MEDIAN_LIMIT:?}"
    );
    assert!(
        worst <= WORST_LIMIT,
        "worst echo latency {worst:?} is over {WORST_LIMIT:?}"
    );
    manager.close_pty(&session.id).unwrap();
}
