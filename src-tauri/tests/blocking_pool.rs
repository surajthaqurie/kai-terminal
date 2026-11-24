//! Slow commands must not take async workers away from keystroke input (PERF-05).
//!
//! `write_to_pty`, `resize_pty` and `pty_ack` run on the async runtime's workers (one
//! per CPU). A command that blocks one of them for seconds (git on a big repository,
//! a clipboard read behind antivirus, an integration sign-in that waits for a browser)
//! delays every keystroke queued behind it, and as many as there are CPUs stop input
//! entirely. This measures how long a trivial task waits for a worker while EVERY worker
//! is busy with blocking work, for the old pattern and for `blocking::run`.
//!
//! cargo test --manifest-path src-tauri/Cargo.toml --test blocking_pool
#![cfg(feature = "tauri")]

use std::time::{Duration, Instant};

const STALL: Duration = Duration::from_millis(1500);

fn workers_to_saturate() -> usize {
    std::thread::available_parallelism().map_or(8, |n| n.get()) + 2
}

/// How long a trivial async task (a keystroke write, say) waits before it gets to run.
fn probe_latency() -> Duration {
    let (tx, rx) = std::sync::mpsc::channel();
    let started = Instant::now();
    tauri::async_runtime::spawn(async move {
        let _ = tx.send(started.elapsed());
    });
    rx.recv_timeout(Duration::from_secs(10))
        .expect("the probe task never ran")
}

#[test]
fn blocking_commands_leave_the_async_workers_free_for_input() {
    let n = workers_to_saturate();

    // Premise (what `#[tauri::command(async)] fn` does): a blocking body runs inline on a
    // worker, so with every worker busy a keystroke waits for one of them to finish.
    let (done_tx, done_rx) = std::sync::mpsc::channel::<()>();
    for _ in 0..n {
        let done = done_tx.clone();
        tauri::async_runtime::spawn(async move {
            std::thread::sleep(STALL); // e.g. `git status` on a stalled network drive
            let _ = done.send(());
        });
    }
    std::thread::sleep(Duration::from_millis(150)); // let them occupy the workers
    let starved = probe_latency();
    for _ in 0..n {
        done_rx.recv_timeout(Duration::from_secs(10)).unwrap();
    }
    assert!(
        starved >= Duration::from_millis(900),
        "premise: with every worker blocked, input waited only {starved:?}"
    );

    // The fix: the same blocking work through `blocking::run` runs on the blocking pool.
    let (done_tx, done_rx) = std::sync::mpsc::channel::<()>();
    for _ in 0..n {
        let done = done_tx.clone();
        tauri::async_runtime::spawn(async move {
            let _ = kai::blocking::run(|| std::thread::sleep(STALL)).await;
            let _ = done.send(());
        });
    }
    std::thread::sleep(Duration::from_millis(150));
    let free = probe_latency();
    for _ in 0..n {
        done_rx.recv_timeout(Duration::from_secs(10)).unwrap();
    }
    println!(
        "input latency with all workers busy: old pattern {starved:?}, blocking::run {free:?}"
    );
    assert!(
        free < Duration::from_millis(250),
        "input waited {free:?} behind blocking work even though it ran on the blocking pool"
    );
}

#[test]
fn the_helpers_pass_results_and_errors_through_unchanged() {
    use kai::error::TerminalError;
    tauri::async_runtime::block_on(async {
        assert_eq!(kai::blocking::run(|| 7).await, Ok(7));
        assert_eq!(
            kai::blocking::run_flat(|| Ok::<_, String>("ok")).await,
            Ok("ok")
        );
        assert_eq!(
            kai::blocking::run_flat(|| Err::<(), _>("git failed".to_string())).await,
            Err("git failed".to_string())
        );
        assert!(kai::blocking::run_terminal(|| Ok::<_, TerminalError>(1))
            .await
            .is_ok());
        let err = kai::blocking::run_terminal(|| Err::<(), _>(TerminalError::IoError("x".into())))
            .await
            .unwrap_err();
        assert!(err.to_string().contains('x'));
        // A task that panics is reported as an error, never as a crash of the caller.
        let panicked = kai::blocking::run(|| -> u8 { panic!("boom") }).await;
        assert!(panicked.unwrap_err().contains("background task failed"));
    });
}
