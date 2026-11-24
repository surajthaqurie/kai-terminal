//! PTY events reach the window that shows the session, and only that window (PERF-04).
//!
//! Before, every `pty-output` / `pty-exit` / `pty-cwd` event was broadcast to every
//! window: with N terminal windows each one received, JSON-decoded and discarded
//! (N-1)/N of all terminal output. This drives the real `TauriEventEmitter` against
//! two windows in Tauri's mock runtime and counts what each one actually receives.
//!
//! cargo test --features gui-test --manifest-path src-tauri/Cargo.toml --test event_routing
#![cfg(feature = "gui-test")]

use kai::pty::{
    OwnerRoutes, PtyCwdPayload, PtyExitPayload, PtyOutputPayload, TauriEventEmitter,
    TerminalEventEmitter,
};
use std::sync::{Arc, Mutex};
use tauri::test::{mock_builder, MockRuntime};
use tauri::{App, Listener, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

/// Event payloads a window received, per event name.
#[derive(Default, Clone)]
struct Inbox {
    output: Arc<Mutex<Vec<String>>>,
    exit: Arc<Mutex<Vec<String>>>,
    cwd: Arc<Mutex<Vec<String>>>,
}

impl Inbox {
    fn counts(&self) -> (usize, usize, usize) {
        (
            self.output.lock().unwrap().len(),
            self.exit.lock().unwrap().len(),
            self.cwd.lock().unwrap().len(),
        )
    }
}

fn window(app: &App<MockRuntime>, label: &str) -> (WebviewWindow<MockRuntime>, Inbox) {
    let w = WebviewWindowBuilder::new(app, label, WebviewUrl::default())
        .build()
        .expect("create window");
    let inbox = Inbox::default();
    for (event, sink) in [
        ("pty-output", inbox.output.clone()),
        ("pty-exit", inbox.exit.clone()),
        ("pty-cwd", inbox.cwd.clone()),
    ] {
        w.listen(event, move |e| {
            sink.lock().unwrap().push(e.payload().to_string())
        });
    }
    (w, inbox)
}

fn app() -> App<MockRuntime> {
    mock_builder()
        .build(tauri::generate_context!())
        .expect("build the app")
}

fn emitter(
    app: &App<MockRuntime>,
    routes: &Arc<OwnerRoutes>,
    default_owner: &str,
) -> TauriEventEmitter<MockRuntime> {
    TauriEventEmitter {
        app_handle: app.handle().clone(),
        routes: routes.clone(),
        default_owner: default_owner.to_string(),
    }
}

fn output(id: &str, data: &str) -> PtyOutputPayload {
    PtyOutputPayload {
        id: id.to_string(),
        data: data.to_string(),
    }
}

#[test]
fn a_session_s_events_reach_only_its_window() {
    let app = app();
    let (_main, main_inbox) = window(&app, "main");
    let (_term2, term2_inbox) = window(&app, "term-2");
    let routes = Arc::new(OwnerRoutes::default());
    routes.set("session-a", "main");
    routes.set("session-b", "term-2");
    let e = emitter(&app, &routes, "main");

    for _ in 0..10 {
        e.emit_output(output("session-a", "to main"));
    }
    for _ in 0..3 {
        e.emit_output(output("session-b", "to term-2"));
    }
    e.emit_exit(PtyExitPayload {
        id: "session-b".into(),
        exit_code: Some(0),
    });
    e.emit_cwd(PtyCwdPayload {
        id: "session-a".into(),
        cwd: "/home/a".into(),
    });

    // An idle window receives zero unrelated PTY events; each gets exactly its own.
    assert_eq!(main_inbox.counts(), (10, 0, 1), "main");
    assert_eq!(term2_inbox.counts(), (3, 1, 0), "term-2");
    assert!(main_inbox
        .output
        .lock()
        .unwrap()
        .iter()
        .all(|p| p.contains("to main")));
}

#[test]
fn events_go_to_the_creating_window_until_a_route_exists() {
    let app = app();
    let (_main, main_inbox) = window(&app, "main");
    let (_term2, term2_inbox) = window(&app, "term-2");
    let routes = Arc::new(OwnerRoutes::default());
    // The first prompt can be emitted before `create_pty` has returned and recorded the owner.
    let e = emitter(&app, &routes, "term-2");

    e.emit_output(output("fresh", "first prompt"));

    assert_eq!(term2_inbox.counts().0, 1);
    assert_eq!(main_inbox.counts().0, 0);
}

#[test]
fn output_follows_a_session_that_moves_to_another_window() {
    let app = app();
    let (_main, main_inbox) = window(&app, "main");
    let (_term2, term2_inbox) = window(&app, "term-2");
    let routes = Arc::new(OwnerRoutes::default());
    routes.set("tab", "main");
    let e = emitter(&app, &routes, "main");

    e.emit_output(output("tab", "before the move"));
    routes.set("tab", "term-2"); // PtyManager::set_owner on hand-off
    e.emit_output(output("tab", "after the move"));
    routes.set("tab", "main"); // rolled back: the old window takes it again
    e.emit_output(output("tab", "after the rollback"));

    assert_eq!(
        *main_inbox.output.lock().unwrap(),
        vec![
            "{\"id\":\"tab\",\"data\":\"before the move\"}",
            "{\"id\":\"tab\",\"data\":\"after the rollback\"}"
        ]
    );
    assert_eq!(
        *term2_inbox.output.lock().unwrap(),
        vec!["{\"id\":\"tab\",\"data\":\"after the move\"}"]
    );
}

#[test]
fn a_window_that_closed_mid_stream_does_not_reroute_or_break_delivery() {
    let app = app();
    let (_main, main_inbox) = window(&app, "main");
    let (term2, _term2_inbox) = window(&app, "term-2");
    let routes = Arc::new(OwnerRoutes::default());
    routes.set("doomed", "term-2");
    let e = emitter(&app, &routes, "main");

    e.emit_output(output("doomed", "alive"));
    term2.destroy().unwrap();
    // Late output for a window that is gone: dropped, no panic, and NOT sent to main.
    for _ in 0..5 {
        e.emit_output(output("doomed", "late"));
    }
    e.emit_exit(PtyExitPayload {
        id: "doomed".into(),
        exit_code: Some(1),
    });

    assert_eq!(main_inbox.counts(), (0, 0, 0));
}

#[test]
fn finished_sessions_are_forgotten() {
    let routes = OwnerRoutes::default();
    assert!(routes.is_empty());
    routes.set("a", "main");
    routes.set("b", "term-2");
    assert_eq!(routes.owner_of("a").as_deref(), Some("main"));
    assert_eq!(routes.len(), 2);
    routes.remove("a");
    assert_eq!(routes.owner_of("a"), None);
    routes.remove("a"); // idempotent
    assert_eq!(routes.len(), 1);
}
