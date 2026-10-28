use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use uuid::Uuid;

use crate::error::TerminalError;
use crate::shell::{
    check_host_pty_support, is_wsl_shell_path, validate_and_resolve_cwd,
    validate_and_resolve_shell, wsl_failure_hint,
};

/// Abstract event emitter trait for PTY output streaming and process exit notification.
pub trait TerminalEventEmitter: Send + Sync + 'static {
    fn emit_output(&self, payload: PtyOutputPayload);
    fn emit_exit(&self, payload: PtyExitPayload);
    fn emit_cwd(&self, _payload: PtyCwdPayload) {}
}

/// Tauri implementation of TerminalEventEmitter.
#[cfg(feature = "tauri")]
pub struct TauriEventEmitter {
    pub app_handle: tauri::AppHandle,
}

#[cfg(feature = "tauri")]
impl TerminalEventEmitter for TauriEventEmitter {
    fn emit_output(&self, payload: PtyOutputPayload) {
        use tauri::Emitter;
        let _ = self.app_handle.emit("pty-output", payload);
    }

    fn emit_exit(&self, payload: PtyExitPayload) {
        use tauri::Emitter;
        let _ = self.app_handle.emit("pty-exit", payload);
    }

    fn emit_cwd(&self, payload: PtyCwdPayload) {
        use tauri::Emitter;
        let _ = self.app_handle.emit("pty-cwd", payload);
    }
}

/// No-op event emitter for headless testing or silent execution.
pub struct NoopEventEmitter;

impl TerminalEventEmitter for NoopEventEmitter {
    fn emit_output(&self, _payload: PtyOutputPayload) {}
    fn emit_exit(&self, _payload: PtyExitPayload) {}
}

/// Terminal session lifecycle status.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SessionStatus {
    Connecting,
    Connected,
    Disconnected,
    Error,
}

/// Options for spawning a new PTY session.
#[derive(Debug, Clone, Deserialize)]
pub struct PtyCreateOptions {
    pub shell_path: Option<String>,
    pub args: Option<Vec<String>>,
    pub cwd: Option<String>,
    pub cols: u16,
    pub rows: u16,
    pub env: Option<HashMap<String, String>>,
}

/// Active PTY session metadata returned to caller.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PtySessionInfo {
    pub id: String,
    pub pid: Option<u32>,
    pub shell_path: String,
    pub cwd: String,
    pub cols: u16,
    pub rows: u16,
    pub status: SessionStatus,
}

/// Event payload emitted on PTY output data streaming.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PtyOutputPayload {
    pub id: String,
    pub data: String,
}

/// Event payload emitted on PTY session exit.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PtyExitPayload {
    pub id: String,
    pub exit_code: Option<i32>,
}

/// Event payload emitted on PTY working directory update.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PtyCwdPayload {
    pub id: String,
    pub cwd: String,
}

/// Attempts to resolve the live working directory of a process by its PID.
pub fn resolve_process_cwd(_pid: u32) -> Option<String> {
    // Under Flatpak every shell child is a `flatpak-spawn --host` wrapper whose
    // own cwd never changes and says nothing about the host shell, so probing
    // it would overwrite OSC 7 reports with a stale constant.
    if flatpak_blocks_cwd_probe(flatpak_id_from_env().as_deref()) {
        return None;
    }
    #[cfg(target_os = "linux")]
    {
        let proc_path = format!("/proc/{}/cwd", _pid);
        if let Ok(target) = std::fs::read_link(&proc_path) {
            let s = target.to_string_lossy().to_string();
            if !s.is_empty() {
                return Some(s);
            }
        }
    }
    #[cfg(target_os = "macos")]
    {
        use std::process::Command;
        if let Ok(output) = Command::new("lsof")
            .args(["-a", "-p", &_pid.to_string(), "-d", "cwd", "-Fn"])
            .output()
        {
            let stdout = String::from_utf8_lossy(&output.stdout);
            for line in stdout.lines() {
                if let Some(path) = line.strip_prefix('n') {
                    if !path.is_empty() {
                        return Some(path.to_string());
                    }
                }
            }
        }
    }
    None
}

/// Internal session handle holding native PTY master, writer, and process killer handle.
///
/// The writer lives behind its own `Arc<Mutex<..>>` so a large paste (up to
/// 1 MB, streamed in 32 KB syscalls) only contends with writers of the SAME
/// session — it never holds the manager-wide sessions lock, which previously
/// blocked other tabs' create/resize/close for the whole write duration.
pub struct PtySessionHandle {
    pub id: String,
    pub pid: Option<u32>,
    pub shell_path: String,
    pub cwd: String,
    pub master: Box<dyn MasterPty + Send>,
    pub writer: Arc<Mutex<Box<dyn Write + Send>>>,
    pub killer: Box<dyn ChildKiller + Send + Sync>,
    pub cols: u16,
    pub rows: u16,
    pub status: SessionStatus,
    /// Last time the live OS cwd was probed for this session. Probes are
    /// syscalls (Linux) or child-process spawns (macOS `lsof`), so every
    /// accessor below throttles them — unthrottled polling from the
    /// frontend (focus + interval + per-command checks) otherwise spawns
    /// processes fast enough to stall the window.
    pub last_cwd_probe: std::time::Instant,
}

/// Minimum gap between live-OS cwd probes for one session.
const CWD_PROBE_MIN_INTERVAL: std::time::Duration = std::time::Duration::from_secs(2);

/// Claims the throttled live-cwd probe slot for a session: returns the pid to
/// probe when `CWD_PROBE_MIN_INTERVAL` has elapsed since the last probe (and
/// stamps the probe time), otherwise `None`.
///
/// Only the bookkeeping happens here, under the sessions lock. The probe
/// itself (`resolve_process_cwd`: a syscall on Linux, an `lsof` child
/// process on macOS that can take 100+ ms) MUST run after the lock is
/// released — see `PtyManager::resolve_and_store_cwd` — otherwise every
/// other tab's write/resize/close blocks behind it and input lags.
fn take_cwd_probe_slot(handle: &mut PtySessionHandle) -> Option<u32> {
    let pid = handle.pid?;
    let now = std::time::Instant::now();
    if now.duration_since(handle.last_cwd_probe) >= CWD_PROBE_MIN_INTERVAL {
        handle.last_cwd_probe = now;
        Some(pid)
    } else {
        None
    }
}

/// Thread-safe manager for active PTY sessions.
#[derive(Default)]
pub struct PtyManager {
    pub sessions: Arc<Mutex<HashMap<String, PtySessionHandle>>>,
}

// Maximum output batch size before flushing to event emitter (16 KB)
const MAX_OUTPUT_BATCH_BYTES: usize = 16_384;
// Buffer read chunk size (32 KB). `read()` returns whatever is available, so
// interactive latency is unchanged; under floods (`cat bigfile`, installs)
// each read drains up to 8x more bytes per IPC event than the old 4 KB
// buffer, cutting event/serialization overhead on every OS.
const READ_BUFFER_CHUNK_BYTES: usize = 32_768;
// Dimension bounds limits
const MIN_COLS: u16 = 10;
const MAX_COLS: u16 = 500;
const MIN_ROWS: u16 = 2;
const MAX_ROWS: u16 = 300;
// Maximum bytes per single `write()` syscall when streaming input to the
// PTY master. Large pastes are sent as a sequence of chunks with the exact
// same byte order — this is flow pacing, NOT line splitting: newlines and
// control characters are never inserted, removed, or reordered.
const WRITE_SYSCALL_CHUNK_BYTES: usize = 32_768;
// Maximum input payload size per IPC write call (1 MB)
const MAX_INPUT_WRITE_BYTES: usize = 1_048_576;
// Launch-argument hardening (Phase E): bound IPC-controlled vectors.
const MAX_SPAWN_ARGS: usize = 64;
const MAX_SPAWN_ARG_BYTES: usize = 8_192;
const MAX_SPAWN_ENV_VARS: usize = 64;
const MAX_SPAWN_ENV_KEY_BYTES: usize = 256;
const MAX_SPAWN_ENV_VAL_BYTES: usize = 32_768;

impl PtyManager {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Spawns a new native shell attached to a PTY.
    pub fn create_pty(
        &self,
        emitter: Arc<dyn TerminalEventEmitter>,
        options: PtyCreateOptions,
    ) -> Result<PtySessionInfo, TerminalError> {
        let flatpak_id = flatpak_id_from_env();
        let shell_path = if flatpak_id.is_some() {
            // The shell runs on the host (`flatpak-spawn --host`), so a
            // sandbox filesystem check would reject host-only shells.
            resolve_flatpak_shell(options.shell_path.as_deref(), host_login_shell)?
        } else {
            validate_and_resolve_shell(options.shell_path.as_deref())?
        };
        let cwd = validate_and_resolve_cwd(options.cwd.as_deref())?;
        // P0: reject unsupported Windows hosts before touching ConPTY so the
        // user gets an actionable error instead of a cryptic native failure.
        check_host_pty_support()?;

        let cols = if options.cols == 0 {
            80
        } else {
            options.cols.clamp(MIN_COLS, MAX_COLS)
        };
        let rows = if options.rows == 0 {
            24
        } else {
            options.rows.clamp(MIN_ROWS, MAX_ROWS)
        };

        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| {
                let mut msg = format!("PTY creation failed: {}", e);
                if is_wsl_shell_path(&shell_path) {
                    msg.push_str(". ");
                    msg.push_str(wsl_failure_hint());
                }
                TerminalError::PtyCreationFailed(msg)
            })?;

        let mut cmd = CommandBuilder::new(&shell_path);
        // Cwd-reporting prompt integration (Windows footer fix): native
        // shells never emit OSC 7/9 by default and Windows exposes no
        // /proc-style cwd query (`resolve_process_cwd` is Linux/macOS
        // only), so without this the status bar / git badge stays stuck at
        // the spawn directory after `cd` — the "path never changes in the
        // window" bug. Best-effort only: an explicit user `-Command`/`-File`
        // invocation or a custom PROMPT override opts out (tracking then
        // degrades to today's behavior, never worse).
        let user_env_has_prompt = options
            .env
            .as_ref()
            .is_some_and(|e| e.keys().any(|k| k.eq_ignore_ascii_case("PROMPT")));
        if is_cmd_shell(&shell_path) && !user_env_has_prompt {
            let existing = std::env::var("PROMPT").ok();
            cmd.env("PROMPT", cmd_cwd_prompt_value(existing.as_deref()));
        }
        if let Some(ref args) = options.args {
            validate_spawn_args(args)?;
            if is_powershell_shell(&shell_path) && !powershell_args_take_command(args) {
                // Preserve the caller's args (-NoLogo etc.), then stay
                // interactive after installing the OSC 9;9 prompt wrapper
                // (runs after profiles load, wrapping the existing prompt).
                cmd.args(args);
                cmd.arg("-NoExit");
                cmd.arg("-Command");
                cmd.arg(powershell_cwd_hook_script());
            } else {
                cmd.args(args);
            }
        } else if is_powershell_shell(&shell_path) {
            // Fast-path default: skip the banner even when the frontend
            // passes no args (older persisted tabs, custom launchers).
            // Profile scripts still run; this only removes the logo print
            // that floods ConPTY on slow first launches.
            cmd.arg("-NoLogo");
            cmd.arg("-NoExit");
            cmd.arg("-Command");
            cmd.arg(powershell_cwd_hook_script());
        }
        cmd.cwd(&cwd);
        // Ensure standard terminal capabilities so shells (zsh, bash, fish) and tools
        // enable line-editing (ZLE/Readline), 256 colors, truecolor, and autosuggestions.
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        cmd.env("KAI_TERMINAL", "1");
        cmd.env("TERM_PROGRAM", "kai");
        if let Some(ref env_vars) = options.env {
            validate_spawn_env(env_vars)?;
            for (k, v) in env_vars {
                cmd.env(k, v);
            }
        }

        if flatpak_id.is_some() {
            // Best-effort cwd reporting for host shells (see
            // `flatpak_cwd_hook_env`); a user-supplied PROMPT_COMMAND wins.
            let user_has_hook = options
                .env
                .as_ref()
                .is_some_and(|e| e.contains_key(FLATPAK_CWD_HOOK_VAR));
            if !user_has_hook {
                for (k, v) in flatpak_cwd_hook_env(&shell_path) {
                    cmd.env(k, v);
                }
            }
        }

        let cmd = route_through_flatpak_host(cmd, &cwd);

        let child = pair.slave.spawn_command(cmd).map_err(|e| {
            let mut msg = format!("Child process startup failed: {}", e);
            if is_wsl_shell_path(&shell_path) {
                msg.push(' ');
                msg.push_str(wsl_failure_hint());
            }
            TerminalError::PtyCreationFailed(msg)
        })?;

        // Explicitly drop slave handle so PTY reference count drops when child exits
        drop(pair.slave);

        let pid = child.process_id();
        let killer = child.clone_killer();
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| TerminalError::IoError(format!("Failed to acquire PTY writer: {}", e)))?;
        let writer = Arc::new(Mutex::new(writer));

        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| TerminalError::IoError(format!("Failed to clone PTY reader: {}", e)))?;

        let session_id = Uuid::new_v4().to_string();

        let session_info = PtySessionInfo {
            id: session_id.clone(),
            pid,
            shell_path: shell_path.clone(),
            cwd: cwd.clone(),
            cols,
            rows,
            status: SessionStatus::Connected,
        };

        let handle = PtySessionHandle {
            id: session_id.clone(),
            pid,
            shell_path,
            cwd,
            master: pair.master,
            writer,
            killer,
            cols,
            rows,
            status: SessionStatus::Connected,
            last_cwd_probe: std::time::Instant::now(),
        };

        // Store active session in thread-safe map
        {
            let mut sessions = self
                .sessions
                .lock()
                .map_err(|e| TerminalError::IoError(format!("Lock failure: {}", e)))?;
            sessions.insert(session_id.clone(), handle);
        }

        // 1. Dedicated background reader thread for continuous output streaming with flow control
        let id_clone = session_id.clone();
        let emitter_reader = emitter.clone();
        let pid_reader = pid;
        let mut last_emitted_cwd = session_info.cwd.clone();
        let sessions_map_ref = self.sessions.clone();
        // Throttle live-cwd probes: each check is a syscall (Linux) or a
        // full `lsof` child-process spawn (macOS). Running it per 4 KB
        // output chunk turned high-volume output into hundreds of process
        // spawns per second — the "window stuck / system slow" hang.
        // At most one probe per cwd poll interval.
        let mut last_cwd_check = std::time::Instant::now();
        const CWD_POLL_INTERVAL: std::time::Duration = std::time::Duration::from_secs(2);

        let reader_thread = std::thread::spawn(move || {
            let mut read_buf = [0u8; READ_BUFFER_CHUNK_BYTES];
            let mut batch_buf = Vec::with_capacity(MAX_OUTPUT_BATCH_BYTES);
            // Raw-byte window for OSC 7 / 9;9 cwd reports (primary Windows
            // mechanism — see the prompt integration in `create_pty`). The
            // retained tail reassembles sequences split across 4 KB reads;
            // overlap re-scans are harmless (deduped by the equality check).
            let mut scan_buf: Vec<u8> = Vec::with_capacity(8192);

            loop {
                match reader.read(&mut read_buf) {
                    Ok(0) => break, // EOF reached
                    Ok(n) => {
                        batch_buf.extend_from_slice(&read_buf[..n]);

                        // Flush buffered UTF-8 text immediately when read
                        let text = split_valid_utf8(&mut batch_buf);
                        if !text.is_empty() {
                            emitter_reader.emit_output(PtyOutputPayload {
                                id: id_clone.clone(),
                                data: text,
                            });
                        }

                        // OSC 7 / OSC 9;9 cwd reports sniffed from shell output.
                        // This is what keeps `handle.cwd` (and therefore
                        // `get_pty_cwd` + focus/interval/cd probes) truthful
                        // on Windows, where `resolve_process_cwd` is
                        // unavailable. Frontend xterm parses the same bytes
                        // independently; output forwarding below is untouched.
                        scan_buf.extend_from_slice(&read_buf[..n]);
                        // Fast path: an OSC sequence always starts with ESC.
                        // Plain-text floods (logs, `cat`, installs) have no
                        // ESC at all, so skip the scan and drop the tail —
                        // no partial sequence can be pending without one.
                        if scan_buf.contains(&0x1B) {
                            for osc_cwd in extract_osc_cwds(&scan_buf) {
                                if osc_cwd != last_emitted_cwd {
                                    last_emitted_cwd = osc_cwd.clone();
                                    if let Ok(mut map) = sessions_map_ref.lock() {
                                        if let Some(handle) = map.get_mut(&id_clone) {
                                            handle.cwd = osc_cwd.clone();
                                        }
                                    }
                                    emitter_reader.emit_cwd(PtyCwdPayload {
                                        id: id_clone.clone(),
                                        cwd: osc_cwd,
                                    });
                                }
                            }
                            if scan_buf.len() > 8192 {
                                let excess = scan_buf.len() - 8192;
                                scan_buf.drain(..excess);
                            }
                        } else {
                            scan_buf.clear();
                        }

                        // Check if child working directory changed (throttled —
                        // see CWD_POLL_INTERVAL above; unthrottled probes
                        // spawned an `lsof` per output chunk on macOS).
                        if let Some(p) = pid_reader {
                            let now = std::time::Instant::now();
                            if now.duration_since(last_cwd_check) >= CWD_POLL_INTERVAL {
                                last_cwd_check = now;
                                if let Some(curr_cwd) = resolve_process_cwd(p) {
                                    if curr_cwd != last_emitted_cwd {
                                        last_emitted_cwd = curr_cwd.clone();
                                        if let Ok(mut map) = sessions_map_ref.lock() {
                                            if let Some(handle) = map.get_mut(&id_clone) {
                                                handle.cwd = curr_cwd.clone();
                                            }
                                        }
                                        emitter_reader.emit_cwd(PtyCwdPayload {
                                            id: id_clone.clone(),
                                            cwd: curr_cwd,
                                        });
                                    }
                                }
                            }
                        }
                    }
                    Err(_) => break, // Pipe broken or master closed
                }
            }

            // Flush remaining data in batch buffer before exit
            if !batch_buf.is_empty() {
                let text = String::from_utf8_lossy(&batch_buf).to_string();
                batch_buf.clear();
                if !text.is_empty() {
                    emitter_reader.emit_output(PtyOutputPayload {
                        id: id_clone,
                        data: text,
                    });
                }
            }
        });

        // 2. Dedicated waiter thread monitors child process lifecycle.
        // When the child process terminates (e.g. `exit` command, logout, signal):
        // 1. `child.wait()` unblocks with the process exit code.
        // 2. We remove the session from `sessions` and drop `master`.
        //    Crucial on Windows (ConPTY): dropping `master` drops `PsuedoCon` and
        //    calls `ClosePseudoConsole`. This closes the ConPTY pipe and unblocks
        //    the blocking `reader.read()` in `reader_thread` above (hang fix).
        // 3. We join `reader_thread` so all buffered output is guaranteed to be
        //    emitted before `emit_exit` reaches the frontend.
        // 4. We emit `emit_exit` with the real exit code.
        let id_clone_waiter = session_id.clone();
        let sessions_map = self.sessions.clone();

        std::thread::spawn(move || {
            let mut child = child;
            let exit_status = child.wait();
            let exit_code = exit_status.ok().map(|status| status.exit_code() as i32);

            // Clean up session entry & drop master so reader unblocks (hang fix on Windows ConPTY)
            {
                let mut sessions = sessions_map.lock().ok();
                if let Some(mut session) =
                    sessions.as_mut().and_then(|s| s.remove(&id_clone_waiter))
                {
                    session.status = SessionStatus::Disconnected;
                }
            }

            // Ensure reader thread finishes flushing before exit event is sent
            let _ = reader_thread.join();

            // Emit session exit event
            emitter.emit_exit(PtyExitPayload {
                id: id_clone_waiter,
                exit_code,
            });
        });

        Ok(session_info)
    }

    /// Writes input characters/data to the specified PTY session.
    ///
    /// Byte-exact delivery: the payload is streamed in bounded syscall
    /// chunks with `Interrupted` retry and partial-write looping. No line
    /// splitting, newline injection, or reordering is performed — canonical
    /// line-discipline limits (e.g. the 4,096-byte `n_tty` canonical buffer)
    /// remain OS semantics; shells that need long lines must enable raw mode
    /// themselves. Payloads over 1 MB are rejected rather than silently
    /// truncated.
    pub fn write_to_pty(&self, id: &str, data: &str) -> Result<(), TerminalError> {
        if data.len() > MAX_INPUT_WRITE_BYTES {
            return Err(TerminalError::WriteFailed(format!(
                "Input payload size ({} bytes) exceeds maximum limit of {} bytes; paste smaller chunks instead of losing data silently",
                data.len(),
                MAX_INPUT_WRITE_BYTES
            )));
        }

        // Grab the per-session writer under a brief map lock, then release
        // the map before touching the pipe: a large paste must not stall
        // other sessions' create/resize/close on the global mutex.
        let writer_handle: Arc<Mutex<Box<dyn Write + Send>>> = {
            let sessions = self
                .sessions
                .lock()
                .map_err(|e| TerminalError::IoError(format!("Lock failure: {}", e)))?;

            match sessions.get(id) {
                Some(session) if session.status == SessionStatus::Connected => {
                    Arc::clone(&session.writer)
                }
                Some(_) => return Ok(()),
                None => return Err(TerminalError::SessionNotFound(id.to_string())),
            }
        };

        let mut writer = writer_handle
            .lock()
            .map_err(|e| TerminalError::IoError(format!("Lock failure: {}", e)))?;

        if let Err(e) = write_bytes_chunked(&mut writer, data.as_bytes()) {
            if e.kind() == std::io::ErrorKind::BrokenPipe {
                return Ok(());
            }
            return Err(TerminalError::WriteFailed(format!(
                "Failed to write to PTY: {}",
                e
            )));
        }
        if let Err(e) = writer.flush() {
            if e.kind() == std::io::ErrorKind::BrokenPipe {
                return Ok(());
            }
            return Err(TerminalError::WriteFailed(format!(
                "Failed to flush PTY writer: {}",
                e
            )));
        }
        Ok(())
    }

    /// Sends a Ctrl+C interrupt byte (\x03) to target PTY session.
    ///
    /// Unix: the line discipline translates ETX into SIGINT, cancelling
    /// the foreground process. Windows ConPTY does not translate this
    /// byte into a CTRL_C_EVENT, so blocking console apps (e.g. `ping`)
    /// are not cancelled; the byte is still delivered non-destructively.
    pub fn interrupt_pty(&self, id: &str) -> Result<(), TerminalError> {
        self.write_to_pty(id, "\x03")
    }

    /// Resizes the PTY dimensions for the target session.
    pub fn resize_pty(&self, id: &str, cols: u16, rows: u16) -> Result<(), TerminalError> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|e| TerminalError::IoError(format!("Lock failure: {}", e)))?;

        if let Some(session) = sessions.get_mut(id) {
            if session.status != SessionStatus::Connected {
                return Ok(());
            }

            let valid_cols = if cols == 0 {
                80
            } else {
                cols.clamp(MIN_COLS, MAX_COLS)
            };
            let valid_rows = if rows == 0 {
                24
            } else {
                rows.clamp(MIN_ROWS, MAX_ROWS)
            };

            let _ = session.master.resize(PtySize {
                rows: valid_rows,
                cols: valid_cols,
                pixel_width: 0,
                pixel_height: 0,
            });

            session.cols = valid_cols;
            session.rows = valid_rows;
            Ok(())
        } else {
            Err(TerminalError::SessionNotFound(id.to_string()))
        }
    }

    /// Explicitly closes and cleans up a PTY session.
    pub fn close_pty(&self, id: &str) -> Result<(), TerminalError> {
        // Remove under a short lock, then kill WITHOUT holding it so a
        // slow child cannot block other sessions (hang fix).
        let mut session = {
            let mut sessions = self
                .sessions
                .lock()
                .map_err(|e| TerminalError::IoError(format!("Lock failure: {}", e)))?;
            sessions.remove(id)
        };

        if let Some(s) = session.as_mut() {
            s.status = SessionStatus::Disconnected;
            let _ = s.killer.kill();
            Ok(())
        } else {
            // Already closed or clean
            Ok(())
        }
    }

    /// Reaps all child process handles on application shutdown.
    pub fn close_all(&self) {
        let mut drained = if let Ok(mut sessions) = self.sessions.lock() {
            sessions.drain().collect::<Vec<_>>()
        } else {
            Vec::new()
        };
        for (_, mut session) in drained.drain(..) {
            session.status = SessionStatus::Disconnected;
            let _ = session.killer.kill();
        }
    }

    /// Runs a due live-cwd probe for session `id` WITHOUT holding the
    /// sessions lock, then stores the fresh value back (re-locking briefly).
    /// `due_pid` is the result of `take_cwd_probe_slot`; `cached` is returned
    /// when no probe is due or the OS cannot report a cwd (e.g. Windows).
    fn resolve_and_store_cwd(&self, id: &str, due_pid: Option<u32>, cached: String) -> String {
        let Some(pid) = due_pid else {
            return cached;
        };
        match resolve_process_cwd(pid) {
            Some(fresh) => {
                if let Ok(mut sessions) = self.sessions.lock() {
                    if let Some(session) = sessions.get_mut(id) {
                        session.cwd = fresh.clone();
                    }
                }
                fresh
            }
            None => cached,
        }
    }

    /// Returns live resolved working directory for a session if active.
    pub fn get_session_cwd(&self, id: &str) -> Option<String> {
        let (cached, due_pid) = {
            let mut sessions = self.sessions.lock().ok()?;
            let session = sessions.get_mut(id)?;
            (session.cwd.clone(), take_cwd_probe_slot(session))
        };
        Some(self.resolve_and_store_cwd(id, due_pid, cached))
    }

    /// Returns session metadata for a given ID.
    pub fn get_session_info(&self, id: &str) -> Option<PtySessionInfo> {
        let (mut info, due_pid) = {
            let mut sessions = self.sessions.lock().ok()?;
            let session = sessions.get_mut(id)?;
            let due_pid = take_cwd_probe_slot(session);
            (
                PtySessionInfo {
                    id: session.id.clone(),
                    pid: session.pid,
                    shell_path: session.shell_path.clone(),
                    cwd: session.cwd.clone(),
                    cols: session.cols,
                    rows: session.rows,
                    status: session.status.clone(),
                },
                due_pid,
            )
        };
        info.cwd = self.resolve_and_store_cwd(id, due_pid, info.cwd.clone());
        Some(info)
    }

    /// Returns list of all active session metadata objects.
    pub fn list_sessions(&self) -> Vec<PtySessionInfo> {
        let mut rows: Vec<(PtySessionInfo, Option<u32>)> = match self.sessions.lock() {
            Ok(mut sessions) => sessions
                .values_mut()
                .map(|s| {
                    let due_pid = take_cwd_probe_slot(s);
                    (
                        PtySessionInfo {
                            id: s.id.clone(),
                            pid: s.pid,
                            shell_path: s.shell_path.clone(),
                            cwd: s.cwd.clone(),
                            cols: s.cols,
                            rows: s.rows,
                            status: s.status.clone(),
                        },
                        due_pid,
                    )
                })
                .collect(),
            Err(_) => return Vec::new(),
        };
        for (info, due_pid) in rows.iter_mut() {
            info.cwd = self.resolve_and_store_cwd(&info.id, *due_pid, info.cwd.clone());
        }
        rows.into_iter().map(|(info, _)| info).collect()
    }
}

impl Drop for PtyManager {
    fn drop(&mut self) {
        self.close_all();
    }
}

/// True for Windows PowerShell / PowerShell Core binaries (case-insensitive,
/// any directory, with or without `.exe`). Used to inject `-NoLogo` so a
/// slow .NET/profile first launch doesn't present as "Not Responding".
fn is_powershell_shell(shell_path: &str) -> bool {
    let lower = shell_path.to_lowercase();
    let file = lower.rsplit(['/', '\\']).next().unwrap_or(&lower);
    let base = file.strip_suffix(".exe").unwrap_or(file);
    base == "powershell" || base == "pwsh"
}

/// True for cmd.exe (any directory, case-insensitive, with or without `.exe`).
fn is_cmd_shell(shell_path: &str) -> bool {
    let lower = shell_path.to_lowercase();
    let file = lower.rsplit(['/', '\\']).next().unwrap_or(&lower);
    let base = file.strip_suffix(".exe").unwrap_or(file);
    base == "cmd"
}

/// Full argv (program first) that runs `argv` on the host instead of inside a
/// Flatpak sandbox, or `None` when not running under Flatpak (`FLATPAK_ID`
/// unset or empty), so every other install keeps spawning the shell directly.
///
/// `flatpak-spawn --host` does not carry the sandbox environment across, so the
/// variables Kai sets for the shell are forwarded as explicit `--env=` flags.
/// Needs `--talk-name=org.freedesktop.Flatpak` in the manifest. `--watch-bus`
/// makes the host process exit with the sandbox, so closing Kai leaves no
/// orphaned host shells.
fn flatpak_host_argv(
    flatpak_id: Option<&str>,
    argv: &[String],
    cwd: &str,
    env: &[(String, String)],
) -> Option<Vec<String>> {
    if flatpak_id.unwrap_or("").is_empty() || argv.is_empty() {
        return None;
    }
    let mut out = vec![
        "flatpak-spawn".to_string(),
        "--host".to_string(),
        "--watch-bus".to_string(),
        format!("--directory={cwd}"),
    ];
    out.extend(env.iter().map(|(k, v)| format!("--env={k}={v}")));
    out.extend(argv.iter().cloned());
    Some(out)
}

/// `FLATPAK_ID` when set and non-empty, i.e. when running inside a Flatpak
/// sandbox. Flatpak only exists on Linux, so a stray `FLATPAK_ID` in the
/// environment of a Windows or macOS build never reroutes the shell.
fn flatpak_id_from_env() -> Option<String> {
    if !cfg!(target_os = "linux") {
        return None;
    }
    std::env::var("FLATPAK_ID").ok().filter(|v| !v.is_empty())
}

/// True when the PTY child's `/proc` cwd cannot describe the shell: under
/// Flatpak the child is the sandbox-side `flatpak-spawn` wrapper.
fn flatpak_blocks_cwd_probe(flatpak_id: Option<&str>) -> bool {
    !flatpak_id.unwrap_or("").is_empty()
}

/// Shell used under Flatpak when the host login shell cannot be determined.
/// `/bin/sh` exists on every host Kai supports.
const FLATPAK_FALLBACK_SHELL: &str = "/bin/sh";
/// Fixed script run on the host to read the login shell from the passwd
/// database (no user input is interpolated).
const FLATPAK_HOST_SHELL_PROBE: &str = r#"getent passwd "$(id -u)""#;
const FLATPAK_HOST_PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(3);

/// Validates a shell path that will be executed on the host, where the
/// sandbox cannot check that it exists: absolute, bounded, no control
/// characters (this also rejects NUL and newlines).
fn validate_host_shell_path(requested: &str) -> Result<String, TerminalError> {
    let trimmed = requested.trim().trim_matches('"').trim_matches('\'');
    if trimmed.is_empty() {
        return Err(TerminalError::ShellNotFound(
            "Shell path is empty".to_string(),
        ));
    }
    if trimmed.len() > 4096 {
        return Err(TerminalError::ShellNotFound(
            "Shell path exceeds 4096 bytes".to_string(),
        ));
    }
    if trimmed.chars().any(char::is_control) {
        return Err(TerminalError::ShellNotFound(
            "Shell path contains control characters".to_string(),
        ));
    }
    if !trimmed.starts_with('/') {
        return Err(TerminalError::ShellNotFound(format!(
            "Shell path '{trimmed}' must be absolute when the shell runs on the Flatpak host"
        )));
    }
    Ok(trimmed.to_string())
}

/// Login shell from one `getent passwd` line (`name:x:uid:gid:gecos:home:shell`).
/// Accounts that cannot log in interactively (`nologin`, `false`) yield `None`.
fn login_shell_from_passwd(line: &str) -> Option<String> {
    let shell = line.lines().next()?.split(':').nth(6)?.trim();
    let name = shell.rsplit('/').next().unwrap_or(shell);
    if matches!(name, "nologin" | "false") {
        return None;
    }
    validate_host_shell_path(shell).ok()
}

/// Shell to run on the Flatpak host: an explicit request is only syntax-checked
/// (the sandbox cannot see the host's executables); otherwise the host login
/// shell (looked up lazily), then `/bin/sh`.
fn resolve_flatpak_shell(
    requested: Option<&str>,
    host_login_shell: impl FnOnce() -> Option<String>,
) -> Result<String, TerminalError> {
    match requested.map(str::trim).filter(|r| !r.is_empty()) {
        Some(path) => validate_host_shell_path(path),
        None => Ok(host_login_shell().unwrap_or_else(|| FLATPAK_FALLBACK_SHELL.to_string())),
    }
}

/// The user's login shell on the Flatpak host, cached after the first success.
/// A failed or timed-out probe is not cached, so a transient failure is retried
/// on the next tab; the caller falls back to `/bin/sh` meanwhile.
fn host_login_shell() -> Option<String> {
    static CACHE: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    if let Some(cached) = CACHE.get() {
        return Some(cached.clone());
    }
    let out = run_host_probe(&["sh", "-c", FLATPAK_HOST_SHELL_PROBE])?;
    let shell = login_shell_from_passwd(&out)?;
    Some(CACHE.get_or_init(|| shell).clone())
}

/// Runs `flatpak-spawn --host <argv>` with a hard timeout (kill + reap on
/// expiry) and returns trimmed stdout on success.
fn run_host_probe(argv: &[&str]) -> Option<String> {
    use std::io::Read;
    use std::process::{Command, Stdio};
    let mut child = Command::new("flatpak-spawn")
        .arg("--host")
        .args(argv)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let deadline = std::time::Instant::now() + FLATPAK_HOST_PROBE_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if !status.success() {
                    return None;
                }
                let mut buf = String::new();
                child
                    .stdout
                    .take()?
                    .take(8192)
                    .read_to_string(&mut buf)
                    .ok()?;
                return Some(buf.trim().to_string());
            }
            Ok(None) if std::time::Instant::now() < deadline => {
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
}

/// Variable the cwd hook rides on.
const FLATPAK_CWD_HOOK_VAR: &str = "PROMPT_COMMAND";
/// Bash prompt hook reporting the cwd via `OSC 7` before every prompt, with
/// `%`, space, `#` and `?` percent-encoded so the URL parses back exactly.
const FLATPAK_BASH_CWD_HOOK: &str = "__kai_osc7(){ local p=${PWD//%/%25}; p=${p// /%20}; p=${p//\\#/%23}; p=${p//\\?/%3F}; printf '\\033]7;file://%s%s\\007' \"${HOSTNAME:-localhost}\" \"$p\"; }; __kai_osc7";

/// Extra environment that lets the cwd badge follow `cd` in a Flatpak tab.
/// The host shell is invisible from the sandbox (no shared PID namespace, so no
/// `/proc/<pid>/cwd`), leaving shell-emitted `OSC 7` as the only source. Only
/// bash can be primed through the environment (`PROMPT_COMMAND`); it is
/// best-effort, since an rc file that assigns `PROMPT_COMMAND` replaces it.
/// Other shells report cwd only if they emit `OSC 7` themselves, and otherwise
/// the badge stays at the spawn directory.
fn flatpak_cwd_hook_env(shell_path: &str) -> Vec<(String, String)> {
    let name = shell_path.rsplit('/').next().unwrap_or(shell_path);
    if name == "bash" {
        vec![(
            FLATPAK_CWD_HOOK_VAR.to_string(),
            FLATPAK_BASH_CWD_HOOK.to_string(),
        )]
    } else {
        Vec::new()
    }
}

/// Rebuilds `cmd` as a `flatpak-spawn --host` invocation when running under
/// Flatpak (see `flatpak_host_argv`); returns it unchanged otherwise.
fn route_through_flatpak_host(cmd: CommandBuilder, cwd: &str) -> CommandBuilder {
    let flatpak_id = flatpak_id_from_env();
    let argv: Vec<String> = cmd
        .get_argv()
        .iter()
        .map(|a| a.to_string_lossy().into_owned())
        .collect();
    let env: Vec<(String, String)> = cmd
        .iter_extra_env_as_str()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
    match flatpak_host_argv(flatpak_id.as_deref(), &argv, cwd, &env) {
        Some(host_argv) => {
            let mut host = CommandBuilder::new(&host_argv[0]);
            host.args(&host_argv[1..]);
            host
        }
        None => cmd,
    }
}

/// PowerShell prompt hook reporting cwd via `OSC 9;9` on every prompt while
/// preserving the user's prompt text. Passed as a single `-Command` argv
/// (runs after profiles load, so it wraps a profile-defined `prompt` when
/// one exists). `Write-Host -NoNewline` keeps the prompt line itself clean;
/// failures are swallowed so a broken `$PWD` never breaks the prompt.
fn powershell_cwd_hook_script() -> String {
    "$__kai_o=(GI function:prompt -EA SilentlyContinue).ScriptBlock; function global:prompt{$e=[char]27; try{$l=(Get-Location).Path; Write-Host -NoNewline \"$e]9;9;$l$e\\\"}catch{}; if($__kai_o){&$__kai_o}else{'PS> '}}"
        .to_string()
}

/// True when argv already drives PowerShell non-interactively (`-Command`,
/// `-c`, `-EncodedCommand`, `-File`): injecting our own `-Command` would
/// conflict, so cwd tracking stays best-effort there.
fn powershell_args_take_command(args: &[String]) -> bool {
    args.iter().any(|a| {
        let t = a
            .trim_start_matches('-')
            .trim_start_matches('/')
            .to_lowercase();
        matches!(
            t.as_str(),
            "command" | "c" | "encodedcommand" | "e" | "enc" | "file" | "f"
        )
    })
}

/// cmd.exe PROMPT value reporting cwd via `OSC 9;9` before every prompt.
/// `$e` = ESC (Windows 10+), `$P` = drive+path. An existing prompt tail is
/// preserved; prompts that already report cwd are left untouched.
fn cmd_cwd_prompt_value(existing: Option<&str>) -> String {
    const OSC_PREFIX: &str = "$e]9;9;$P$e\\";
    match existing {
        Some(t) if !t.trim().is_empty() => {
            let trimmed = t.trim();
            if trimmed.contains("]9;9;") {
                trimmed.to_string()
            } else {
                format!("{OSC_PREFIX}{trimmed}")
            }
        }
        _ => format!("{OSC_PREFIX}$P$G"),
    }
}

/// Finds the end of an OSC sequence starting data at `from`: returns
/// `(data_end, next_pos)` where the terminator is BEL (`0x07`) or ST
/// (`ESC \`). Returns `None` when the sequence is incomplete (e.g. the
/// buffer ends mid-sequence or on a trailing lone ESC).
fn find_osc_end(buf: &[u8], from: usize) -> Option<(usize, usize)> {
    let mut k = from;
    while k < buf.len() {
        if buf[k] == 0x07 {
            return Some((k, k + 1));
        }
        if buf[k] == 0x1B {
            if k + 1 >= buf.len() {
                return None;
            }
            if buf[k + 1] == 0x5C {
                return Some((k, k + 2));
            }
        }
        k += 1;
    }
    None
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

/// Percent-decodes `s` (byte-wise, then lossy UTF-8) for OSC 7 file URLs.
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut raw: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(h), Some(l)) = (hex_val(bytes[i + 1]), hex_val(bytes[i + 2])) {
                raw.push((h << 4) | l);
                i += 3;
                continue;
            }
        }
        raw.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&raw).into_owned()
}

/// Parses OSC 7 payload bytes (`file://host/path`, percent-encoded) into a
/// cwd, mirroring the frontend xterm OSC 7 handler (URL parse, drive-letter
/// `/C:/` unstripping). Returns `None` for non-file payloads.
fn parse_osc7_data(data: &[u8]) -> Option<String> {
    let s = String::from_utf8_lossy(data);
    let s = s.trim();
    if s.is_empty() {
        return None;
    }
    let without_scheme = s.strip_prefix("file://")?;
    // Split host from path at the first `/`.
    let idx = without_scheme.find('/')?;
    let path_part = &without_scheme[idx..];
    if path_part.is_empty() {
        return None;
    }
    let mut p = percent_decode(path_part);
    // `file:///C:/x` -> `C:/x` (same rule as the frontend handler).
    if p.len() >= 3 && p.as_bytes()[0] == b'/' && p.as_bytes()[2] == b':' {
        if let Some(drive) = p.as_bytes().get(1) {
            if drive.is_ascii_alphabetic() {
                p = p[1..].to_string();
            }
        }
    }
    if p.trim().is_empty() {
        return None;
    }
    Some(p)
}

/// Parses OSC 9;9 payload bytes (literal Windows path, e.g. `C:\Users\x`).
fn parse_osc9_data(data: &[u8]) -> Option<String> {
    let s = String::from_utf8_lossy(data);
    let p = s.trim();
    if p.is_empty() {
        None
    } else {
        Some(p.to_string())
    }
}

/// Scans raw PTY output bytes for completed OSC 7 / OSC 9;9 cwd reports and
/// returns each reported cwd in order. Handles BEL and ST (`ESC \`)
/// terminators. Incomplete trailing sequences are skipped (callers retain a
/// tail and prepend it to the next chunk).
pub fn extract_osc_cwds(chunk: &[u8]) -> Vec<String> {
    let mut out = Vec::new();
    let mut i = 0;
    while i + 2 < chunk.len() {
        if chunk[i] == 0x1B && chunk[i + 1] == 0x5D {
            let mut j = i + 2;
            let num_start = j;
            while j < chunk.len() && chunk[j].is_ascii_digit() {
                j += 1;
            }
            if j == num_start || j >= chunk.len() || chunk[j] != b';' {
                i += 1;
                continue;
            }
            let id: u32 = std::str::from_utf8(&chunk[num_start..j])
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(u32::MAX);
            j += 1; // skip ';'
            if id == 7 {
                match find_osc_end(chunk, j) {
                    Some((end, next)) => {
                        if let Some(cwd) = parse_osc7_data(&chunk[j..end]) {
                            out.push(cwd);
                        }
                        i = next;
                        continue;
                    }
                    None => break, // incomplete tail: wait for more bytes
                }
            } else if id == 9 {
                // Windows Terminal convention: `OSC 9;9;<dir>`.
                if j + 1 < chunk.len() && chunk[j] == b'9' && chunk[j + 1] == b';' {
                    j += 2;
                    match find_osc_end(chunk, j) {
                        Some((end, next)) => {
                            if let Some(cwd) = parse_osc9_data(&chunk[j..end]) {
                                out.push(cwd);
                            }
                            i = next;
                            continue;
                        }
                        None => break,
                    }
                }
                i += 1;
                continue;
            }
        }
        i += 1;
    }
    out
}

/// Validates IPC-supplied spawn args without shell-string interpolation.
/// Uses direct argv passing (CommandBuilder::args); rejects NUL bytes and
/// bounds count/length so a malicious webview cannot bloat the spawn call.
fn validate_spawn_args(args: &[String]) -> Result<(), TerminalError> {
    if args.len() > MAX_SPAWN_ARGS {
        return Err(TerminalError::InvalidState(format!(
            "Too many spawn arguments ({} > {})",
            args.len(),
            MAX_SPAWN_ARGS
        )));
    }
    for a in args {
        if a.contains('\0') {
            return Err(TerminalError::InvalidState(
                "Spawn argument contains NUL byte".into(),
            ));
        }
        if a.len() > MAX_SPAWN_ARG_BYTES {
            return Err(TerminalError::InvalidState(format!(
                "Spawn argument exceeds {} bytes",
                MAX_SPAWN_ARG_BYTES
            )));
        }
    }
    Ok(())
}

/// Validates IPC-supplied env overrides. Keys must look like ENV_VAR names;
/// values are bounded. Callers must never forward secrets here by default,
/// and diagnostics must never log these maps.
fn validate_spawn_env(env: &HashMap<String, String>) -> Result<(), TerminalError> {
    if env.len() > MAX_SPAWN_ENV_VARS {
        return Err(TerminalError::InvalidState(format!(
            "Too many env overrides ({} > {})",
            env.len(),
            MAX_SPAWN_ENV_VARS
        )));
    }
    for (k, v) in env {
        if k.is_empty() || k.len() > MAX_SPAWN_ENV_KEY_BYTES || k.contains('\0') || v.contains('\0')
        {
            return Err(TerminalError::InvalidState(format!(
                "Invalid env entry for key '{}'",
                k.chars().take(64).collect::<String>()
            )));
        }
        let key_ok = k.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
        let starts_ok = k
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphabetic() || c == '_');
        if !key_ok || !starts_ok {
            return Err(TerminalError::InvalidState(format!(
                "Invalid env key '{}': use [A-Za-z_][A-Za-z0-9_]*",
                k.chars().take(64).collect::<String>()
            )));
        }
        if v.len() > MAX_SPAWN_ENV_VAL_BYTES {
            return Err(TerminalError::InvalidState(format!(
                "Env value for '{}' exceeds {} bytes",
                k.chars().take(64).collect::<String>(),
                MAX_SPAWN_ENV_VAL_BYTES
            )));
        }
    }
    Ok(())
}

/// Streams bytes to a PTY writer in bounded chunks, retrying interrupted
/// syscalls and looping on partial writes. Preserves exact byte order and
/// never alters newline/control semantics.
fn write_bytes_chunked(writer: &mut Box<dyn Write + Send>, bytes: &[u8]) -> std::io::Result<()> {
    write_bytes_chunked_generic(writer.as_mut(), bytes)
}

fn write_bytes_chunked_generic(writer: &mut dyn Write, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::ErrorKind;
    let mut offset = 0;
    while offset < bytes.len() {
        let end = (offset + WRITE_SYSCALL_CHUNK_BYTES).min(bytes.len());
        let mut chunk_off = offset;
        while chunk_off < end {
            match writer.write(&bytes[chunk_off..end]) {
                Ok(0) => {
                    return Err(std::io::Error::new(
                        ErrorKind::WriteZero,
                        "PTY writer accepted zero bytes",
                    ))
                }
                Ok(n) => chunk_off += n,
                Err(e) if e.kind() == ErrorKind::Interrupted => continue,
                Err(e) => return Err(e),
            }
        }
        offset = end;
    }
    Ok(())
}

/// Helper extracting maximum valid UTF-8 string from buffer while retaining incomplete trailing UTF-8 sequences.
///
/// Drain-based (no full-buffer clones): the reader thread calls this on
/// every 4 KB chunk, so the old `buf.clone()` + `to_vec()` copies turned
/// high-volume output (e.g. `npm install` floods) into O(n^2) copying.
fn split_valid_utf8(buf: &mut Vec<u8>) -> String {
    if buf.is_empty() {
        return String::new();
    }
    match std::str::from_utf8(buf) {
        Ok(_) => {
            // Whole buffer is valid: move it out without copying.
            String::from_utf8(std::mem::take(buf)).unwrap_or_default()
        }
        Err(e) => {
            let valid_len = e.valid_up_to();
            if e.error_len().is_none() {
                if valid_len > 0 {
                    let taken: Vec<u8> = buf.drain(..valid_len).collect();
                    // `taken` is the valid prefix of valid UTF-8, so this is infallible.
                    String::from_utf8(taken).unwrap_or_default()
                } else {
                    String::new()
                }
            } else {
                let text = String::from_utf8_lossy(buf).to_string();
                buf.clear();
                text
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};

    struct TestEventEmitter {
        output_received: Arc<Mutex<Vec<String>>>,
        exit_received: Arc<AtomicBool>,
    }

    impl TerminalEventEmitter for TestEventEmitter {
        fn emit_output(&self, payload: PtyOutputPayload) {
            if let Ok(mut logs) = self.output_received.lock() {
                logs.push(payload.data);
            }
        }

        fn emit_exit(&self, _payload: PtyExitPayload) {
            self.exit_received.store(true, Ordering::SeqCst);
        }
    }

    #[test]
    fn test_pty_manager_session_lookup_and_close() {
        let _env = crate::test_support::lock_test_env();
        let manager = PtyManager::new();
        assert!(manager.list_sessions().is_empty());
        assert!(manager.get_session_info("non-existent-id").is_none());
        assert!(manager.write_to_pty("non-existent-id", "test").is_err());
        assert!(manager.resize_pty("non-existent-id", 100, 30).is_err());
        assert!(manager.close_pty("non-existent-id").is_ok());
    }

    #[test]
    fn test_spawn_args_and_env_validation() {
        let _env = crate::test_support::lock_test_env();
        // Too many args rejected without spawning.
        let many: Vec<String> = (0..100).map(|i| format!("a{}", i)).collect();
        assert!(validate_spawn_args(&many).is_err());
        // NUL byte rejected.
        assert!(validate_spawn_args(&["ok".to_string(), "bad\0arg".to_string()]).is_err());
        // Oversized arg rejected.
        assert!(validate_spawn_args(&["x".repeat(9000)]).is_err());
        // Valid args pass.
        assert!(validate_spawn_args(&["-l".to_string()]).is_ok());

        // Env key rules.
        let mut bad_key = HashMap::new();
        bad_key.insert("BAD-KEY!".to_string(), "v".to_string());
        assert!(validate_spawn_env(&bad_key).is_err());
        let mut nul_val = HashMap::new();
        nul_val.insert("GOOD".to_string(), "a\0b".to_string());
        assert!(validate_spawn_env(&nul_val).is_err());
        let mut good = HashMap::new();
        good.insert("GOOD_KEY".to_string(), "v".to_string());
        assert!(validate_spawn_env(&good).is_ok());

        // End-to-end: invalid args never spawn a session.
        let manager = PtyManager::new();
        let emitter = Arc::new(NoopEventEmitter);
        let res = manager.create_pty(
            emitter,
            PtyCreateOptions {
                shell_path: None,
                args: Some(many),
                cwd: None,
                cols: 80,
                rows: 24,
                env: None,
            },
        );
        assert!(res.is_err());
        assert!(manager.list_sessions().is_empty());
    }

    #[test]
    fn test_pty_manager_create_write_resize_and_close() {
        let _env = crate::test_support::lock_test_env();
        let manager = PtyManager::new();
        let logs = Arc::new(Mutex::new(Vec::new()));
        let exited = Arc::new(AtomicBool::new(false));

        let emitter = Arc::new(TestEventEmitter {
            output_received: logs.clone(),
            exit_received: exited.clone(),
        });

        let session_info = manager
            .create_pty(
                emitter,
                PtyCreateOptions {
                    shell_path: None,
                    args: None,
                    cwd: None,
                    cols: 80,
                    rows: 24,
                    env: None,
                },
            )
            .expect("Failed to create PTY session in manager test");

        assert!(!session_info.id.is_empty());
        assert_eq!(session_info.cols, 80);
        assert_eq!(session_info.rows, 24);
        assert_eq!(session_info.status, SessionStatus::Connected);

        // Verify session is listed in manager
        let active_sessions = manager.list_sessions();
        assert_eq!(active_sessions.len(), 1);
        assert_eq!(active_sessions[0].id, session_info.id);

        // Write command into PTY
        #[cfg(not(target_os = "windows"))]
        let cmd = "echo ENGINE_TEST_12345\n";
        #[cfg(target_os = "windows")]
        let cmd = "echo ENGINE_TEST_12345\r\n";

        let write_res = manager.write_to_pty(&session_info.id, cmd);
        assert!(write_res.is_ok());

        // Wait for reader thread to capture output via emitter
        let mut captured = false;
        for _ in 0..60 {
            if let Ok(l) = logs.lock() {
                let text = l.join("");
                if text.contains("ENGINE_TEST_12345") {
                    captured = true;
                    break;
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }

        assert!(
            captured,
            "Expected output stream to capture ENGINE_TEST_12345 via emitter"
        );

        // Test resize
        let resize_res = manager.resize_pty(&session_info.id, 100, 30);
        assert!(resize_res.is_ok());
        let updated_info = manager.get_session_info(&session_info.id).unwrap();
        assert_eq!(updated_info.cols, 100);
        assert_eq!(updated_info.rows, 30);

        // Close session
        let close_res = manager.close_pty(&session_info.id);
        assert!(close_res.is_ok());
        assert!(manager.list_sessions().is_empty());
    }

    #[test]
    fn test_pty_shell_variable_persistence_across_writes() {
        let _env = crate::test_support::lock_test_env();
        let manager = PtyManager::new();
        let logs = Arc::new(Mutex::new(Vec::new()));
        let exited = Arc::new(AtomicBool::new(false));

        let emitter = Arc::new(TestEventEmitter {
            output_received: logs.clone(),
            exit_received: exited.clone(),
        });

        let session_info = manager
            .create_pty(
                emitter,
                PtyCreateOptions {
                    // Pin cmd.exe on Windows: the default profile prefers
                    // pwsh when installed, but this test uses cmd syntax
                    // (`set` / `%VAR%`) which PowerShell does not implement.
                    #[cfg(target_os = "windows")]
                    shell_path: Some(
                        std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".to_string()),
                    ),
                    #[cfg(not(target_os = "windows"))]
                    shell_path: None,
                    args: None,
                    cwd: None,
                    cols: 80,
                    rows: 24,
                    env: None,
                },
            )
            .expect("Failed to create PTY session");

        // Write 1: Set environment variable in long-running PTY
        #[cfg(not(target_os = "windows"))]
        let set_cmd = "ENGINE_PERSIST_VAR=VAL_777\n";
        #[cfg(target_os = "windows")]
        let set_cmd = "set ENGINE_PERSIST_VAR=VAL_777\r\n";

        manager.write_to_pty(&session_info.id, set_cmd).unwrap();
        // Generous startup grace: ConPTY/cmd spawn on loaded CI runners can
        // take seconds; input queues in the PTY so nothing is lost.
        std::thread::sleep(std::time::Duration::from_millis(500));

        // Write 2: Read variable in second write
        #[cfg(not(target_os = "windows"))]
        let read_cmd = "echo $ENGINE_PERSIST_VAR\n";
        #[cfg(target_os = "windows")]
        let read_cmd = "echo %ENGINE_PERSIST_VAR%\r\n";

        manager.write_to_pty(&session_info.id, read_cmd).unwrap();

        let mut found_val = false;
        for _ in 0..60 {
            if let Ok(l) = logs.lock() {
                let text = l.join("");
                if text.contains("VAL_777") {
                    found_val = true;
                    break;
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }

        assert!(
            found_val,
            "Shell variable should persist across multiple writes in same PTY session"
        );

        manager.close_all();
    }

    #[test]
    fn test_real_pty_ai_cli_integration() {
        let _env = crate::test_support::lock_test_env();
        let agy_path = "/home/kali/.local/bin/agy";
        if !std::path::Path::new(agy_path).exists() {
            return; // Skip if agy CLI binary is not present on environment
        }

        let manager = PtyManager::new();
        let logs = Arc::new(Mutex::new(Vec::new()));
        let exited = Arc::new(AtomicBool::new(false));

        let emitter = Arc::new(TestEventEmitter {
            output_received: logs.clone(),
            exit_received: exited.clone(),
        });

        // Test 1: Direct PTY execution of AI CLI help
        let session_info = manager
            .create_pty(
                emitter.clone(),
                PtyCreateOptions {
                    shell_path: Some(agy_path.to_string()),
                    args: Some(vec!["--help".to_string()]),
                    cwd: None,
                    cols: 100,
                    rows: 30,
                    env: None,
                },
            )
            .expect("Failed to launch agy AI CLI in PTY");

        let mut captured_help = false;
        for _ in 0..20 {
            if let Ok(l) = logs.lock() {
                let text = l.join("");
                if text.contains("Usage of agy:") {
                    captured_help = true;
                    break;
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }

        assert!(
            captured_help,
            "AI CLI help output should be captured over PTY stream"
        );
        manager.close_pty(&session_info.id).unwrap();

        // Test 2: Interactive shell session running AI CLI version check & Ctrl+C interruption
        let shell_logs = Arc::new(Mutex::new(Vec::new()));
        let shell_exited = Arc::new(AtomicBool::new(false));
        let shell_emitter = Arc::new(TestEventEmitter {
            output_received: shell_logs.clone(),
            exit_received: shell_exited.clone(),
        });

        let shell_session = manager
            .create_pty(
                shell_emitter,
                PtyCreateOptions {
                    shell_path: None,
                    args: None,
                    cwd: None,
                    cols: 80,
                    rows: 24,
                    env: None,
                },
            )
            .expect("Failed to spawn shell session");

        // Execute agy --version command inside interactive PTY shell
        #[cfg(not(target_os = "windows"))]
        let version_cmd = format!("{} --version\n", agy_path);
        #[cfg(target_os = "windows")]
        let version_cmd = format!("{} --version\r\n", agy_path);

        manager
            .write_to_pty(&shell_session.id, &version_cmd)
            .unwrap();

        let mut captured_version = false;
        for _ in 0..20 {
            if let Ok(l) = shell_logs.lock() {
                let text = l.join("");
                if !text.trim().is_empty() {
                    captured_version = true;
                    break;
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }

        assert!(
            captured_version,
            "Interactive PTY session should execute agy AI CLI and stream version output"
        );

        // Send Ctrl+C (\x03) interrupt signal
        manager.write_to_pty(&shell_session.id, "\x03").unwrap();

        // Test resizing during active AI session
        let resize_res = manager.resize_pty(&shell_session.id, 120, 40);
        assert!(
            resize_res.is_ok(),
            "Resize during active session should succeed"
        );

        manager.close_pty(&shell_session.id).unwrap();
    }

    #[test]
    fn test_split_valid_utf8_buffers_partial_sequences() {
        let _env = crate::test_support::lock_test_env();
        // ASCII fast path drains the buffer without copying leftovers.
        let mut buf = b"hello".to_vec();
        assert_eq!(split_valid_utf8(&mut buf), "hello");
        assert!(buf.is_empty());

        // Incomplete multi-byte tail is retained for the next chunk.
        let emoji = "🚀".as_bytes(); // 4 bytes in UTF-8
        let mut buf = vec![b'a'];
        buf.extend_from_slice(&emoji[..2]);
        assert_eq!(split_valid_utf8(&mut buf), "a");
        assert_eq!(buf, &emoji[..2]);
        buf.extend_from_slice(&emoji[2..]);
        buf.extend_from_slice(b"!");
        assert_eq!(split_valid_utf8(&mut buf), "🚀!");
        assert!(buf.is_empty());

        // Lone incomplete sequence with no valid prefix emits nothing.
        let mut buf = emoji[..1].to_vec();
        assert_eq!(split_valid_utf8(&mut buf), "");
        assert_eq!(buf, &emoji[..1]);

        // Invalid bytes fall back to lossy conversion and clear the buffer.
        let mut buf = vec![0x66, 0x6f, 0xff, 0x6f];
        let text = split_valid_utf8(&mut buf);
        assert!(text.contains("fo"), "unexpected lossy text: {}", text);
        assert!(buf.is_empty());
    }

    #[test]
    fn test_write_chunked_preserves_exact_bytes() {
        let _env = crate::test_support::lock_test_env();
        struct VecWriter(Vec<u8>);
        impl Write for VecWriter {
            fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
                // Simulate partial writes: accept at most 7 bytes per call.
                let n = buf.len().min(7);
                self.0.extend_from_slice(&buf[..n]);
                Ok(n)
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let payload = "héllo\nworld\x03🚀\r\nline2\n".repeat(5000);
        let mut inner = VecWriter(Vec::new());
        {
            let mut w: Box<dyn Write + Send> = Box::new(VecWriter(Vec::new()));
            write_bytes_chunked(&mut w, payload.as_bytes()).expect("chunked write");
            w.flush().unwrap();
        }
        // Byte-exact through the partial-write path.
        let mut w2 = VecWriter(Vec::new());
        write_bytes_chunked_generic(&mut w2, payload.as_bytes()).expect("generic");
        inner.0 = w2.0;
        assert_eq!(inner.0, payload.as_bytes());
    }

    #[test]
    fn test_oversized_input_rejected_not_truncated() {
        let _env = crate::test_support::lock_test_env();
        let manager = PtyManager::new();
        let emitter = Arc::new(NoopEventEmitter);
        let info = manager
            .create_pty(
                emitter,
                PtyCreateOptions {
                    shell_path: None,
                    args: None,
                    cwd: None,
                    cols: 80,
                    rows: 24,
                    env: None,
                },
            )
            .expect("create PTY");
        let big = "x".repeat(MAX_INPUT_WRITE_BYTES + 1);
        let err = manager
            .write_to_pty(&info.id, &big)
            .expect_err("must reject");
        assert!(err.to_string().contains("exceeds maximum"));
        manager.close_pty(&info.id).unwrap();
    }

    #[test]
    fn test_large_multiline_unicode_paste_delivered() {
        let _env = crate::test_support::lock_test_env();
        let manager = PtyManager::new();
        let logs = Arc::new(Mutex::new(Vec::new()));
        let exited = Arc::new(AtomicBool::new(false));
        let emitter = Arc::new(TestEventEmitter {
            output_received: logs.clone(),
            exit_received: exited.clone(),
        });
        let info = manager
            .create_pty(
                emitter,
                PtyCreateOptions {
                    shell_path: None,
                    args: None,
                    cwd: None,
                    cols: 120,
                    rows: 30,
                    env: None,
                },
            )
            .expect("create PTY");
        // ~20 KB multiline unicode payload ending with a marker echo.
        let body = "café_Über_🚀_漢字_line\n".repeat(900);
        assert!(body.len() > 16_000 && body.len() < MAX_INPUT_WRITE_BYTES);
        #[cfg(not(target_os = "windows"))]
        let payload = format!(
            "printf '%s' '{}' > /dev/null; echo PASTE_MARKER_OK\n",
            body.replace('\'', "")
        );
        #[cfg(target_os = "windows")]
        let payload = "echo PASTE_MARKER_OK\r\n".to_string();
        // Pace delivery in small chunks with drain pauses: macOS discards
        // input that overflows its small canonical-mode queue (~4 KB), so a
        // single ~26 KB burst loses the trailing marker there while Linux
        // (64 KB queue) absorbs it. Chunking preserves exact byte order.
        const PASTE_CHUNK_BYTES: usize = 1024;
        let mut remaining = payload.as_str();
        while !remaining.is_empty() {
            let mut end = PASTE_CHUNK_BYTES.min(remaining.len());
            while !remaining.is_char_boundary(end) {
                end -= 1;
            }
            manager.write_to_pty(&info.id, &remaining[..end]).unwrap();
            remaining = &remaining[end..];
            std::thread::sleep(std::time::Duration::from_millis(40));
        }
        let mut found = false;
        for _ in 0..120 {
            if let Ok(l) = logs.lock() {
                if l.join("").contains("PASTE_MARKER_OK") {
                    found = true;
                    break;
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        assert!(found, "large paste must not be silently truncated");
        manager.close_pty(&info.id).unwrap();
    }

    #[test]
    fn test_resize_clamps_zero_and_oversize() {
        let _env = crate::test_support::lock_test_env();
        let manager = PtyManager::new();
        let emitter = Arc::new(NoopEventEmitter);
        let info = manager
            .create_pty(
                emitter,
                PtyCreateOptions {
                    shell_path: None,
                    args: None,
                    cwd: None,
                    cols: 0,
                    rows: 0,
                    env: None,
                },
            )
            .expect("create PTY");
        assert_eq!(info.cols, 80);
        assert_eq!(info.rows, 24);
        manager.resize_pty(&info.id, 0, 0).unwrap();
        let sized = manager.get_session_info(&info.id).unwrap();
        assert_eq!((sized.cols, sized.rows), (80, 24));
        manager.resize_pty(&info.id, 5000, 5000).unwrap();
        let clamped = manager.get_session_info(&info.id).unwrap();
        assert_eq!((clamped.cols, clamped.rows), (MAX_COLS, MAX_ROWS));
        manager.close_pty(&info.id).unwrap();
    }

    #[test]
    fn test_is_cmd_shell() {
        let _env = crate::test_support::lock_test_env();
        assert!(is_cmd_shell("C:\\Windows\\System32\\cmd.exe"));
        assert!(is_cmd_shell("cmd"));
        assert!(is_cmd_shell("CMD.EXE"));
        assert!(!is_cmd_shell("powershell.exe"));
        assert!(!is_cmd_shell("pwsh.exe"));
    }

    #[test]
    fn test_flatpak_host_argv_none_outside_flatpak() {
        let argv = vec!["/bin/bash".to_string()];
        assert!(flatpak_host_argv(None, &argv, "/home/u", &[]).is_none());
        assert!(flatpak_host_argv(Some(""), &argv, "/home/u", &[]).is_none());
    }

    #[test]
    fn test_flatpak_host_argv_wraps_shell_with_dir_and_env() {
        let argv = vec!["/bin/bash".to_string(), "-l".to_string()];
        let env = vec![
            ("TERM".to_string(), "xterm-256color".to_string()),
            ("KAI_TERMINAL".to_string(), "1".to_string()),
        ];
        let out = flatpak_host_argv(Some("com.kai.terminal"), &argv, "/home/u/my proj", &env)
            .expect("flatpak id set");
        assert_eq!(
            out,
            vec![
                "flatpak-spawn",
                "--host",
                "--watch-bus",
                "--directory=/home/u/my proj",
                "--env=TERM=xterm-256color",
                "--env=KAI_TERMINAL=1",
                "/bin/bash",
                "-l",
            ]
        );
    }

    #[test]
    fn test_flatpak_host_argv_keeps_user_args_after_env_flags() {
        // A user argument that looks like a flatpak-spawn option must stay
        // after the program name, where flatpak-spawn no longer parses it.
        let argv = vec!["/bin/sh".to_string(), "--env=X=1".to_string()];
        let out = flatpak_host_argv(Some("app"), &argv, "/", &[]).unwrap();
        let prog = out.iter().position(|a| a == "/bin/sh").unwrap();
        assert_eq!(&out[prog..], &["/bin/sh", "--env=X=1"]);
        assert!(flatpak_host_argv(Some("app"), &[], "/", &[]).is_none());
    }

    #[test]
    fn test_route_through_flatpak_host_is_identity_outside_flatpak() {
        let _env = crate::test_support::lock_test_env();
        if std::env::var_os("FLATPAK_ID").is_some() {
            return; // running the suite inside a Flatpak: nothing to compare
        }
        let mut cmd = CommandBuilder::new("/bin/bash");
        cmd.arg("-l");
        cmd.env("TERM", "xterm-256color");
        let routed = route_through_flatpak_host(cmd.clone(), "/tmp");
        assert_eq!(routed.get_argv(), cmd.get_argv());
        assert_eq!(
            routed.iter_extra_env_as_str().collect::<Vec<_>>(),
            cmd.iter_extra_env_as_str().collect::<Vec<_>>()
        );
    }

    #[test]
    fn test_validate_host_shell_path_accepts_absolute_and_strips_quotes() {
        assert_eq!(
            validate_host_shell_path("/usr/bin/zsh").unwrap(),
            "/usr/bin/zsh"
        );
        assert_eq!(
            validate_host_shell_path("  '/bin/bash' ").unwrap(),
            "/bin/bash"
        );
        assert_eq!(
            validate_host_shell_path("/home/u/my shells/fish").unwrap(),
            "/home/u/my shells/fish"
        );
    }

    #[test]
    fn test_validate_host_shell_path_rejects_unsafe_input() {
        for bad in [
            "",
            "   ",
            "zsh",
            "-c",
            "./sh",
            "/bin/sh\0",
            "/bin/sh\n/bin/x",
        ] {
            assert!(
                validate_host_shell_path(bad).is_err(),
                "must reject {bad:?}"
            );
        }
        let long = format!("/{}", "a".repeat(4096));
        assert!(validate_host_shell_path(&long).is_err());
    }

    #[test]
    fn test_login_shell_from_passwd_parses_the_seventh_field() {
        let line = "kai:x:1000:1000:Kai,,,:/home/kai:/usr/bin/zsh\n";
        assert_eq!(
            login_shell_from_passwd(line).as_deref(),
            Some("/usr/bin/zsh")
        );
        // Only the first line is read, and a trailing newline is tolerated.
        assert_eq!(
            login_shell_from_passwd("a:x:1:1::/h:/bin/bash\nb:x:2:2::/h:/bin/zsh").as_deref(),
            Some("/bin/bash")
        );
    }

    #[test]
    fn test_login_shell_from_passwd_skips_accounts_that_cannot_log_in() {
        for line in [
            "svc:x:999:999::/:/usr/sbin/nologin",
            "svc:x:999:999::/:/sbin/nologin",
            "svc:x:999:999::/:/bin/false",
            "svc:x:999:999::/:",
            "svc:x:999:999::/:zsh",
            "",
        ] {
            assert!(login_shell_from_passwd(line).is_none(), "line: {line:?}");
        }
    }

    #[test]
    fn test_resolve_flatpak_shell_prefers_the_request_without_a_host_lookup() {
        let shell = resolve_flatpak_shell(Some("/usr/bin/fish"), || {
            panic!("an explicit shell must not trigger the host lookup")
        })
        .unwrap();
        assert_eq!(shell, "/usr/bin/fish");
        // A host-only path is accepted even though the sandbox cannot see it.
        assert!(resolve_flatpak_shell(Some("/nix/store/x/bin/zsh"), || None).is_ok());
        assert!(resolve_flatpak_shell(Some("zsh"), || None).is_err());
    }

    #[test]
    fn test_resolve_flatpak_shell_falls_back_to_login_shell_then_sh() {
        let login = resolve_flatpak_shell(None, || Some("/usr/bin/zsh".to_string())).unwrap();
        assert_eq!(login, "/usr/bin/zsh");
        let blank = resolve_flatpak_shell(Some("  "), || Some("/bin/bash".to_string())).unwrap();
        assert_eq!(blank, "/bin/bash");
        let none = resolve_flatpak_shell(None, || None).unwrap();
        assert_eq!(none, FLATPAK_FALLBACK_SHELL);
    }

    #[cfg(not(target_os = "linux"))]
    #[test]
    fn test_flatpak_id_is_ignored_off_linux() {
        let _env = crate::test_support::lock_test_env();
        let previous = std::env::var_os("FLATPAK_ID");
        std::env::set_var("FLATPAK_ID", "com.kai.terminal");
        let seen = flatpak_id_from_env();
        match previous {
            Some(v) => std::env::set_var("FLATPAK_ID", v),
            None => std::env::remove_var("FLATPAK_ID"),
        }
        assert!(seen.is_none(), "Flatpak routing must stay Linux-only");
    }

    #[test]
    fn test_flatpak_blocks_cwd_probe_only_inside_flatpak() {
        assert!(!flatpak_blocks_cwd_probe(None));
        assert!(!flatpak_blocks_cwd_probe(Some("")));
        assert!(flatpak_blocks_cwd_probe(Some("com.kai.terminal")));
    }

    #[test]
    fn test_flatpak_cwd_hook_env_primes_bash_only() {
        for bash in ["/bin/bash", "/usr/bin/bash", "/nix/store/x/bin/bash"] {
            let env = flatpak_cwd_hook_env(bash);
            assert_eq!(env.len(), 1, "{bash}");
            assert_eq!(env[0].0, "PROMPT_COMMAND");
            let hook = &env[0].1;
            assert!(hook.contains("\\033]7;file://"), "must emit OSC 7: {hook}");
            assert!(!hook.contains('\n'), "hook must stay on one line");
            assert!(
                hook.contains("%25") && hook.contains("%20"),
                "must percent-encode"
            );
        }
        for other in [
            "/bin/zsh",
            "/usr/bin/fish",
            "/bin/sh",
            "/usr/bin/bashful",
            "bash-5",
        ] {
            assert!(flatpak_cwd_hook_env(other).is_empty(), "{other}");
        }
    }

    #[test]
    fn test_flatpak_cwd_hook_is_forwarded_to_the_host_as_an_env_flag() {
        let env = flatpak_cwd_hook_env("/bin/bash");
        let argv = vec!["/bin/bash".to_string()];
        let out = flatpak_host_argv(Some("com.kai.terminal"), &argv, "/home/u", &env).unwrap();
        let flag = out
            .iter()
            .find(|a| a.starts_with("--env=PROMPT_COMMAND="))
            .expect("hook must reach flatpak-spawn as --env");
        assert!(flag.contains("__kai_osc7"));
        // The flag precedes the program, so flatpak-spawn parses it.
        let flag_pos = out.iter().position(|a| a == flag).unwrap();
        let prog_pos = out.iter().position(|a| a == "/bin/bash").unwrap();
        assert!(flag_pos < prog_pos);
    }

    #[test]
    fn test_powershell_args_take_command() {
        let _env = crate::test_support::lock_test_env();
        assert!(!powershell_args_take_command(&["-NoLogo".to_string()]));
        assert!(!powershell_args_take_command(&[]));
        assert!(powershell_args_take_command(&[
            "-NoLogo".to_string(),
            "-Command".to_string(),
        ]));
        assert!(powershell_args_take_command(&["-c".to_string()]));
        assert!(powershell_args_take_command(&[
            "-EncodedCommand".to_string()
        ]));
        assert!(powershell_args_take_command(&["-File".to_string()]));
    }

    #[test]
    fn test_powershell_hook_wraps_prompt_and_reports_osc99() {
        let _env = crate::test_support::lock_test_env();
        let hook = powershell_cwd_hook_script();
        assert!(hook.contains("global:prompt"), "hook must define prompt");
        assert!(hook.contains("]9;9;"), "hook must emit OSC 9;9");
        assert!(
            hook.contains("-NoNewline"),
            "hook must not pollute prompt line"
        );
        assert!(
            hook.contains("$__kai_o"),
            "hook must preserve existing prompt"
        );
    }

    #[test]
    fn test_cmd_prompt_reports_osc99() {
        let _env = crate::test_support::lock_test_env();
        let def = cmd_cwd_prompt_value(None);
        assert!(def.starts_with("$e]9;9;$P$e\\"), "got: {def}");
        assert!(def.ends_with("$P$G"));
        // Existing custom prompt tail is preserved, not replaced.
        let custom = cmd_cwd_prompt_value(Some("$P$G$S"));
        assert!(custom.starts_with("$e]9;9;$P$e\\"));
        assert!(custom.ends_with("$P$G$S"), "got: {custom}");
        // Already-integrated prompts are left untouched (no doubling).
        let already = "$e]9;9;$P$e\\$P$G";
        assert_eq!(cmd_cwd_prompt_value(Some(already)), already);
    }

    #[test]
    fn test_extract_osc99_bel_and_st() {
        let _env = crate::test_support::lock_test_env();
        let bel = b"\x1b]9;9;C:\\Users\\kai\x07";
        assert_eq!(extract_osc_cwds(bel), vec!["C:\\Users\\kai"]);
        let st = b"\x1b]9;9;D:\\repo\x1b\\";
        assert_eq!(extract_osc_cwds(st), vec!["D:\\repo"]);
        // Empty payloads are ignored.
        let empty = b"\x1b]9;9;\x07";
        assert!(extract_osc_cwds(empty).is_empty());
    }

    #[test]
    fn test_extract_osc7_file_url() {
        let _env = crate::test_support::lock_test_env();
        // Unix path with percent-encoding.
        let seq = b"\x1b]7;file://host/home/kai/my%20proj\x07";
        assert_eq!(extract_osc_cwds(seq), vec!["/home/kai/my proj"]);
        // Windows drive-letter URL unstripped like the frontend handler.
        let win = b"\x1b]7;file://PC/C%3A/Users/kai\x1b\\";
        assert_eq!(extract_osc_cwds(win), vec!["C:/Users/kai"]);
        // Non-file payloads are ignored.
        let other = b"\x1b]7;https://example.com/x\x07";
        assert!(extract_osc_cwds(other).is_empty());
    }

    #[test]
    fn test_extract_osc_split_across_chunks() {
        let _env = crate::test_support::lock_test_env();
        // A sequence split across 4 KB reads yields nothing until complete;
        // the caller's retained tail + remainder then parses (mirrors the
        // reader thread's scan_buf behavior).
        let part1 = b"\x1b]9;9;C:\\Users\\k";
        let part2 = b"ai\x07";
        assert!(extract_osc_cwds(part1).is_empty());
        let mut rejoined = part1.to_vec();
        rejoined.extend_from_slice(part2);
        assert_eq!(extract_osc_cwds(&rejoined), vec!["C:\\Users\\kai"]);
    }

    #[test]
    fn test_resolve_process_cwd() {
        let _env = crate::test_support::lock_test_env();
        let pid = std::process::id();
        #[cfg(target_os = "linux")]
        {
            let resolved = resolve_process_cwd(pid);
            assert!(resolved.is_some());
            let cwd_str = resolved.unwrap();
            assert!(!cwd_str.is_empty());
            assert!(std::path::Path::new(&cwd_str).is_dir());
        }
        #[cfg(not(target_os = "linux"))]
        {
            let _ = resolve_process_cwd(pid);
        }
    }
}
