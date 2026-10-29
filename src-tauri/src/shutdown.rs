//! Bounded shutdown helpers. They use no Tauri types, so the timing logic is
//! unit-tested without the GUI.

use std::sync::mpsc;
use std::time::Duration;

/// Runs `work` on its own thread and waits at most `budget` for it. Returns
/// `true` when it finished in time.
///
/// A `work` that never finishes is left behind on purpose: the caller is about
/// to end the process, and waiting on it forever is exactly how a closing
/// window turns into a frozen "Not Responding" ghost. Closing a Windows
/// pseudo-console can block until its output is drained, so reaping terminal
/// children is not allowed to hold the app open.
pub fn finish_within<F>(budget: Duration, work: F) -> bool
where
    F: FnOnce() + Send + 'static,
{
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        work();
        let _ = tx.send(());
    });
    rx.recv_timeout(budget).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::time::Instant;

    #[test]
    fn reports_true_when_the_work_finishes_in_time() {
        let done = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&done);
        let finished = finish_within(Duration::from_secs(5), move || {
            flag.store(true, Ordering::SeqCst);
        });
        assert!(finished);
        assert!(done.load(Ordering::SeqCst));
    }

    #[test]
    fn gives_up_on_work_that_blocks_instead_of_waiting_for_it() {
        let started = Instant::now();
        let finished = finish_within(Duration::from_millis(100), || {
            std::thread::sleep(Duration::from_secs(30));
        });
        assert!(!finished);
        // It returned near the budget, nowhere near the 30 s the work wanted.
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn a_panicking_job_does_not_hang_the_caller() {
        let finished = finish_within(Duration::from_secs(5), || panic!("reaper failed"));
        assert!(!finished);
    }
}
