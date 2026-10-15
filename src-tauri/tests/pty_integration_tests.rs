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

    let start = Instant::now();
    let mut child_pid = None;
    while start.elapsed() < Duration::from_secs(20) {
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
