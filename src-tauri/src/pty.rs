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
}

/// Thread-safe manager for active PTY sessions.
#[derive(Default)]
pub struct PtyManager {
    pub sessions: Arc<Mutex<HashMap<String, PtySessionHandle>>>,
}

// Maximum output batch size before flushing to event emitter (16 KB)
const MAX_OUTPUT_BATCH_BYTES: usize = 16_384;
// Buffer read chunk size (4 KB)
const READ_BUFFER_CHUNK_BYTES: usize = 4_096;
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
        let shell_path = validate_and_resolve_shell(options.shell_path.as_deref())?;
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
        if let Some(ref args) = options.args {
            validate_spawn_args(args)?;
            cmd.args(args);
        } else if is_powershell_shell(&shell_path) {
            // Fast-path default: skip the banner even when the frontend
            // passes no args (older persisted tabs, custom launchers).
            // Profile scripts still run; this only removes the logo print
            // that floods ConPTY on slow first launches.
            cmd.arg("-NoLogo");
        }
        cmd.cwd(&cwd);
        // Ensure standard terminal capabilities so shells (zsh, bash, fish) and tools
        // enable line-editing (ZLE/Readline), 256 colors, truecolor, and autosuggestions.
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        if let Some(ref env_vars) = options.env {
            validate_spawn_env(env_vars)?;
            for (k, v) in env_vars {
                cmd.env(k, v);
            }
        }

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

        let reader_thread = std::thread::spawn(move || {
            let mut read_buf = [0u8; READ_BUFFER_CHUNK_BYTES];
            let mut batch_buf = Vec::with_capacity(MAX_OUTPUT_BATCH_BYTES);

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

                        // Check if child working directory changed
                        if let Some(p) = pid_reader {
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

        if let Err(e) = write_bytes_chunked(&mut *writer, data.as_bytes()) {
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

    /// Returns live resolved working directory for a session if active.
    pub fn get_session_cwd(&self, id: &str) -> Option<String> {
        let mut sessions = self.sessions.lock().ok()?;
        let session = sessions.get_mut(id)?;
        if let Some(pid) = session.pid {
            if let Some(curr) = resolve_process_cwd(pid) {
                session.cwd = curr.clone();
                return Some(curr);
            }
        }
        Some(session.cwd.clone())
    }

    /// Returns session metadata for a given ID.
    pub fn get_session_info(&self, id: &str) -> Option<PtySessionInfo> {
        let mut sessions = self.sessions.lock().ok()?;
        let session = sessions.get_mut(id)?;
        if let Some(pid) = session.pid {
            if let Some(curr) = resolve_process_cwd(pid) {
                session.cwd = curr;
            }
        }
        Some(PtySessionInfo {
            id: session.id.clone(),
            pid: session.pid,
            shell_path: session.shell_path.clone(),
            cwd: session.cwd.clone(),
            cols: session.cols,
            rows: session.rows,
            status: session.status.clone(),
        })
    }

    /// Returns list of all active session metadata objects.
    pub fn list_sessions(&self) -> Vec<PtySessionInfo> {
        if let Ok(mut sessions) = self.sessions.lock() {
            sessions
                .values_mut()
                .map(|s| {
                    if let Some(pid) = s.pid {
                        if let Some(curr) = resolve_process_cwd(pid) {
                            s.cwd = curr;
                        }
                    }
                    PtySessionInfo {
                        id: s.id.clone(),
                        pid: s.pid,
                        shell_path: s.shell_path.clone(),
                        cwd: s.cwd.clone(),
                        cols: s.cols,
                        rows: s.rows,
                        status: s.status.clone(),
                    }
                })
                .collect()
        } else {
            Vec::new()
        }
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
        let manager = PtyManager::new();
        assert!(manager.list_sessions().is_empty());
        assert!(manager.get_session_info("non-existent-id").is_none());
        assert!(manager.write_to_pty("non-existent-id", "test").is_err());
        assert!(manager.resize_pty("non-existent-id", 100, 30).is_err());
        assert!(manager.close_pty("non-existent-id").is_ok());
    }

    #[test]
    fn test_spawn_args_and_env_validation() {
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
    fn test_resolve_process_cwd() {
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
