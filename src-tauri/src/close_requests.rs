//! Asking the page before a terminal window closes (FUNC-02).
//!
//! The title-bar close button and closing the last tab already ask before ending running
//! commands. Closing the window any other way (Alt+F4, the taskbar, the window menu) used to end
//! every shell at once without asking. The backend now holds that close back, tells the page, and
//! lets the page decide. The page might be unable to answer (still loading, crashed), and the
//! user must still be able to close the window then, so a close nobody answers goes ahead after a
//! short wait.
//!
//! This module is the bookkeeping only (no window types), so it can be tested without a GUI.

use std::collections::HashMap;
use std::sync::Mutex;

/// What to do with a close request for a window.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum Decision {
    /// Close now: the question was already put and nobody answered in time.
    Allow,
    /// Hold the close back and ask the page. The number identifies this question.
    Ask(u64),
    /// A question is already open for this window: hold the close back, do not ask again.
    AlreadyAsking,
}

struct Entry {
    question: u64,
    /// The page has acknowledged that it is handling the close.
    answered: bool,
    /// Nobody answered in time: the next close request goes through.
    approved: bool,
}

#[derive(Default)]
pub struct CloseRequests {
    inner: Mutex<(u64, HashMap<String, Entry>)>,
}

impl CloseRequests {
    /// A close was requested for `label`.
    pub fn on_close_requested(&self, label: &str) -> Decision {
        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let (counter, entries) = &mut *guard;
        match entries.get(label) {
            Some(entry) if entry.approved => {
                entries.remove(label);
                Decision::Allow
            }
            Some(entry) if !entry.answered => Decision::AlreadyAsking,
            _ => {
                *counter += 1;
                entries.insert(
                    label.to_string(),
                    Entry {
                        question: *counter,
                        answered: false,
                        approved: false,
                    },
                );
                Decision::Ask(*counter)
            }
        }
    }

    /// The page for `label` received the question and is dealing with it (it shows its own
    /// confirmation, or closes the window itself). The window is no longer held for a timeout.
    pub fn acknowledge(&self, label: &str) {
        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        guard.1.remove(label);
    }

    /// The wait for question `question` is over. When the page never acknowledged it, the close
    /// is approved (the next request for the window goes through) and `true` is returned.
    pub fn approve_if_unanswered(&self, label: &str, question: u64) -> bool {
        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        match guard.1.get_mut(label) {
            Some(entry) if entry.question == question && !entry.answered => {
                entry.approved = true;
                true
            }
            _ => false,
        }
    }

    /// The window is gone: forget it.
    pub fn forget(&self, label: &str) {
        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        guard.1.remove(label);
    }
}

/// How long a close waits for the page to acknowledge the question before it goes ahead.
pub const ANSWER_WAIT: std::time::Duration = std::time::Duration::from_millis(2500);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_first_request_asks_the_page() {
        let r = CloseRequests::default();
        assert!(matches!(r.on_close_requested("main"), Decision::Ask(_)));
    }

    #[test]
    fn a_second_request_while_waiting_does_not_ask_again() {
        let r = CloseRequests::default();
        assert!(matches!(r.on_close_requested("main"), Decision::Ask(_)));
        assert_eq!(r.on_close_requested("main"), Decision::AlreadyAsking);
        assert_eq!(r.on_close_requested("main"), Decision::AlreadyAsking);
    }

    #[test]
    fn an_acknowledged_question_frees_the_window_for_the_next_request() {
        let r = CloseRequests::default();
        assert!(matches!(r.on_close_requested("main"), Decision::Ask(_)));
        r.acknowledge("main");
        // The user cancelled in the page; pressing close again asks again.
        assert!(matches!(r.on_close_requested("main"), Decision::Ask(_)));
    }

    #[test]
    fn a_page_that_never_answers_cannot_trap_the_window() {
        let r = CloseRequests::default();
        let Decision::Ask(q) = r.on_close_requested("main") else {
            panic!("should ask");
        };
        assert!(r.approve_if_unanswered("main", q));
        // The close that follows goes through, exactly once.
        assert_eq!(r.on_close_requested("main"), Decision::Allow);
        assert!(matches!(r.on_close_requested("main"), Decision::Ask(_)));
    }

    #[test]
    fn a_late_timeout_does_not_approve_a_newer_question_or_an_answered_one() {
        let r = CloseRequests::default();
        let Decision::Ask(first) = r.on_close_requested("main") else {
            panic!("should ask");
        };
        r.acknowledge("main");
        // The old timer fires after the page answered: nothing to approve.
        assert!(!r.approve_if_unanswered("main", first));

        let Decision::Ask(second) = r.on_close_requested("main") else {
            panic!("should ask again");
        };
        assert_ne!(first, second);
        // The old timer must not close a window that is waiting on a newer question.
        assert!(!r.approve_if_unanswered("main", first));
        assert!(r.approve_if_unanswered("main", second));
    }

    #[test]
    fn windows_are_independent() {
        let r = CloseRequests::default();
        assert!(matches!(r.on_close_requested("main"), Decision::Ask(_)));
        assert!(matches!(r.on_close_requested("term-2"), Decision::Ask(_)));
        r.acknowledge("main");
        assert_eq!(r.on_close_requested("term-2"), Decision::AlreadyAsking);
        r.forget("term-2");
        assert!(matches!(r.on_close_requested("term-2"), Decision::Ask(_)));
    }
}
