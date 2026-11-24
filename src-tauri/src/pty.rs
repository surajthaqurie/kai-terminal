use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::io::Write;
use std::sync::{Arc, Mutex};
use uuid::Uuid;

use crate::error::TerminalError;
use crate::shell::{
    check_host_pty_support, is_wsl_shell_path, validate_and_resolve_cwd,
    validate_and_resolve_shell, wsl_env_forward, wsl_failure_hint, LEAKED_CHROMIUM_ENV,
};

/// Abstract event emitter trait for PTY output streaming and process exit notification.
pub trait TerminalEventEmitter: Send + Sync + 'static {
    fn emit_output(&self, payload: PtyOutputPayload);
    fn emit_exit(&self, payload: PtyExitPayload);
    fn emit_cwd(&self, _payload: PtyCwdPayload) {}
}

/// Which window shows each session. A session's output, exit and cwd events go to
/// that window only: broadcasting them made every open window receive, JSON-decode
/// and discard every other window's terminal output.
#[derive(Default)]
pub struct OwnerRoutes {
    owners: Mutex<HashMap<String, String>>,
}

impl OwnerRoutes {
    /// Points session `id`'s events at window `label`.
    pub fn set(&self, id: &str, label: &str) {
        if let Ok(mut owners) = self.owners.lock() {
            owners.insert(id.to_string(), label.to_string());
        }
    }

    /// The window that shows `id`, if one has been recorded.
    pub fn owner_of(&self, id: &str) -> Option<String> {
        self.owners.lock().ok()?.get(id).cloned()
    }

    /// Forgets a finished session.
    pub fn remove(&self, id: &str) {
        if let Ok(mut owners) = self.owners.lock() {
            owners.remove(id);
        }
    }

    pub fn len(&self) -> usize {
        self.owners.lock().map(|o| o.len()).unwrap_or(0)
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// Tauri implementation of TerminalEventEmitter: sends each session's events to
/// the window that shows it ([`OwnerRoutes`]), never to every window.
///
/// `default_owner` is the window that created the session: it receives the
/// events until a route is recorded (the first prompt can arrive before
/// `create_pty` has returned). A window that closed mid-stream is simply not a
/// target, so a late event is dropped, not delivered elsewhere.
#[cfg(feature = "tauri")]
pub struct TauriEventEmitter<R: tauri::Runtime = tauri::Wry> {
    pub app_handle: tauri::AppHandle<R>,
    pub routes: Arc<OwnerRoutes>,
    pub default_owner: String,
}

#[cfg(feature = "tauri")]
impl<R: tauri::Runtime> TauriEventEmitter<R> {
    fn target(&self, id: &str) -> String {
        self.routes
            .owner_of(id)
            .unwrap_or_else(|| self.default_owner.clone())
    }
}

#[cfg(feature = "tauri")]
impl<R: tauri::Runtime> TerminalEventEmitter for TauriEventEmitter<R> {
    fn emit_output(&self, payload: PtyOutputPayload) {
        use tauri::Emitter;
        let target = self.target(&payload.id);
        let _ = self
            .app_handle
            .emit_to(target.as_str(), "pty-output", payload);
    }

    fn emit_exit(&self, payload: PtyExitPayload) {
        use tauri::Emitter;
        let target = self.target(&payload.id);
        let _ = self
            .app_handle
            .emit_to(target.as_str(), "pty-exit", payload);
    }

    fn emit_cwd(&self, payload: PtyCwdPayload) {
        use tauri::Emitter;
        let target = self.target(&payload.id);
        let _ = self.app_handle.emit_to(target.as_str(), "pty-cwd", payload);
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
    /// Behind its own `Arc<Mutex<..>>` so a resize (a native call) can run
    /// after the manager-wide sessions lock is released.
    pub master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    pub writer: Arc<Mutex<Box<dyn Write + Send>>>,
    pub killer: Box<dyn ChildKiller + Send + Sync>,
    /// Output pacing for this session (see [`FlowControl`]).
    pub flow: Arc<FlowControl>,
    pub cols: u16,
    pub rows: u16,
    pub status: SessionStatus,
    /// Label of the window that shows this session. Closing that window ends the
    /// session (React cleanup is not guaranteed when a webview is torn down), and a
    /// tab moved to another window changes it (`PtyManager::set_owner`).
    pub owner: String,
    /// Last time the live OS cwd was probed for this session. Probes are
    /// syscalls (Linux) or child-process spawns (macOS `lsof`), so every
    /// accessor below throttles them — unthrottled polling from the
    /// frontend (focus + interval + per-command checks) otherwise spawns
    /// processes fast enough to stall the window.
    pub last_cwd_probe: std::time::Instant,
    /// Set by the waiter thread once the shell has been reaped (it no longer exists as a process).
    /// Closing a session on Unix only sends SIGHUP; this tells the follow-up whether the shell
    /// really went away or has to be killed (REL-04).
    pub reaped: Arc<std::sync::atomic::AtomicBool>,
}

/// What is needed to finish off a shell that did not leave when asked (Unix).
pub struct Straggler {
    #[cfg(unix)]
    pid: Option<u32>,
    #[cfg(unix)]
    foreground_group: Option<i32>,
    #[cfg(unix)]
    reaped: Arc<std::sync::atomic::AtomicBool>,
}

/// How long a shell gets to leave after SIGHUP before it is killed outright.
#[cfg(unix)]
const CLOSE_GRACE: std::time::Duration = std::time::Duration::from_millis(500);

/// Marks the session closed and tells its shell to go. On Unix the shell only gets SIGHUP, which
/// a shell or job may trap or ignore; the returned [`Straggler`] is what lets the caller kill it
/// after a grace period if it is still there (REL-04). On Windows the kill is already forceful.
fn end_session(session: &mut PtySessionHandle) -> Straggler {
    session.status = SessionStatus::Disconnected;
    // Never leave the output thread waiting on a consumer that may be gone.
    session.flow.close();
    #[cfg(unix)]
    let foreground_group = session
        .master
        .lock()
        .ok()
        .and_then(|m| m.process_group_leader());
    let _ = session.killer.kill();
    let straggler = Straggler {
        #[cfg(unix)]
        pid: session.pid,
        #[cfg(unix)]
        foreground_group,
        #[cfg(unix)]
        reaped: session.reaped.clone(),
    };
    #[cfg(unix)]
    {
        // A single closed tab: do not make the caller wait. A short-lived thread follows up.
        let for_thread = Straggler {
            pid: straggler.pid,
            foreground_group: straggler.foreground_group,
            reaped: straggler.reaped.clone(),
        };
        std::thread::spawn(move || {
            std::thread::sleep(CLOSE_GRACE);
            kill_if_still_running(&for_thread);
        });
    }
    straggler
}

/// SIGKILL the shell and its foreground job when the shell has not been reaped yet.
#[cfg(unix)]
fn kill_if_still_running(s: &Straggler) {
    if s.reaped.load(std::sync::atomic::Ordering::SeqCst) {
        return;
    }
    // SAFETY: plain signal system calls with process / group ids the OS reported for this
    // session's own shell; the shell has not been reaped, so its pid cannot have been reused.
    unsafe {
        if let Some(group) = s.foreground_group.filter(|g| *g > 1) {
            libc::killpg(group, libc::SIGKILL);
        }
        if let Some(pid) = s.pid {
            libc::kill(pid as libc::pid_t, libc::SIGKILL);
        }
    }
}

/// Shutdown path: wait up to [`CLOSE_GRACE`] for every shell to be reaped, then kill the rest.
#[cfg(unix)]
fn wait_then_kill_stragglers(stragglers: Vec<Straggler>) {
    let deadline = std::time::Instant::now() + CLOSE_GRACE;
    while std::time::Instant::now() < deadline
        && stragglers
            .iter()
            .any(|s| !s.reaped.load(std::sync::atomic::Ordering::SeqCst))
    {
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    for s in &stragglers {
        kill_if_still_running(s);
    }
}

#[cfg(not(unix))]
fn wait_then_kill_stragglers(_stragglers: Vec<Straggler>) {}

/// Removes `id` from `map` under the lock and drops the removed value only
/// after the lock guard is gone.
///
/// Dropping a session drops its PTY master, which on Windows calls
/// `ClosePseudoConsole` — a call that can block until output is drained. If the
/// global map lock were held across that drop, the reader thread (which needs
/// the lock to publish cwd changes) could never drain, and every tab's
/// create/write/resize/close would stall behind the one exiting session.
///
/// Returns whether `id` was still in the map. For the waiter thread that is how a natural
/// exit (the entry is still there) is told from an explicit close (`close_pty`, `close_all` and
/// a window closing all remove the entry first, then kill the shell).
fn remove_and_drop_outside_lock<T>(map: &Mutex<HashMap<String, T>>, id: &str) -> bool {
    // The guard is a temporary moved into `and_then`; it is released when the
    // closure returns, i.e. before `removed` is dropped below.
    let removed = map.lock().ok().and_then(|mut m| m.remove(id));
    let was_present = removed.is_some();
    drop(removed);
    was_present
}

/// Helper processes the console host starts next to a shell. They are not user
/// work: a shell that only has these as children is idle.
#[cfg(any(windows, test))]
fn is_console_helper_process(image_name: &str) -> bool {
    ["conhost.exe", "openconsole.exe", "wslhost.exe"]
        .iter()
        .any(|helper| image_name.eq_ignore_ascii_case(helper))
}

/// Unix: the shell is idle at its prompt when it owns the terminal's foreground
/// process group; anything else in the foreground is a running job. `fg_group`
/// is the foreground group leader reported by the PTY (`None`: unknown, so not
/// reported as busy).
#[cfg(any(unix, test))]
fn foreground_job_running(shell_pid: u32, fg_group: Option<i64>) -> bool {
    matches!(fg_group, Some(group) if group > 0 && group != i64::from(shell_pid))
}

/// Windows: true when `shell_pid` has a child process that is not a console
/// helper — a command the user started (`ping`, a build, an editor...).
#[cfg(windows)]
fn windows_shell_has_running_child(shell_pid: u32) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    // SAFETY: the snapshot handle is checked against INVALID_HANDLE_VALUE and always
    // closed; `entry` is zero-initialised with `dwSize` set as the API requires and is
    // only read after the API reported success; the exe name is read up to its NUL
    // within the fixed-size array.
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot == INVALID_HANDLE_VALUE {
            return false;
        }
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut busy = false;
        let mut more = Process32FirstW(snapshot, &mut entry);
        while more != 0 {
            if entry.th32ParentProcessID == shell_pid {
                let len = entry
                    .szExeFile
                    .iter()
                    .position(|&c| c == 0)
                    .unwrap_or(entry.szExeFile.len());
                if !is_console_helper_process(&String::from_utf16_lossy(&entry.szExeFile[..len])) {
                    busy = true;
                    break;
                }
            }
            more = Process32NextW(snapshot, &mut entry);
        }
        CloseHandle(snapshot);
        busy
    }
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

/// Most output kept for one session while it is being moved to another window. A
/// move takes milliseconds; this only bounds a window that never finishes the move.
const MAX_HELD_BYTES: usize = 8 * 1024 * 1024;

/// What a session printed (and whether it ended) while it was in transit between two
/// windows. The receiving window writes `data` right after the screen snapshot it
/// was sent, then carries on with live events.
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize)]
pub struct HandoffRelease {
    pub data: Vec<String>,
    /// The shell ended during the move.
    pub exited: bool,
    pub exit_code: Option<i32>,
}

#[derive(Default)]
struct HeldSession {
    chunks: VecDeque<String>,
    bytes: usize,
    exit: Option<Option<i32>>,
}

/// Holds back the output and exit events of sessions that are moving between windows.
///
/// A tab dragged into a new window keeps its running shell. The old window takes a
/// snapshot of the screen while the new one is still loading; anything the shell
/// prints in between would be lost (it has no listener) or shown twice. So between
/// `begin` and `release` a session's events are kept here instead of being emitted,
/// then handed to the new window in order.
#[derive(Default)]
pub struct HandoffGate {
    held: Mutex<HashMap<String, HeldSession>>,
}

impl HandoffGate {
    /// Starts holding `id`'s events (a second call keeps what is already held).
    pub fn begin(&self, id: &str) {
        if let Ok(mut held) = self.held.lock() {
            held.entry(id.to_string()).or_default();
        }
    }

    pub fn is_held(&self, id: &str) -> bool {
        self.held.lock().is_ok_and(|h| h.contains_key(id))
    }

    /// Keeps the chunk when `id` is held (returns `None`); hands it back otherwise.
    fn hold_output(&self, payload: PtyOutputPayload) -> Option<PtyOutputPayload> {
        let Ok(mut held) = self.held.lock() else {
            return Some(payload);
        };
        let Some(slot) = held.get_mut(&payload.id) else {
            return Some(payload);
        };
        slot.bytes += payload.data.len();
        slot.chunks.push_back(payload.data);
        while slot.bytes > MAX_HELD_BYTES {
            match slot.chunks.pop_front() {
                Some(dropped) => slot.bytes -= dropped.len(),
                None => break,
            }
        }
        None
    }

    fn hold_exit(&self, payload: PtyExitPayload) -> Option<PtyExitPayload> {
        let Ok(mut held) = self.held.lock() else {
            return Some(payload);
        };
        match held.get_mut(&payload.id) {
            Some(slot) => {
                slot.exit = Some(payload.exit_code);
                None
            }
            None => Some(payload),
        }
    }

    /// Stops holding `id` and returns what was kept, in order. `None` when it was
    /// not held. Events after this call are emitted live again.
    pub fn release(&self, id: &str) -> Option<HandoffRelease> {
        let slot = self.held.lock().ok()?.remove(id)?;
        Some(HandoffRelease {
            data: slot.chunks.into_iter().collect(),
            exited: slot.exit.is_some(),
            exit_code: slot.exit.flatten(),
        })
    }

    pub fn forget(&self, id: &str) {
        if let Ok(mut held) = self.held.lock() {
            held.remove(id);
        }
    }
}

/// Output flow control for one session (PERF-01).
///
/// The frontend acknowledges the output it has handed to the terminal emulator
/// (`pty_ack`). Bytes emitted but not yet acknowledged are "in flight". Once that
/// reaches the high-water mark the output thread stops emitting until the count
/// falls to the low-water mark; it stops reading the bounded queue in front of it,
/// the reader thread stops reading the PTY, and the child blocks on its next write
/// exactly as it would on a terminal that cannot keep up. Nothing is dropped and
/// nothing grows without bound: in flight is at most the high-water mark plus one
/// batch, and the queue is a handful of chunks.
///
/// Waiting never outlives the session: [`FlowControl::close`] (explicit close, app
/// exit, or the shell's output ending) wakes the waiter and disables further
/// waiting, so closing a tab, or a shell that exited, never depends on a stalled
/// consumer draining anything.
pub struct FlowControl {
    state: Mutex<FlowState>,
    changed: std::sync::Condvar,
    high: u64,
    low: u64,
    stall_timeout: std::time::Duration,
}

#[derive(Default)]
struct FlowState {
    in_flight: u64,
    closed: bool,
}

impl FlowControl {
    pub fn new(high: u64, low: u64) -> Self {
        Self {
            state: Mutex::new(FlowState::default()),
            changed: std::sync::Condvar::new(),
            high,
            low: low.min(high),
            stall_timeout: FLOW_STALL_RESYNC,
        }
    }

    /// Overrides how long a pause may last with no acknowledgement at all (tests).
    pub fn with_stall_timeout(mut self, timeout: std::time::Duration) -> Self {
        self.stall_timeout = timeout;
        self
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, FlowState> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Blocks while the session is at or above the high-water mark, until the
    /// frontend has acknowledged enough to be at or below the low-water mark, or
    /// until the session is closed.
    pub fn wait_for_credit(&self) {
        let mut state = self.lock();
        if state.closed || state.in_flight < self.high {
            return;
        }
        while !state.closed && state.in_flight > self.low {
            let (guard, timeout) = self
                .changed
                .wait_timeout(state, self.stall_timeout)
                .unwrap_or_else(|e| e.into_inner());
            state = guard;
            if timeout.timed_out() && !state.closed && state.in_flight > self.low {
                // Last resort: no acknowledgement at all for a long time. A frontend that
                // is merely slow still acknowledges something within this window, so
                // this means credit was lost (output delivered to a window that no
                // longer exists, an event the frontend never saw). Give the credit back
                // rather than freeze the terminal for good. Bounded: another high-water
                // mark of output, then the next pause.
                eprintln!(
                    "[kai] output flow control: no acknowledgement for {:?} with {} bytes in flight; resetting",
                    self.stall_timeout, state.in_flight
                );
                state.in_flight = 0;
            }
        }
    }

    /// Forgets everything in flight. Used when the window that shows the session
    /// changes: whatever was sent to the previous window will never be acknowledged
    /// by the new one, and must not count against it.
    pub fn reset(&self) {
        self.lock().in_flight = 0;
        self.changed.notify_all();
    }

    /// Records bytes handed to the frontend.
    pub fn add(&self, bytes: u64) {
        let mut state = self.lock();
        state.in_flight = state.in_flight.saturating_add(bytes);
    }

    /// Records bytes the frontend has handed to the terminal emulator. More than
    /// is in flight is tolerated (the surplus is ignored), never a failure.
    pub fn ack(&self, bytes: u64) {
        let mut state = self.lock();
        state.in_flight = state.in_flight.saturating_sub(bytes);
        self.changed.notify_all();
    }

    /// Ends all waiting for good (the session is over).
    pub fn close(&self) {
        self.lock().closed = true;
        self.changed.notify_all();
    }

    /// Bytes emitted and not yet acknowledged.
    pub fn in_flight(&self) -> u64 {
        self.lock().in_flight
    }
}

/// In flight at which the output thread stops emitting (1 MiB).
pub const FLOW_HIGH_WATER_BYTES: u64 = 1024 * 1024;
/// In flight at which it resumes (256 KiB); well above the frontend's ack batch so
/// a partially acknowledged tail can never leave the session waiting.
pub const FLOW_LOW_WATER_BYTES: u64 = 256 * 1024;
/// How long a pause may last with no acknowledgement before the credit is assumed
/// lost and given back (see [`FlowControl::wait_for_credit`]).
const FLOW_STALL_RESYNC: std::time::Duration = std::time::Duration::from_secs(30);
/// Chunks (up to 32 KiB each) the reader may queue ahead of the output thread.
const READ_QUEUE_CHUNKS: usize = 8;

/// Wraps a session's real emitter so [`HandoffGate`] can hold its events, and so
/// output that reaches the frontend is counted and paced by [`FlowControl`].
struct GatedEmitter {
    inner: Arc<dyn TerminalEventEmitter>,
    gate: Arc<HandoffGate>,
    flow: Arc<FlowControl>,
}

impl TerminalEventEmitter for GatedEmitter {
    fn emit_output(&self, payload: PtyOutputPayload) {
        // Paces the output thread (and through it the shell) while the frontend is behind.
        self.flow.wait_for_credit();
        if let Some(payload) = self.gate.hold_output(payload) {
            // Only what really reaches the frontend counts as in flight: it is the
            // only thing the frontend will acknowledge. (Output held for a window
            // move is handed over through `handoff_finish`, not as events.)
            self.flow.add(payload.data.len() as u64);
            self.inner.emit_output(payload);
        }
    }

    fn emit_exit(&self, payload: PtyExitPayload) {
        if let Some(payload) = self.gate.hold_exit(payload) {
            self.inner.emit_exit(payload);
        }
    }

    fn emit_cwd(&self, payload: PtyCwdPayload) {
        self.inner.emit_cwd(payload);
    }
}

/// Thread-safe manager for active PTY sessions.
#[derive(Default)]
pub struct PtyManager {
    pub sessions: Arc<Mutex<HashMap<String, PtySessionHandle>>>,
    gate: Arc<HandoffGate>,
    routes: Arc<OwnerRoutes>,
    flow_high: u64,
    flow_low: u64,
}

// Maximum output batch size before flushing to event emitter (64 KB, the
// frontend's per-write slice).
const MAX_OUTPUT_BATCH_BYTES: usize = 65_536;
// How long the output thread gathers further reads after the first one before
// emitting. ConPTY and TUIs (AI CLIs redrawing a spinner, status line and
// streamed text) deliver many tiny reads per frame; each emit is a script
// evaluation in the WebView. Coalescing them for a few ms turns dozens of IPC
// events per frame into one, well under a frame of added latency.
const OUTPUT_COALESCE_WINDOW: std::time::Duration = std::time::Duration::from_millis(4);
// Buffer read chunk size (32 KB). `read()` returns whatever is available, so
// interactive latency is unchanged; under floods (`cat bigfile`, installs)
// each read drains up to 8x more bytes per IPC event than the old 4 KB
// buffer, cutting event/serialization overhead on every OS.
const READ_BUFFER_CHUNK_BYTES: usize = 32_768;
// Dimension bounds limits
const MIN_COLS: u16 = 10;
// Generous enough for a maximized 4K pane at a small font (~530 columns): a cap
// below what xterm fits leaves the shell wrapping narrower than the screen.
const MAX_COLS: u16 = 1000;
const MIN_ROWS: u16 = 2;
const MAX_ROWS: u16 = 500;
// Maximum bytes per single `write()` syscall when streaming input to the
// PTY master. Large pastes are sent as a sequence of chunks with the exact
// same byte order — this is flow pacing, NOT line splitting: newlines and
// control characters are never inserted, removed, or reordered.
const WRITE_SYSCALL_CHUNK_BYTES: usize = 32_768;
// Maximum input payload size per IPC write call (1 MB). This bounds a single
// `write_to_pty` invoke only, not a paste: the frontend
// (src/services/ptyWriteQueue.ts) splits larger writes into 256 KB UTF-8-safe
// chunks and sends them sequentially per session, awaiting each call. The
// guard stays as a safety net so no single IPC message can be unbounded.
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
            gate: Arc::new(HandoffGate::default()),
            routes: Arc::new(OwnerRoutes::default()),
            flow_high: FLOW_HIGH_WATER_BYTES,
            flow_low: FLOW_LOW_WATER_BYTES,
        }
    }

    /// Records that the frontend has handed `bytes` of session `id`'s output to the
    /// terminal emulator, freeing credit for more. Unknown (already closed) ids are
    /// fine: late acknowledgements are normal.
    pub fn ack_output(&self, id: &str, bytes: u64) {
        let flow = self
            .sessions
            .lock()
            .ok()
            .and_then(|s| s.get(id).map(|h| h.flow.clone()));
        if let Some(flow) = flow {
            flow.ack(bytes);
        }
    }

    /// Output emitted to the frontend and not yet acknowledged, if `id` is live.
    pub fn output_in_flight(&self, id: &str) -> Option<u64> {
        let sessions = self.sessions.lock().ok()?;
        Some(sessions.get(id)?.flow.in_flight())
    }

    /// The table that decides which window receives each session's events.
    pub fn routes(&self) -> Arc<OwnerRoutes> {
        self.routes.clone()
    }

    /// Spawns a new native shell attached to a PTY.
    pub fn create_pty(
        &self,
        emitter: Arc<dyn TerminalEventEmitter>,
        options: PtyCreateOptions,
    ) -> Result<PtySessionInfo, TerminalError> {
        // Every session's events go through the gate, so a tab can later be moved to
        // another window without losing output (see `HandoffGate`).
        let flow = Arc::new(FlowControl::new(self.flow_high, self.flow_low));
        let emitter: Arc<dyn TerminalEventEmitter> = Arc::new(GatedEmitter {
            inner: emitter,
            gate: self.gate.clone(),
            flow: flow.clone(),
        });
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
        // Directories recorded after startup (the `kai` CLI shim): given to this child's
        // own environment instead of mutating the app's (Unix; see kai_cli).
        if let Some(path) = crate::kai_cli::spawn_path_with_extras() {
            cmd.env("PATH", path);
        }
        // The parent (WebView2, or the Electron app that launched Kai) can leak
        // its crash-reporter pipe into every tab; a Chromium-based tool run
        // there then fails with "registration_protocol_win.cc: CreateFile".
        // Dropped before the caller's own env so an explicit value still wins.
        for key in LEAKED_CHROMIUM_ENV {
            cmd.env_remove(key);
        }
        if let Some(ref env_vars) = options.env {
            validate_spawn_env(env_vars)?;
            for (k, v) in env_vars {
                cmd.env(k, v);
            }
        }

        if is_wsl_shell_path(&shell_path) {
            // wsl.exe only hands the Linux side the variables WSLENV names, so
            // KAI_TERMINAL (which `kai <agent>` requires) would stop at the
            // boundary. Keep the caller's, then the process's, own WSLENV.
            let user_wslenv = options.env.as_ref().and_then(|e| {
                e.iter()
                    .find(|(k, _)| k.eq_ignore_ascii_case("WSLENV"))
                    .map(|(_, v)| v.clone())
            });
            let existing = user_wslenv.or_else(|| std::env::var("WSLENV").ok());
            cmd.env(
                "WSLENV",
                wsl_env_forward(existing.as_deref(), &["KAI_TERMINAL"]),
            );
        }

        if flatpak_id.is_some() {
            // Best-effort cwd reporting for host shells (see
            // `flatpak_cwd_hook_env`); preserves existing PROMPT_COMMAND and avoids duplicate hooks.
            let env_prompt = std::env::var(FLATPAK_CWD_HOOK_VAR).ok();
            let user_prompt = options
                .env
                .as_ref()
                .and_then(|e| e.get(FLATPAK_CWD_HOOK_VAR).map(|s| s.as_str()))
                .or(env_prompt.as_deref());
            for (k, v) in flatpak_cwd_hook_env(&shell_path, user_prompt) {
                cmd.env(k, v);
            }
        }

        let cmd = route_through_flatpak_host(cmd, &cwd);

        let child = pair.slave.spawn_command(cmd).map_err(|e| {
            let mut msg = format!("Child process startup failed: {}", e);
            if is_wsl_shell_path(&shell_path) {
                msg.push(' ');
                msg.push_str(wsl_failure_hint());
            } else if flatpak_id.is_some() {
                msg.push(' ');
                msg.push_str(flatpak_failure_hint());
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

        let reaped = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let reaped_waiter = reaped.clone();
        let handle = PtySessionHandle {
            id: session_id.clone(),
            pid,
            shell_path,
            cwd,
            master: Arc::new(Mutex::new(pair.master)),
            writer,
            killer,
            flow: flow.clone(),
            cols,
            rows,
            status: SessionStatus::Connected,
            owner: String::new(),
            last_cwd_probe: std::time::Instant::now(),
            reaped,
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

        // Output thread: coalesces raw reads into few, larger IPC events.
        // Bounded: when the output thread is paused by flow control this fills up and
        // the reader blocks, so the PTY itself stops being drained (see FlowControl).
        let (out_tx, out_rx) = std::sync::mpsc::sync_channel::<Vec<u8>>(READ_QUEUE_CHUNKS);
        let emitter_out = emitter.clone();
        let id_out = session_id.clone();
        let output_thread = std::thread::spawn(move || {
            coalesce_output(out_rx, OUTPUT_COALESCE_WINDOW, |text| {
                emitter_out.emit_output(PtyOutputPayload {
                    id: id_out.clone(),
                    data: text,
                });
            });
        });

        let flow_reader = flow.clone();
        let reader_thread = std::thread::spawn(move || {
            let mut read_buf = [0u8; READ_BUFFER_CHUNK_BYTES];
            // OSC 7 / 9;9 cwd reports (primary Windows mechanism — see the prompt
            // integration in `create_pty`). The scanner returns each report once
            // and only retains an incomplete trailing sequence, so sequences
            // split across reads are reassembled without re-parsing old bytes.
            let mut osc_scanner = OscCwdScanner::default();

            loop {
                match read_retrying(&mut reader, &mut read_buf) {
                    Ok(0) => break, // EOF reached
                    Ok(n) => {
                        let _ = out_tx.send(read_buf[..n].to_vec());

                        // OSC 7 / OSC 9;9 cwd reports sniffed from shell output.
                        // This is what keeps `handle.cwd` (and therefore
                        // `get_pty_cwd` + focus/interval/cd probes) truthful
                        // on Windows, where `resolve_process_cwd` is
                        // unavailable. Frontend xterm parses the same bytes
                        // independently; output forwarding above is untouched.
                        for osc_cwd in osc_scanner.push(&read_buf[..n]) {
                            if osc_cwd != last_emitted_cwd && osc_cwd_is_usable(&osc_cwd) {
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

            // The shell's output has ended: nothing more can arrive, so nothing may wait
            // for the frontend any more (the exit event must not depend on it).
            flow_reader.close();
            // Closing the channel makes the output thread flush what it holds;
            // joining it keeps "all output before the exit event" (the waiter
            // joins this thread before emitting exit).
            drop(out_tx);
            let _ = output_thread.join();
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
        let routes_waiter = self.routes.clone();

        std::thread::spawn(move || {
            let mut child = child;
            let exit_status = child.wait();
            let exit_code = exit_status.ok().map(|status| status.exit_code() as i32);

            // Clean up session entry & drop master so reader unblocks (hang fix on Windows ConPTY).
            // The drop (ClosePseudoConsole on Windows) runs with the global
            // sessions lock RELEASED: it can block until the reader drains, and the
            // reader itself takes that lock to publish cwd changes.
            let ended_by_itself = remove_and_drop_outside_lock(&sessions_map, &id_clone_waiter);
            reaped_waiter.store(true, std::sync::atomic::Ordering::SeqCst);

            // Ensure reader thread finishes flushing before exit event is sent
            let _ = reader_thread.join();

            // Emit session exit event, then forget where it was routed. A session that was
            // closed on purpose reports nothing: its pane is already gone, and the code a
            // killed child leaves behind (1 on Windows) is indistinguishable from a real
            // `exit 1`, so it would count as a crash (REL-03).
            if ended_by_itself {
                emitter.emit_exit(PtyExitPayload {
                    id: id_clone_waiter.clone(),
                    exit_code,
                });
            }
            routes_waiter.remove(&id_clone_waiter);
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
    /// themselves. A single call over 1 MB (`MAX_INPUT_WRITE_BYTES`) is
    /// rejected rather than silently truncated; the frontend never sends one,
    /// since it chunks large writes below that bound.
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
    ///
    /// The native resize (`ResizePseudoConsole` / `TIOCSWINSZ`) runs with the
    /// global sessions lock released, so a window drag-resize cannot stall other
    /// sessions' write lookups, creates or closes.
    pub fn resize_pty(&self, id: &str, cols: u16, rows: u16) -> Result<(), TerminalError> {
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

        let master = {
            let mut sessions = self
                .sessions
                .lock()
                .map_err(|e| TerminalError::IoError(format!("Lock failure: {}", e)))?;
            let Some(session) = sessions.get_mut(id) else {
                return Err(TerminalError::SessionNotFound(id.to_string()));
            };
            if session.status != SessionStatus::Connected {
                return Ok(());
            }
            session.cols = valid_cols;
            session.rows = valid_rows;
            Arc::clone(&session.master)
        };

        if let Ok(master) = master.lock() {
            let _ = master.resize(PtySize {
                rows: valid_rows,
                cols: valid_cols,
                pixel_width: 0,
                pixel_height: 0,
            });
        }
        Ok(())
    }

    /// Explicitly closes and cleans up a PTY session.
    pub fn close_pty(&self, id: &str) -> Result<(), TerminalError> {
        self.gate.forget(id);
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
            end_session(s);
            Ok(())
        } else {
            // Already closed or clean
            Ok(())
        }
    }

    /// Which of `ids` currently have a foreground command running (anything beyond
    /// an idle shell prompt). Used to ask before closing a tab, pane, or window
    /// that would kill running work. Unknown or exited ids and any platform
    /// failure count as NOT busy, so a question is never asked in error and
    /// closing is never blocked.
    pub fn busy_sessions(&self, ids: &[String]) -> Vec<String> {
        ids.iter()
            .filter(|id| self.session_is_busy(id))
            .cloned()
            .collect()
    }

    fn session_is_busy(&self, id: &str) -> bool {
        // Short lock: take what is needed, probe the OS afterwards.
        let (pid, master) = {
            let Ok(sessions) = self.sessions.lock() else {
                return false;
            };
            match sessions.get(id) {
                Some(s) if s.status == SessionStatus::Connected => (s.pid, Arc::clone(&s.master)),
                _ => return false,
            }
        };
        let Some(pid) = pid else {
            return false;
        };
        #[cfg(unix)]
        {
            let fg_group = master
                .lock()
                .ok()
                .and_then(|m| m.process_group_leader())
                .map(i64::from);
            foreground_job_running(pid, fg_group)
        }
        #[cfg(windows)]
        {
            let _ = master;
            windows_shell_has_running_child(pid)
        }
        #[cfg(not(any(unix, windows)))]
        {
            let _ = (pid, master);
            false
        }
    }

    /// Records which window shows session `id` (no-op for an unknown id).
    ///
    /// The event route moves with it. A hand-off holds the session's events in the
    /// gate until `handoff_finish`, so switching the owner first means everything
    /// released afterwards (and all live output from then on) reaches this window.
    pub fn set_owner(&self, id: &str, owner: &str) {
        if let Ok(mut sessions) = self.sessions.lock() {
            if let Some(session) = sessions.get_mut(id) {
                if session.owner != owner {
                    // New window, clean slate: the old one cannot acknowledge any more.
                    session.flow.reset();
                }
                session.owner = owner.to_string();
                self.routes.set(id, owner);
            }
        }
    }

    /// Ends every session shown by window `owner` (it was closed). Returns how many.
    pub fn close_sessions_owned_by(&self, owner: &str) -> usize {
        let ids: Vec<String> = match self.sessions.lock() {
            Ok(sessions) => sessions
                .values()
                .filter(|s| s.owner == owner)
                .map(|s| s.id.clone())
                .collect(),
            Err(_) => return 0,
        };
        for id in &ids {
            let _ = self.close_pty(id);
        }
        ids.len()
    }

    /// First step of moving a tab to another window: from now on the output and exit
    /// of these sessions are held back until [`PtyManager::handoff_finish`]. Fails,
    /// holding nothing, if any session is gone.
    pub fn handoff_begin(&self, ids: &[String]) -> Result<(), TerminalError> {
        let sessions = self
            .sessions
            .lock()
            .map_err(|e| TerminalError::IoError(format!("Lock failure: {}", e)))?;
        if let Some(missing) = ids.iter().find(|id| !sessions.contains_key(*id)) {
            return Err(TerminalError::SessionNotFound(missing.clone()));
        }
        for id in ids {
            self.gate.begin(id);
        }
        Ok(())
    }

    /// Last step of a move (or a cancelled one): returns what the session produced
    /// meanwhile and resumes live events. Empty when nothing was held.
    pub fn handoff_finish(&self, id: &str) -> HandoffRelease {
        self.gate.release(id).unwrap_or_default()
    }

    /// Reaps all child process handles on application shutdown.
    pub fn close_all(&self) {
        let mut drained = if let Ok(mut sessions) = self.sessions.lock() {
            sessions.drain().collect::<Vec<_>>()
        } else {
            Vec::new()
        };
        let mut stragglers = Vec::new();
        for (_, mut session) in drained.drain(..) {
            stragglers.push(end_session(&mut session));
        }
        // The app is going away: nothing will be left to finish the job later, so a shell that
        // ignored SIGHUP is dealt with here, waiting at most the grace period for all of them.
        wait_then_kill_stragglers(stragglers);
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

/// Diagnostic hint appended to PTY spawn failure when running under Flatpak.
pub fn flatpak_failure_hint() -> &'static str {
    "(Flatpak host shell spawn failed. Verify that the Flatpak sandbox has '--talk-name=org.freedesktop.Flatpak' permission and that the requested host shell exists and is executable on the host)"
}

/// Composes a bash PROMPT_COMMAND that reports cwd via OSC 7 while preserving
/// any existing user PROMPT_COMMAND and avoiding duplicate injection of the hook.
pub fn bash_cwd_prompt_command(existing: Option<&str>) -> String {
    match existing {
        Some(t) if !t.trim().is_empty() => {
            let trimmed = t.trim();
            if trimmed.contains("__kai_osc7") {
                trimmed.to_string()
            } else {
                let stripped = trimmed.trim_end_matches(';');
                format!("{FLATPAK_BASH_CWD_HOOK}; {stripped}")
            }
        }
        _ => FLATPAK_BASH_CWD_HOOK.to_string(),
    }
}

/// Extra environment that lets the cwd badge follow `cd` in a Flatpak tab.
/// The host shell is invisible from the sandbox (no shared PID namespace, so no
/// `/proc/<pid>/cwd`), leaving shell-emitted `OSC 7` as the only source. Only
/// bash can be primed through the environment (`PROMPT_COMMAND`); it is
/// best-effort, since an rc file that assigns `PROMPT_COMMAND` replaces it.
/// Other shells report cwd only if they emit `OSC 7` themselves, and otherwise
/// the badge stays at the spawn directory.
fn flatpak_cwd_hook_env(shell_path: &str, existing_prompt: Option<&str>) -> Vec<(String, String)> {
    let name = shell_path.rsplit('/').next().unwrap_or(shell_path);
    if name == "bash" {
        vec![(
            FLATPAK_CWD_HOOK_VAR.to_string(),
            bash_cwd_prompt_command(existing_prompt),
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
/// `/C:/` unstripping). Returns `None` for non-file payloads, oversized inputs,
/// or strings containing NUL bytes / control characters.
fn parse_osc7_data(data: &[u8]) -> Option<String> {
    if data.len() > 4096 {
        return None;
    }
    let s = String::from_utf8_lossy(data);
    let s = s.trim();
    if s.is_empty() || s.contains('\0') {
        return None;
    }
    let without_scheme = s.strip_prefix("file://")?;
    // Split host from path at the first `/`.
    let idx = without_scheme.find('/')?;
    let host = &without_scheme[..idx];
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
    let trimmed = p.trim();
    if trimmed.is_empty()
        || trimmed.len() > 4096
        || trimmed.contains('\0')
        || trimmed.chars().any(|c| (c as u32) < 0x20)
    {
        return None;
    }
    // A report naming another machine (an `ssh` session, a `cat`ed file) describes a folder of
    // THAT machine, not one of ours: taking it would point the git panel and new tabs at a
    // local folder of the same name chosen by whatever printed it (SEC-12). A path that cannot
    // be a folder of this OS (a Linux path under Windows) cannot point at one either, and a WSL
    // shell reports under its own host name, so only native-looking paths need the check.
    if is_native_path(trimmed) && !osc7_host_is_local(host) {
        return None;
    }
    Some(trimmed.to_string())
}

/// Whether `path` is written the way this OS writes its own paths (a drive letter on Windows).
fn is_native_path(path: &str) -> bool {
    if cfg!(windows) {
        let b = path.as_bytes();
        b.len() >= 2 && b[1] == b':' && b[0].is_ascii_alphabetic()
    } else {
        true
    }
}

/// This machine's host name, looked up once (`None` when the OS will not say).
fn local_hostname() -> Option<&'static str> {
    static NAME: std::sync::OnceLock<Option<String>> = std::sync::OnceLock::new();
    NAME.get_or_init(|| {
        #[cfg(windows)]
        {
            std::env::var("COMPUTERNAME").ok()
        }
        #[cfg(unix)]
        {
            let mut buf = [0u8; 256];
            // SAFETY: `buf` is a valid, writable buffer of the length passed; gethostname
            // writes at most that many bytes and NUL-terminates unless it truncates.
            let rc = unsafe { libc::gethostname(buf.as_mut_ptr().cast(), buf.len()) };
            if rc != 0 {
                return None;
            }
            let end = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
            Some(String::from_utf8_lossy(&buf[..end]).into_owned())
        }
        #[cfg(not(any(windows, unix)))]
        {
            None
        }
    })
    .as_deref()
}

/// Whether the host part of an OSC 7 URL names this machine: empty, `localhost`, or the local
/// host name (case-insensitive, with or without a domain suffix such as `.local`).
fn osc7_host_is_local(host: &str) -> bool {
    host_names_this_machine(host, local_hostname())
}

fn host_names_this_machine(host: &str, local: Option<&str>) -> bool {
    let host = host.trim();
    if host.is_empty() || host.eq_ignore_ascii_case("localhost") {
        return true;
    }
    let first = |s: &str| s.split('.').next().unwrap_or(s).to_ascii_lowercase();
    match local {
        Some(local) if !local.is_empty() => first(host) == first(local),
        _ => false,
    }
}

/// A cwd report is applied only when it names a real folder, if it is a path of this OS. A
/// Windows-style path (`C:/x`) must exist; a path that cannot belong to this OS (a Linux path
/// from a WSL shell) cannot be checked here and is accepted as before.
fn osc_cwd_is_usable(cwd: &str) -> bool {
    !is_native_path(cwd) || std::path::Path::new(cwd).is_dir()
}

/// Parses OSC 9;9 payload bytes (literal Windows path, e.g. `C:\Users\x`).
/// Safely rejects oversized payloads, NUL bytes, and control characters.
fn parse_osc9_data(data: &[u8]) -> Option<String> {
    if data.len() > 4096 {
        return None;
    }
    let s = String::from_utf8_lossy(data);
    let p = s.trim();
    if p.is_empty() || p.len() > 4096 || p.contains('\0') || p.chars().any(|c| (c as u32) < 0x20) {
        None
    } else {
        Some(p.to_string())
    }
}

/// Scans raw PTY output bytes for completed OSC 7 / OSC 9;9 cwd reports and
/// returns each reported cwd in order. Handles BEL and ST (`ESC \`)
/// terminators. Incomplete trailing sequences are skipped (callers retain the
/// unconsumed tail — see [`OscCwdScanner`] — and prepend it to the next chunk).
pub fn extract_osc_cwds(chunk: &[u8]) -> Vec<String> {
    scan_osc_cwds(chunk).0
}

/// Like [`extract_osc_cwds`], and also returns how many leading bytes are
/// fully processed: they hold no report that a later chunk could still
/// complete, so the caller must not scan them again. Everything from that
/// offset on is the start of a possibly incomplete trailing sequence
/// (`ESC`, `ESC ]`, `ESC ] 9`, `ESC ] 9 ; 9`, `ESC ] 7 ; /partial/pa`, ...).
fn scan_osc_cwds(chunk: &[u8]) -> (Vec<String>, usize) {
    let mut out = Vec::new();
    let mut i = 0;
    // Offset where a not-yet-complete report starts, once the end of `chunk`
    // is reached before its terminator.
    let mut pending: Option<usize> = None;
    while i < chunk.len() {
        if chunk[i] != 0x1B {
            i += 1;
            continue;
        }
        if i + 1 >= chunk.len() {
            pending = Some(i); // lone ESC at the end
            break;
        }
        if chunk[i + 1] != 0x5D {
            i += 1;
            continue;
        }
        let mut j = i + 2;
        let num_start = j;
        while j < chunk.len() && chunk[j].is_ascii_digit() {
            j += 1;
        }
        if j >= chunk.len() {
            pending = Some(i); // `ESC ]` or `ESC ] 9` at the end
            break;
        }
        if j == num_start || chunk[j] != b';' {
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
                None => {
                    pending = Some(i); // incomplete tail: wait for more bytes
                    break;
                }
            }
        } else if id == 9 {
            // Windows Terminal convention: `OSC 9;9;<dir>`.
            if j >= chunk.len() || (chunk[j] == b'9' && j + 1 >= chunk.len()) {
                pending = Some(i); // `ESC ] 9 ;` / `ESC ] 9 ; 9` at the end
                break;
            }
            if chunk[j] == b'9' && chunk[j + 1] == b';' {
                j += 2;
                match find_osc_end(chunk, j) {
                    Some((end, next)) => {
                        if let Some(cwd) = parse_osc9_data(&chunk[j..end]) {
                            out.push(cwd);
                        }
                        i = next;
                        continue;
                    }
                    None => {
                        pending = Some(i);
                        break;
                    }
                }
            }
        }
        i += 1;
    }
    (out, pending.unwrap_or(chunk.len()))
}

/// Largest unconsumed tail [`OscCwdScanner`] keeps. A valid report is at most
/// ~4 KiB (`parse_osc7_data` rejects longer), so an unterminated sequence
/// beyond this is not a report and is discarded.
const OSC_SCAN_TAIL_MAX: usize = 8192;

/// Incremental OSC 7 / OSC 9;9 cwd-report scanner for the PTY reader thread.
///
/// Each report is returned exactly once: bytes already parsed are dropped, and
/// only an incomplete trailing sequence is carried to the next read. (The
/// previous implementation re-parsed the last 8 KiB on every read, so once
/// two different reports sat in that window — `cd a`, `cd b` — every later
/// read containing any ESC re-emitted `a` then `b`, ~100 events for 2 `cd`s.)
#[derive(Default)]
pub struct OscCwdScanner {
    tail: Vec<u8>,
}

impl OscCwdScanner {
    /// Feeds the next chunk of PTY output; returns the cwd reports completed by it.
    pub fn push(&mut self, chunk: &[u8]) -> Vec<String> {
        // Fast path: an OSC sequence always starts with ESC. Plain-text floods
        // (logs, `cat`, installs) have no ESC at all, so skip the scan.
        if self.tail.is_empty() && !chunk.contains(&0x1B) {
            return Vec::new();
        }
        self.tail.extend_from_slice(chunk);
        let (cwds, consumed) = scan_osc_cwds(&self.tail);
        self.tail.drain(..consumed);
        if self.tail.len() > OSC_SCAN_TAIL_MAX {
            self.tail.clear();
        }
        cwds
    }
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
/// Gather raw PTY reads into batches and hand each batch to `emit` as text.
/// Blocks for the first read after idle, then keeps collecting for at most
/// `window` (or until `MAX_OUTPUT_BATCH_BYTES`). An incomplete UTF-8 sequence
/// at the end of a batch waits for the next one. Returns once the sender is
/// dropped and everything received has been emitted.
fn coalesce_output(
    rx: std::sync::mpsc::Receiver<Vec<u8>>,
    window: std::time::Duration,
    mut emit: impl FnMut(String),
) {
    use std::sync::mpsc::RecvTimeoutError;
    let mut batch: Vec<u8> = Vec::with_capacity(MAX_OUTPUT_BATCH_BYTES);
    let mut closed = false;
    while !closed {
        match rx.recv() {
            Ok(chunk) => batch.extend_from_slice(&chunk),
            Err(_) => break,
        }
        let deadline = std::time::Instant::now() + window;
        while batch.len() < MAX_OUTPUT_BATCH_BYTES {
            let now = std::time::Instant::now();
            if now >= deadline {
                break;
            }
            match rx.recv_timeout(deadline - now) {
                Ok(chunk) => batch.extend_from_slice(&chunk),
                Err(RecvTimeoutError::Timeout) => break,
                Err(RecvTimeoutError::Disconnected) => {
                    closed = true;
                    break;
                }
            }
        }
        let text = split_valid_utf8(&mut batch);
        if !text.is_empty() {
            emit(text);
        }
    }
    if !batch.is_empty() {
        let text = String::from_utf8_lossy(&batch).to_string();
        if !text.is_empty() {
            emit(text);
        }
    }
}

/// Takes the decodable text out of `buf` and leaves a character that is split across two reads
/// (an incomplete sequence at the very end) for the next call. Bytes that can never be valid
/// become U+FFFD, exactly as a lossy conversion would do; a valid split character after such a
/// byte is still kept whole (it used to be converted too, so it came out as two U+FFFD) (REL-06).
/// One read, retried when a signal interrupts it. `Interrupted` is not the end of the stream;
/// treating it as one would silently stop the output while the shell keeps running (REL-05).
fn read_retrying<R: std::io::Read + ?Sized>(
    reader: &mut R,
    buf: &mut [u8],
) -> std::io::Result<usize> {
    loop {
        match reader.read(buf) {
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            other => return other,
        }
    }
}

fn split_valid_utf8(buf: &mut Vec<u8>) -> String {
    if buf.is_empty() {
        return String::new();
    }
    if std::str::from_utf8(buf).is_ok() {
        // Whole buffer is valid: move it out without copying.
        return String::from_utf8(std::mem::take(buf)).unwrap_or_default();
    }
    let mut out = String::with_capacity(buf.len());
    let mut pos = 0;
    while pos < buf.len() {
        match std::str::from_utf8(&buf[pos..]) {
            Ok(rest) => {
                out.push_str(rest);
                pos = buf.len();
            }
            Err(e) => {
                let valid_len = e.valid_up_to();
                // The prefix was just validated by `from_utf8`.
                out.push_str(&String::from_utf8_lossy(&buf[pos..pos + valid_len]));
                pos += valid_len;
                match e.error_len() {
                    Some(bad) => {
                        out.push('\u{FFFD}');
                        pos += bad;
                    }
                    // An incomplete sequence at the end: wait for the rest of it.
                    None => break,
                }
            }
        }
    }
    buf.drain(..pos);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_split_valid_utf8_keeps_a_split_character_after_an_invalid_byte() {
        // 0xFF can never be valid; "é" (C3 A9) arrives cut in two reads.
        let mut buf = vec![b'a', 0xFF, b'b', 0xC3];
        assert_eq!(split_valid_utf8(&mut buf), "a\u{FFFD}b");
        assert_eq!(
            buf,
            vec![0xC3],
            "the half character waits for its other half"
        );
        buf.push(0xA9);
        assert_eq!(split_valid_utf8(&mut buf), "é");
        assert!(buf.is_empty());
    }

    #[test]
    fn test_split_valid_utf8_matches_lossy_conversion_when_nothing_is_split() {
        for bytes in [
            &b"plain"[..],
            &[0xFF, 0xFE][..],
            &[b'x', 0xC3, b'y'][..], // a lead byte followed by a non-continuation
            &[0xE2, 0x82][..],       // incomplete at the end: kept, not converted
            &[0xF0, 0x9F, 0x98, 0x80][..],
        ] {
            let mut buf = bytes.to_vec();
            let got = split_valid_utf8(&mut buf);
            let tail = buf.clone();
            let mut whole = got.clone().into_bytes();
            whole.extend_from_slice(&tail);
            // Everything is accounted for: converted text plus the kept incomplete tail.
            assert_eq!(
                String::from_utf8_lossy(&whole).to_string(),
                String::from_utf8_lossy(bytes).to_string(),
                "input {bytes:?}"
            );
        }
    }

    #[test]
    fn test_read_retrying_does_not_treat_interrupted_as_the_end() {
        struct Flaky {
            interrupts_left: u32,
            data: &'static [u8],
        }
        impl std::io::Read for Flaky {
            fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
                if self.interrupts_left > 0 {
                    self.interrupts_left -= 1;
                    return Err(std::io::Error::from(std::io::ErrorKind::Interrupted));
                }
                let n = self.data.len().min(buf.len());
                buf[..n].copy_from_slice(&self.data[..n]);
                self.data = &self.data[n..];
                Ok(n)
            }
        }
        let mut reader = Flaky {
            interrupts_left: 3,
            data: b"output",
        };
        let mut buf = [0u8; 16];
        assert_eq!(read_retrying(&mut reader, &mut buf).unwrap(), 6);
        assert_eq!(&buf[..6], b"output");
        // A real error still ends the stream.
        struct Broken;
        impl std::io::Read for Broken {
            fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> {
                Err(std::io::Error::from(std::io::ErrorKind::BrokenPipe))
            }
        }
        assert!(read_retrying(&mut Broken, &mut buf).is_err());
    }

    #[test]
    fn test_remove_and_drop_reports_whether_the_entry_was_there() {
        let map: Mutex<HashMap<String, u8>> = Mutex::new(HashMap::new());
        map.lock().unwrap().insert("live".into(), 1);
        assert!(remove_and_drop_outside_lock(&map, "live"));
        // Already removed (an explicit close does that before killing the shell): not "ended by itself".
        assert!(!remove_and_drop_outside_lock(&map, "live"));
    }

    #[test]
    fn coalesce_output_merges_bursts_and_flushes_on_close() {
        let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();
        for part in [&b"hel"[..], b"lo ", b"wor", b"ld"] {
            tx.send(part.to_vec()).unwrap();
        }
        // A multi-byte character split across reads, then close.
        let accented = "é".as_bytes().to_vec();
        tx.send(vec![accented[0]]).unwrap();
        tx.send(vec![accented[1]]).unwrap();
        drop(tx);
        let mut out = Vec::new();
        coalesce_output(rx, std::time::Duration::from_millis(50), |t| out.push(t));
        assert_eq!(out.concat(), "hello worldé");
        assert_eq!(out.len(), 1, "one burst becomes one event: {:?}", out);
    }

    #[test]
    fn coalesce_output_emits_after_the_window_without_waiting_for_close() {
        let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();
        let (seen_tx, seen_rx) = std::sync::mpsc::channel::<String>();
        let worker = std::thread::spawn(move || {
            coalesce_output(rx, std::time::Duration::from_millis(5), |t| {
                let _ = seen_tx.send(t);
            });
        });
        tx.send(b"$ ".to_vec()).unwrap();
        let first = seen_rx
            .recv_timeout(std::time::Duration::from_secs(2))
            .expect("echo is emitted while the session stays open");
        assert_eq!(first, "$ ");
        drop(tx);
        worker.join().unwrap();
    }
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

    fn out(id: &str, data: &str) -> PtyOutputPayload {
        PtyOutputPayload {
            id: id.to_string(),
            data: data.to_string(),
        }
    }

    #[test]
    fn handoff_gate_holds_in_order_then_resumes_live_events() {
        let gate = HandoffGate::default();
        // Nothing is held until a move begins.
        assert!(gate.hold_output(out("a", "live")).is_some());

        gate.begin("a");
        assert!(gate.is_held("a"));
        assert!(gate.hold_output(out("a", "one ")).is_none());
        // Other sessions are never touched.
        assert!(gate.hold_output(out("b", "other")).is_some());
        assert!(gate.hold_output(out("a", "two")).is_none());
        assert!(gate
            .hold_exit(PtyExitPayload {
                id: "a".into(),
                exit_code: Some(3),
            })
            .is_none());

        let released = gate.release("a").expect("was held");
        assert_eq!(released.data, vec!["one ".to_string(), "two".to_string()]);
        assert!(released.exited);
        assert_eq!(released.exit_code, Some(3));

        // Released: events flow again, and a second release has nothing.
        assert!(!gate.is_held("a"));
        assert!(gate.hold_output(out("a", "after")).is_some());
        assert!(gate.release("a").is_none());
    }

    #[test]
    fn handoff_gate_reports_no_exit_when_the_shell_kept_running() {
        let gate = HandoffGate::default();
        gate.begin("a");
        gate.hold_output(out("a", "x"));
        let released = gate.release("a").unwrap();
        assert!(!released.exited);
        assert_eq!(released.exit_code, None);
    }

    #[test]
    fn handoff_gate_keeps_the_newest_output_when_over_the_cap() {
        let gate = HandoffGate::default();
        gate.begin("a");
        let chunk = "x".repeat(MAX_HELD_BYTES / 2 + 1);
        gate.hold_output(out("a", &chunk));
        gate.hold_output(out("a", &chunk));
        gate.hold_output(out("a", "newest"));
        let released = gate.release("a").unwrap();
        assert_eq!(released.data.last().map(String::as_str), Some("newest"));
        let total: usize = released.data.iter().map(String::len).sum();
        assert!(total <= MAX_HELD_BYTES, "held {total} bytes");
    }

    #[test]
    fn handoff_begin_holds_nothing_when_a_session_is_gone() {
        let manager = PtyManager::new();
        let err = manager.handoff_begin(&["missing".to_string()]);
        assert!(matches!(err, Err(TerminalError::SessionNotFound(_))));
        assert!(!manager.gate.is_held("missing"));
        assert_eq!(manager.handoff_finish("missing"), HandoffRelease::default());
    }

    #[test]
    fn a_moved_session_holds_output_then_hands_it_over_and_belongs_to_its_new_window() {
        let _env = crate::test_support::lock_test_env();
        let manager = PtyManager::new();
        let logs = Arc::new(Mutex::new(Vec::new()));
        let emitter = Arc::new(TestEventEmitter {
            output_received: logs.clone(),
            exit_received: Arc::new(AtomicBool::new(false)),
        });
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
            .expect("create session");
        manager.set_owner(&info.id, "term-7");

        manager
            .handoff_begin(std::slice::from_ref(&info.id))
            .expect("begin");
        // Let whatever the shell printed on start-up arrive; it was emitted before the hold.
        std::thread::sleep(std::time::Duration::from_millis(1500));
        let before = logs.lock().unwrap().join("");

        #[cfg(not(target_os = "windows"))]
        let cmd = "echo HANDOFF_MARK_42\n";
        #[cfg(target_os = "windows")]
        let cmd = "echo HANDOFF_MARK_42\r\n";
        manager.write_to_pty(&info.id, cmd).expect("write");

        let held_has_marker = || {
            manager
                .gate
                .held
                .lock()
                .unwrap()
                .get(&info.id)
                .is_some_and(|s| s.chunks.iter().any(|c| c.contains("HANDOFF_MARK_42")))
        };
        let mut seen = false;
        for _ in 0..80 {
            if held_has_marker() {
                seen = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        assert!(seen, "output produced during the move is held");
        let during = logs.lock().unwrap().join("");
        assert_eq!(during, before, "nothing is emitted while the move is open");

        let released = manager.handoff_finish(&info.id);
        assert!(released.data.concat().contains("HANDOFF_MARK_42"));
        assert!(!released.exited);

        // Live again: the next command reaches the emitter.
        #[cfg(not(target_os = "windows"))]
        let cmd = "echo HANDOFF_LIVE_43\n";
        #[cfg(target_os = "windows")]
        let cmd = "echo HANDOFF_LIVE_43\r\n";
        manager.write_to_pty(&info.id, cmd).expect("write");
        let mut live = false;
        for _ in 0..80 {
            if logs.lock().unwrap().join("").contains("HANDOFF_LIVE_43") {
                live = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        assert!(live, "events flow live after the move");

        // Closing the window that owns it ends it; another window's sessions are untouched.
        assert_eq!(manager.close_sessions_owned_by("term-1"), 0);
        assert_eq!(manager.list_sessions().len(), 1);
        assert_eq!(manager.close_sessions_owned_by("term-7"), 1);
        assert!(manager.list_sessions().is_empty());
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
            let env = flatpak_cwd_hook_env(bash, None);
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
            assert!(flatpak_cwd_hook_env(other, None).is_empty(), "{other}");
        }
    }

    #[test]
    fn test_bash_cwd_prompt_command_preserves_and_avoids_duplicate() {
        // None or empty produces just the Kai hook
        let hook_only = bash_cwd_prompt_command(None);
        assert!(hook_only.starts_with("__kai_osc7(){"));
        assert!(hook_only.ends_with("__kai_osc7"));

        // Preserves user's existing PROMPT_COMMAND
        let chained = bash_cwd_prompt_command(Some("history -a"));
        assert!(chained.contains("__kai_osc7"));
        assert!(chained.contains("history -a"));

        // Strips trailing semicolon before appending
        let chained_semi = bash_cwd_prompt_command(Some("history -a;"));
        assert!(chained_semi.contains("history -a"));
        assert!(!chained_semi.ends_with(";;"));

        // Avoids injecting duplicate if already hooked
        let already = format!("{hook_only}; echo prompt");
        let deduped = bash_cwd_prompt_command(Some(&already));
        assert_eq!(deduped, already);
    }

    #[test]
    fn test_flatpak_cwd_hook_is_forwarded_to_the_host_as_an_env_flag() {
        let env = flatpak_cwd_hook_env("/bin/bash", None);
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
    fn test_parse_osc7_and_osc9_data_hardening() {
        // Valid OSC 7 with spaces and Unicode
        let valid_osc7 = b"file://localhost/home/user/my%20projects/%C3%A9cole";
        assert_eq!(
            parse_osc7_data(valid_osc7).as_deref(),
            Some("/home/user/my projects/école")
        );

        // NUL byte injection in OSC 7 is rejected
        let nul_osc7 = b"file://localhost/home/user\0/bad";
        assert_eq!(parse_osc7_data(nul_osc7), None);

        // Control characters in OSC 7 are rejected
        let ctrl_osc7 = b"file://localhost/home/user\x01/bad";
        assert_eq!(parse_osc7_data(ctrl_osc7), None);

        // Oversized OSC 7 rejected
        let big_osc7 = format!("file://localhost/{}", "a".repeat(4500));
        assert_eq!(parse_osc7_data(big_osc7.as_bytes()), None);

        // Valid OSC 9;9 path
        let valid_osc9 = b"C:\\Users\\user\\projects";
        assert_eq!(
            parse_osc9_data(valid_osc9).as_deref(),
            Some("C:\\Users\\user\\projects")
        );

        // NUL byte injection in OSC 9;9 is rejected
        let nul_osc9 = b"C:\\Users\\user\0\\projects";
        assert_eq!(parse_osc9_data(nul_osc9), None);

        // Control characters in OSC 9;9 are rejected
        let ctrl_osc9 = b"C:\\Users\\user\x1b\\projects";
        assert_eq!(parse_osc9_data(ctrl_osc9), None);

        // Flatpak failure hint provides guidance
        let hint = flatpak_failure_hint();
        assert!(hint.contains("org.freedesktop.Flatpak"));
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
        let seq = b"\x1b]7;file://localhost/home/kai/my%20proj\x07";
        assert_eq!(extract_osc_cwds(seq), vec!["/home/kai/my proj"]);
        // Windows drive-letter URL unstripped like the frontend handler.
        let win = b"\x1b]7;file:///C%3A/Users/kai\x1b\\";
        assert_eq!(extract_osc_cwds(win), vec!["C:/Users/kai"]);
        // Non-file payloads are ignored.
        let other = b"\x1b]7;https://example.com/x\x07";
        assert!(extract_osc_cwds(other).is_empty());
    }

    #[test]
    fn test_osc7_from_another_machine_is_ignored() {
        let _env = crate::test_support::lock_test_env();
        // An ssh session, or a file printed with `cat`, reports ITS folders under ITS host name.
        let other_win = b"\x1b]7;file://some-other-pc/C%3A/Windows\x07";
        let other_unix = b"\x1b]7;file://build-server.example.com/home/kai/proj\x07";
        if cfg!(windows) {
            assert!(extract_osc_cwds(other_win).is_empty());
            // A Linux path cannot name a local Windows folder, and a WSL shell reports under its
            // own host name: that keeps working.
            assert_eq!(extract_osc_cwds(other_unix), vec!["/home/kai/proj"]);
        } else {
            assert!(extract_osc_cwds(other_unix).is_empty());
        }
        // Empty host, `localhost` and this machine's own name are local.
        assert_eq!(
            extract_osc_cwds(b"\x1b]7;file:///home/kai/p\x07"),
            vec!["/home/kai/p"]
        );
        assert_eq!(
            extract_osc_cwds(b"\x1b]7;file://LOCALHOST/home/kai/p\x07"),
            vec!["/home/kai/p"]
        );
        if let Some(me) = local_hostname() {
            let seq = format!("\x1b]7;file://{me}/home/kai/p\x07");
            assert_eq!(
                extract_osc_cwds(seq.as_bytes()),
                vec!["/home/kai/p"],
                "own host {me}"
            );
        }
    }

    #[test]
    fn test_host_matching_rules() {
        assert!(host_names_this_machine("", Some("Dev-PC")));
        assert!(host_names_this_machine(" localhost ", None));
        assert!(host_names_this_machine("dev-pc", Some("DEV-PC")));
        // A domain suffix on either side does not matter ...
        assert!(host_names_this_machine("dev-pc.local", Some("dev-pc")));
        assert!(host_names_this_machine(
            "dev-pc",
            Some("dev-pc.corp.example")
        ));
        // ... a different machine does, and an unknown local name trusts nobody but localhost.
        assert!(!host_names_this_machine("dev-pc2", Some("dev-pc")));
        assert!(!host_names_this_machine(
            "evil.dev-pc.example",
            Some("dev-pc")
        ));
        assert!(!host_names_this_machine("dev-pc", None));
    }

    #[test]
    fn test_osc_cwd_must_name_a_real_folder_for_native_paths() {
        let dir = std::env::temp_dir();
        assert!(osc_cwd_is_usable(&dir.to_string_lossy()));
        let missing = dir.join("kai-definitely-not-a-folder-4f2a");
        assert!(!osc_cwd_is_usable(&missing.to_string_lossy()));
        // A file is not a folder.
        let file = dir.join(format!("kai-osc-cwd-file-{}", std::process::id()));
        std::fs::write(&file, b"x").unwrap();
        assert!(!osc_cwd_is_usable(&file.to_string_lossy()));
        let _ = std::fs::remove_file(&file);
        // A path that cannot belong to this OS (a WSL shell's Linux path) cannot be checked.
        if cfg!(windows) {
            assert!(osc_cwd_is_usable("/home/kai/proj"));
        }
    }

    #[test]
    fn test_extract_osc_split_across_chunks() {
        let _env = crate::test_support::lock_test_env();
        // A sequence split across 4 KB reads yields nothing until complete;
        // the caller's retained tail + remainder then parses (mirrors the
        // reader thread's `OscCwdScanner` behavior).
        let part1 = b"\x1b]9;9;C:\\Users\\k";
        let part2 = b"ai\x07";
        assert!(extract_osc_cwds(part1).is_empty());
        let mut rejoined = part1.to_vec();
        rejoined.extend_from_slice(part2);
        assert_eq!(extract_osc_cwds(&rejoined), vec!["C:\\Users\\kai"]);
    }

    #[test]
    fn test_busy_detection_helpers() {
        // Console helpers never count as user work (case-insensitive).
        assert!(is_console_helper_process("conhost.exe"));
        assert!(is_console_helper_process("OpenConsole.exe"));
        assert!(is_console_helper_process("WSLHOST.EXE"));
        assert!(!is_console_helper_process("ping.exe"));
        assert!(!is_console_helper_process("cargo.exe"));
        // Unix: the shell owning the foreground group is idle; any other group is a job.
        assert!(!foreground_job_running(100, Some(100)));
        assert!(foreground_job_running(100, Some(2500)));
        assert!(!foreground_job_running(100, None), "unknown is not busy");
        assert!(!foreground_job_running(100, Some(0)));
        assert!(!foreground_job_running(100, Some(-1)));
    }

    #[test]
    fn test_busy_sessions_ignores_unknown_ids() {
        let manager = PtyManager::new();
        assert!(manager
            .busy_sessions(&["nope".to_string(), String::new()])
            .is_empty());
    }

    #[test]
    fn test_event_routes_follow_ownership_and_are_forgotten_when_the_session_ends() {
        let manager = PtyManager::new();
        let routes = manager.routes();
        let info = manager
            .create_pty(
                Arc::new(NoopEventEmitter),
                PtyCreateOptions {
                    shell_path: None,
                    args: None,
                    cwd: None,
                    cols: 80,
                    rows: 24,
                    env: None,
                },
            )
            .expect("create session");

        // An id that is not a live session never gets a route.
        manager.set_owner("no-such-session", "term-9");
        assert_eq!(routes.owner_of("no-such-session"), None);

        manager.set_owner(&info.id, "term-7");
        assert_eq!(routes.owner_of(&info.id).as_deref(), Some("term-7"));
        // A rolled-back move hands it back to the old window.
        manager.set_owner(&info.id, "main");
        assert_eq!(routes.owner_of(&info.id).as_deref(), Some("main"));

        manager.close_pty(&info.id).expect("close");
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while routes.owner_of(&info.id).is_some() && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        assert_eq!(
            routes.owner_of(&info.id),
            None,
            "a finished session's route must be removed once its exit has been emitted"
        );
    }

    #[test]
    fn test_flow_control_does_not_wait_below_the_high_water_mark() {
        let flow = FlowControl::new(1000, 200);
        flow.add(999);
        let started = std::time::Instant::now();
        flow.wait_for_credit(); // below high: returns at once
        assert!(started.elapsed() < std::time::Duration::from_millis(200));
        assert_eq!(flow.in_flight(), 999);
    }

    #[test]
    fn test_flow_control_pauses_at_high_and_resumes_only_at_low() {
        let flow = Arc::new(FlowControl::new(1000, 200));
        flow.add(1000); // at the high-water mark
        let resumed = Arc::new(AtomicBool::new(false));
        let waiter = {
            let (flow, resumed) = (flow.clone(), resumed.clone());
            std::thread::spawn(move || {
                flow.wait_for_credit();
                resumed.store(true, Ordering::SeqCst);
            })
        };
        std::thread::sleep(std::time::Duration::from_millis(150));
        assert!(
            !resumed.load(Ordering::SeqCst),
            "must wait at the high mark"
        );
        // Acknowledged down to 500: below high but still above low, so it keeps waiting.
        flow.ack(500);
        std::thread::sleep(std::time::Duration::from_millis(150));
        assert!(
            !resumed.load(Ordering::SeqCst),
            "hysteresis: resume only at the low mark"
        );
        flow.ack(300); // 200 left: at the low-water mark
        waiter.join().unwrap();
        assert!(resumed.load(Ordering::SeqCst));
        assert_eq!(flow.in_flight(), 200);
    }

    #[test]
    fn test_flow_control_close_releases_the_waiter_and_stays_released() {
        let flow = Arc::new(FlowControl::new(100, 10));
        flow.add(10_000);
        let waiter = {
            let flow = flow.clone();
            std::thread::spawn(move || flow.wait_for_credit())
        };
        std::thread::sleep(std::time::Duration::from_millis(100));
        flow.close(); // the session ended: nothing may wait for the frontend any more
        waiter.join().unwrap();
        let started = std::time::Instant::now();
        flow.wait_for_credit(); // and later waits return immediately too
        assert!(started.elapsed() < std::time::Duration::from_millis(200));
    }

    #[test]
    fn test_flow_control_ack_beyond_in_flight_is_harmless() {
        let flow = FlowControl::new(100, 10);
        flow.add(50);
        flow.ack(80); // more than was emitted (e.g. late or duplicate acknowledgement)
        assert_eq!(flow.in_flight(), 0);
        flow.ack(u64::MAX);
        assert_eq!(flow.in_flight(), 0);
        flow.add(u64::MAX);
        flow.add(10); // saturates instead of overflowing
        assert_eq!(flow.in_flight(), u64::MAX);
    }

    #[test]
    fn test_flow_control_low_water_is_never_above_high() {
        let flow = Arc::new(FlowControl::new(100, 5_000)); // misconfigured
        flow.add(100);
        let waiter = {
            let flow = flow.clone();
            std::thread::spawn(move || flow.wait_for_credit())
        };
        flow.ack(1);
        waiter.join().unwrap(); // would hang forever if low > high were honoured
    }

    #[test]
    fn test_flow_control_gives_back_credit_that_never_gets_acknowledged() {
        // Lost credit (output sent to a window that vanished) must never freeze a terminal.
        let flow =
            FlowControl::new(100, 10).with_stall_timeout(std::time::Duration::from_millis(150));
        flow.add(500);
        let started = std::time::Instant::now();
        flow.wait_for_credit();
        assert!(started.elapsed() >= std::time::Duration::from_millis(140));
        assert!(started.elapsed() < std::time::Duration::from_secs(5));
        assert_eq!(flow.in_flight(), 0);
    }

    #[test]
    fn test_flow_control_slow_but_progressing_consumer_is_never_reset() {
        let flow = Arc::new(
            FlowControl::new(1000, 100).with_stall_timeout(std::time::Duration::from_millis(400)),
        );
        flow.add(1000);
        let waiter = {
            let flow = flow.clone();
            std::thread::spawn(move || flow.wait_for_credit())
        };
        // Acknowledges a little every 100 ms: slow, but alive, for longer than the timeout.
        for _ in 0..9 {
            std::thread::sleep(std::time::Duration::from_millis(100));
            flow.ack(100);
        }
        waiter.join().unwrap();
        assert_eq!(
            flow.in_flight(),
            100,
            "credit is counted exactly, not reset"
        );
    }

    #[test]
    fn test_flow_control_reset_frees_a_waiter() {
        let flow = Arc::new(FlowControl::new(100, 10));
        flow.add(10_000);
        let waiter = {
            let flow = flow.clone();
            std::thread::spawn(move || flow.wait_for_credit())
        };
        std::thread::sleep(std::time::Duration::from_millis(100));
        flow.reset();
        waiter.join().unwrap();
        assert_eq!(flow.in_flight(), 0);
    }

    #[test]
    fn test_changing_a_sessions_window_resets_its_output_credit() {
        let manager = PtyManager::new();
        let info = manager
            .create_pty(
                Arc::new(NoopEventEmitter),
                PtyCreateOptions {
                    shell_path: None,
                    args: None,
                    cwd: None,
                    cols: 80,
                    rows: 24,
                    env: None,
                },
            )
            .expect("create session");
        let flow = manager.sessions.lock().unwrap()[&info.id].flow.clone();
        manager.set_owner(&info.id, "main");
        flow.add(900_000); // sent to "main", not yet acknowledged
        manager.set_owner(&info.id, "main");
        assert_eq!(flow.in_flight(), 900_000, "same window: nothing changes");
        // The tab moves: "main" will never acknowledge what it was sent.
        manager.set_owner(&info.id, "term-2");
        assert_eq!(flow.in_flight(), 0);
        manager.close_pty(&info.id).unwrap();
    }

    fn osc9(path: &str) -> Vec<u8> {
        format!("\x1b]9;9;{path}\x07").into_bytes()
    }

    #[test]
    fn test_osc_scanner_reports_each_cwd_once_across_reads() {
        // The audit probe: `cd a`, `cd b`, then coloured output. The old
        // 8 KiB re-scan emitted a, b, a, b, ... on every ESC-bearing read.
        let mut scanner = OscCwdScanner::default();
        let mut all = Vec::new();
        all.extend(scanner.push(&osc9("C:/a")));
        let mut read2 = osc9("C:/b");
        read2.extend_from_slice(b"\x1b[32mgreen\x1b[0m");
        all.extend(scanner.push(&read2));
        for _ in 0..50 {
            all.extend(scanner.push(b"\x1b[31mred\x1b[0m output line\r\n"));
        }
        assert_eq!(all, vec!["C:/a", "C:/b"]);
    }

    #[test]
    fn test_osc_scanner_reassembles_reports_split_at_every_byte() {
        let mut stream = Vec::new();
        stream.extend_from_slice(b"prompt \x1b[1m> \x1b[0m");
        stream.extend(osc9(r"C:\Users\kai"));
        stream.extend_from_slice(b"\x1b]7;file:///C%3A/proj\x1b\\");
        stream.extend_from_slice(b"tail\x1b");
        for cut in 0..=stream.len() {
            let mut scanner = OscCwdScanner::default();
            let mut got = scanner.push(&stream[..cut]);
            got.extend(scanner.push(&stream[cut..]));
            assert_eq!(
                got,
                vec![r"C:\Users\kai", "C:/proj"],
                "split at byte {cut} must neither lose nor duplicate a report"
            );
        }
    }

    #[test]
    fn test_osc_scanner_byte_at_a_time_matches_one_shot() {
        let mut stream = Vec::new();
        for dir in ["C:/one", "C:/two", "C:/one"] {
            stream.extend_from_slice(b"\x1b[0m");
            stream.extend(osc9(dir));
        }
        let mut scanner = OscCwdScanner::default();
        let mut got = Vec::new();
        for b in &stream {
            got.extend(scanner.push(std::slice::from_ref(b)));
        }
        assert_eq!(got, vec!["C:/one", "C:/two", "C:/one"]);
    }

    #[test]
    fn test_osc_scanner_bounds_an_unterminated_sequence() {
        let mut scanner = OscCwdScanner::default();
        scanner.push(b"\x1b]7;file://h/");
        for _ in 0..64 {
            assert!(scanner.push(&[b'a'; 1024]).is_empty());
        }
        assert!(
            scanner.tail.len() <= OSC_SCAN_TAIL_MAX,
            "an unterminated report must not grow without bound"
        );
        // It recovers for the next well-formed report.
        let mut scanner = OscCwdScanner::default();
        scanner.push(&[b'a'; 10]);
        assert_eq!(scanner.push(&osc9("C:/ok")), vec!["C:/ok"]);
    }

    #[test]
    fn test_osc_scanner_ignores_plain_text_floods() {
        let mut scanner = OscCwdScanner::default();
        for _ in 0..100 {
            assert!(scanner.push(&[b'x'; 32768]).is_empty());
        }
        assert!(scanner.tail.is_empty());
    }

    /// A session whose `Drop` records whether the shared map lock was free —
    /// standing in for a PTY master whose drop (`ClosePseudoConsole`) can block
    /// until the reader thread, which needs that same lock, drains.
    struct LockProbe {
        map: std::sync::Weak<Mutex<HashMap<String, LockProbe>>>,
        lock_was_free_on_drop: Arc<std::sync::atomic::AtomicBool>,
    }

    impl Drop for LockProbe {
        fn drop(&mut self) {
            if let Some(map) = self.map.upgrade() {
                self.lock_was_free_on_drop
                    .store(map.try_lock().is_ok(), std::sync::atomic::Ordering::SeqCst);
            }
        }
    }

    #[test]
    fn test_session_is_dropped_after_sessions_lock_is_released() {
        let map: Arc<Mutex<HashMap<String, LockProbe>>> = Arc::new(Mutex::new(HashMap::new()));
        let free = Arc::new(std::sync::atomic::AtomicBool::new(false));
        map.lock().unwrap().insert(
            "a".to_string(),
            LockProbe {
                map: Arc::downgrade(&map),
                lock_was_free_on_drop: free.clone(),
            },
        );

        remove_and_drop_outside_lock(&map, "a");

        assert!(
            free.load(std::sync::atomic::Ordering::SeqCst),
            "the session must be dropped with the sessions lock released"
        );
        assert!(map.lock().unwrap().is_empty());
        // Unknown ids and repeated removal are harmless.
        remove_and_drop_outside_lock(&map, "a");
        remove_and_drop_outside_lock(&map, "missing");
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
