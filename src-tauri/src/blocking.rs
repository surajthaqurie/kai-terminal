//! Runs blocking work on Tokio's blocking pool instead of an async worker (PERF-05).
//!
//! `#[tauri::command(async)]` on a plain `fn` does NOT move the body to a blocking
//! thread: it wraps the call in an async block, so the body runs inline on one of
//! the async runtime's few worker threads (one per CPU by default). Keystroke
//! writes, resizes and acknowledgements run on those same workers. A command that
//! blocks for long (`git` on a large or network repository, up to 8 s; a
//! `powershell Get-Clipboard`; version probes of AI CLIs; an integration sign-in that
//! waits minutes for a browser) therefore takes a worker away from every keystroke,
//! and as many such calls as there are CPUs stop all terminal input until one
//! finishes. Blocking work goes through these helpers, so the workers stay free for
//! the short commands that must never wait.
//!
//! The pool behind `spawn_blocking` is separate and grows on demand (Tokio caps it
//! at 512 threads), so a slow command only costs its own thread.

use crate::error::TerminalError;

/// Runs `work` on the blocking pool. `Err` only if the task itself failed (panicked).
pub async fn run<T: Send + 'static>(
    work: impl FnOnce() -> T + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| format!("background task failed: {e}"))
}

/// Like [`run`] for work that already returns `Result<_, String>`.
pub async fn run_flat<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    run(work).await.and_then(|result| result)
}

/// Like [`run`] for work that returns a [`TerminalError`] on failure.
pub async fn run_terminal<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, TerminalError> + Send + 'static,
) -> Result<T, TerminalError> {
    match run(work).await {
        Ok(result) => result,
        Err(message) => Err(TerminalError::IoError(message)),
    }
}
