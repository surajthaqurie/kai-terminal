//! Several terminal windows in one app, the way an editor opens several windows.
//!
//! The first window is `main` (from the Tauri config); every other one is created
//! here as `term-<n>`. They share the one process, so the PTY manager, the Shared
//! Agent service, the music player and `~/.kai` state stay single and cannot collide.
//!
//! A window can start with a *seed*: the tab handed over when one is dragged out of
//! another window. The seed is opaque JSON owned by the frontend (title, colour,
//! layout, and for each pane the running session to adopt plus a snapshot of its
//! screen). It waits here until the new page asks for it, so nothing large travels
//! through a URL or `localStorage`.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;

/// Label of the window created from the Tauri config.
pub const MAIN_LABEL: &str = "main";
const TERMINAL_PREFIX: &str = "term-";
/// Upper bound on one seed (screen snapshots of a few panes are far below this).
const MAX_SEED_BYTES: usize = 32 * 1024 * 1024;

/// Whether `label` names a terminal window (as opposed to the music or chat window).
pub fn is_terminal_label(label: &str) -> bool {
    label == MAIN_LABEL
        || label
            .strip_prefix(TERMINAL_PREFIX)
            .is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
}

static NEXT_WINDOW: AtomicU32 = AtomicU32::new(2);

/// A fresh, never reused label for a new terminal window.
pub fn next_label() -> String {
    format!(
        "{TERMINAL_PREFIX}{}",
        NEXT_WINDOW.fetch_add(1, Ordering::Relaxed)
    )
}

/// Closing a terminal window ends the app only when it is the last one.
pub fn closing_ends_app(open_terminal_windows: usize) -> bool {
    open_terminal_windows <= 1
}

/// Tabs waiting for the window that will show them.
#[derive(Default)]
pub struct WindowSeeds(Mutex<HashMap<String, serde_json::Value>>);

impl WindowSeeds {
    pub fn put(&self, label: &str, seed: serde_json::Value) -> Result<(), String> {
        if seed.to_string().len() > MAX_SEED_BYTES {
            return Err("The tab is too large to move to a new window.".to_string());
        }
        self.0
            .lock()
            .map_err(|e| e.to_string())?
            .insert(label.to_string(), seed);
        Ok(())
    }

    /// Hands the seed over exactly once.
    pub fn take(&self, label: &str) -> Option<serde_json::Value> {
        self.0.lock().ok()?.remove(label)
    }

    pub fn discard(&self, label: &str) {
        let _ = self.take(label);
    }
}

/// Tabs handed to a window that is already open (dragged onto it, or merged into
/// it). Unlike a seed, a window can receive any number of these over its life.
#[derive(Default)]
pub struct IncomingTabs(Mutex<HashMap<String, Vec<serde_json::Value>>>);

impl IncomingTabs {
    pub fn push(&self, label: &str, seed: serde_json::Value) -> Result<(), String> {
        if seed.to_string().len() > MAX_SEED_BYTES {
            return Err("The tab is too large to move to another window.".to_string());
        }
        self.0
            .lock()
            .map_err(|e| e.to_string())?
            .entry(label.to_string())
            .or_default()
            .push(seed);
        Ok(())
    }

    /// Everything waiting for `label`, oldest first, handed over exactly once.
    pub fn take_all(&self, label: &str) -> Vec<serde_json::Value> {
        self.0
            .lock()
            .ok()
            .and_then(|mut m| m.remove(label))
            .unwrap_or_default()
    }

    pub fn discard(&self, label: &str) {
        let _ = self.take_all(label);
    }
}

/// A window's outer box in logical screen pixels.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ScreenRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl ScreenRect {
    pub fn contains(&self, px: f64, py: f64) -> bool {
        px.is_finite()
            && py.is_finite()
            && px >= self.x
            && py >= self.y
            && px < self.x + self.width
            && py < self.y + self.height
    }
}

/// The first window (in the given order) whose box holds the point, ignoring `except`.
pub fn window_at<'a>(
    windows: &'a [(String, ScreenRect)],
    except: &str,
    px: f64,
    py: f64,
) -> Option<&'a str> {
    windows
        .iter()
        .find(|(label, rect)| label != except && rect.contains(px, py))
        .map(|(label, _)| label.as_str())
}

#[cfg(feature = "tauri")]
pub use runtime::*;

#[cfg(feature = "tauri")]
mod runtime {
    use super::{
        is_terminal_label, next_label, window_at, IncomingTabs, ScreenRect, WindowSeeds, MAIN_LABEL,
    };
    use crate::error::TerminalError;
    use crate::pty::{HandoffRelease, PtyManager};
    use serde::Serialize;
    use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};

    /// How many terminal windows are open right now.
    pub fn terminal_window_count(app: &AppHandle) -> usize {
        app.webview_windows()
            .keys()
            .filter(|label| is_terminal_label(label))
            .count()
    }

    /// The window a background request (a second launch, a "bring the app back"
    /// action) should talk to: the focused terminal window, else `main`, else any.
    pub fn primary_terminal_window(app: &AppHandle) -> Option<WebviewWindow> {
        let mut terminals: Vec<(String, WebviewWindow)> = app
            .webview_windows()
            .into_iter()
            .filter(|(label, _)| is_terminal_label(label))
            .collect();
        terminals.sort_by(|a, b| a.0.cmp(&b.0));
        if let Some((_, w)) = terminals
            .iter()
            .find(|(_, w)| w.is_focused().unwrap_or(false))
        {
            return Some(w.clone());
        }
        if let Some((_, w)) = terminals.iter().find(|(l, _)| l == MAIN_LABEL) {
            return Some(w.clone());
        }
        terminals.into_iter().next().map(|(_, w)| w)
    }

    /// Sends an event to every terminal window (each shows the same shared state).
    pub fn emit_to_terminal_windows<S: Serialize + Clone>(
        app: &AppHandle,
        event: &str,
        payload: S,
    ) {
        for label in app.webview_windows().keys() {
            if is_terminal_label(label) {
                let _ = app.emit_to(label.as_str(), event, payload.clone());
            }
        }
    }

    /// Opens another terminal window and returns its label. `seed` is the tab it
    /// should show; `adopt` lists the running sessions that move into it (they
    /// belong to the new window from now on). `position` is where to put it, in
    /// logical pixels of the screen, when the user dropped a tab somewhere.
    pub fn open_window(
        app: &AppHandle,
        seed: Option<serde_json::Value>,
        adopt: &[String],
        position: Option<(f64, f64)>,
    ) -> Result<String, String> {
        let label = next_label();
        let seeds: State<'_, WindowSeeds> = app.state();
        if let Some(seed) = seed {
            seeds.put(&label, seed)?;
        }

        let builder = tauri::WebviewWindowBuilder::new(
            app,
            &label,
            // Same bundle as the main window; `main.tsx` tells the page it is a
            // secondary window.
            tauri::WebviewUrl::App("index.html?window=terminal".into()),
        )
        .title("Kai Terminal")
        .inner_size(1000.0, 650.0)
        .min_inner_size(400.0, 300.0)
        .resizable(true)
        .focused(true)
        .background_color(tauri::window::Color(12, 12, 12, 255));
        // Same chrome as the main window on each OS (see the tauri.*.conf.json files).
        #[cfg(target_os = "macos")]
        let builder = builder
            .decorations(true)
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true);
        #[cfg(not(target_os = "macos"))]
        let builder = builder.decorations(false);
        #[cfg(target_os = "linux")]
        let builder = builder.transparent(true);
        #[cfg(target_os = "windows")]
        let builder = match crate::webview2_browser_args() {
            Some(args) => builder.additional_browser_args(&args),
            None => builder,
        };
        let builder = match position {
            Some((x, y)) if x.is_finite() && y.is_finite() => builder.position(x, y),
            _ => builder,
        };

        let window = match builder.build() {
            Ok(window) => window,
            Err(e) => {
                seeds.discard(&label);
                return Err(e.to_string());
            }
        };
        // A window dropped somewhere no monitor shows would be unreachable.
        if position.is_some() && window.current_monitor().ok().flatten().is_none() {
            let _ = window.center();
        }

        let pty: State<'_, PtyManager> = app.state();
        for id in adopt {
            pty.set_owner(id, &label);
        }
        Ok(label)
    }

    /// Opens a terminal window, optionally with a tab moved into it. `async` because
    /// creating a window from a synchronous command can deadlock on Windows.
    #[tauri::command]
    pub async fn open_terminal_window(
        app_handle: AppHandle,
        seed: Option<serde_json::Value>,
        adopt: Option<Vec<String>>,
        x: Option<f64>,
        y: Option<f64>,
    ) -> Result<String, String> {
        let position = x.zip(y);
        open_window(&app_handle, seed, &adopt.unwrap_or_default(), position)
    }

    /// The tab this window was opened to show (once), or `None` for a plain new window.
    #[tauri::command]
    pub fn take_window_seed(
        window: WebviewWindow,
        seeds: State<'_, WindowSeeds>,
    ) -> Option<serde_json::Value> {
        seeds.take(window.label())
    }

    /// Event telling a window that tabs are waiting for it (`take_incoming_tabs`).
    pub const TAB_INCOMING_EVENT: &str = "kai-tab-incoming";
    /// Event asking a window to move all of its tabs into the window named in the payload.
    pub const MERGE_INTO_EVENT: &str = "kai-merge-into";

    /// The other terminal window under a point on the screen (logical pixels), if
    /// any: where a tab dragged out of `window` was dropped. Minimized and hidden
    /// windows do not count. The focused window wins when several overlap.
    #[tauri::command]
    pub fn terminal_window_at(window: WebviewWindow, x: f64, y: f64) -> Option<String> {
        let app = window.app_handle();
        let mut boxes: Vec<(bool, String, ScreenRect)> = app
            .webview_windows()
            .into_iter()
            .filter(|(label, _)| is_terminal_label(label) && label != window.label())
            .filter_map(|(label, w)| {
                if w.is_minimized().unwrap_or(false) || !w.is_visible().unwrap_or(true) {
                    return None;
                }
                let scale = w.scale_factor().ok()?;
                let pos = w.outer_position().ok()?.to_logical::<f64>(scale);
                let size = w.outer_size().ok()?.to_logical::<f64>(scale);
                let focused = w.is_focused().unwrap_or(false);
                let rect = ScreenRect {
                    x: pos.x,
                    y: pos.y,
                    width: size.width,
                    height: size.height,
                };
                Some((focused, label, rect))
            })
            .collect();
        boxes.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
        let boxes: Vec<(String, ScreenRect)> = boxes
            .into_iter()
            .map(|(_, label, rect)| (label, rect))
            .collect();
        window_at(&boxes, window.label(), x, y).map(str::to_string)
    }

    /// Hands a tab to another open terminal window. `adopt` lists the running
    /// sessions that move with it; they belong to `target` from now on. The target
    /// is told, brought to the front, and collects the tab with `take_incoming_tabs`.
    #[tauri::command(async)]
    pub fn send_tab_to_window(
        window: WebviewWindow,
        incoming: State<'_, IncomingTabs>,
        pty: State<'_, PtyManager>,
        target: String,
        seed: serde_json::Value,
        adopt: Option<Vec<String>>,
    ) -> Result<(), String> {
        if !is_terminal_label(&target) || target == window.label() {
            return Err("That is not another terminal window.".to_string());
        }
        let app = window.app_handle();
        let Some(dest) = app.get_webview_window(&target) else {
            return Err("That window is closed.".to_string());
        };
        incoming.push(&target, seed)?;
        for id in adopt.unwrap_or_default() {
            pty.set_owner(&id, &target);
        }
        let _ = app.emit_to(target.as_str(), TAB_INCOMING_EVENT, ());
        let _ = dest.unminimize();
        let _ = dest.set_focus();
        Ok(())
    }

    /// Tabs handed to this window since it last asked, oldest first.
    #[tauri::command]
    pub fn take_incoming_tabs(
        window: WebviewWindow,
        incoming: State<'_, IncomingTabs>,
    ) -> Vec<serde_json::Value> {
        incoming.take_all(window.label())
    }

    /// Asks every other terminal window to move its tabs into this one (each then
    /// closes). Returns how many windows were asked.
    #[tauri::command]
    pub fn merge_terminal_windows(window: WebviewWindow) -> usize {
        let app = window.app_handle();
        let me = window.label().to_string();
        let mut asked = 0;
        for label in app.webview_windows().keys() {
            if is_terminal_label(label)
                && *label != me
                && app
                    .emit_to(label.as_str(), MERGE_INTO_EVENT, me.clone())
                    .is_ok()
            {
                asked += 1;
            }
        }
        asked
    }

    /// Starts holding back these sessions' output while their tab moves windows.
    #[tauri::command(async)]
    pub fn pty_handoff_begin(
        state: State<'_, PtyManager>,
        ids: Vec<String>,
    ) -> Result<(), TerminalError> {
        state.handoff_begin(&ids)
    }

    /// Ends the hold and returns what the session printed meanwhile.
    ///
    /// The calling window becomes the session's owner BEFORE the hold is released:
    /// the new window after a successful move, or the old one when a move is rolled
    /// back. Output released here and everything after it is routed to that window.
    #[tauri::command(async)]
    pub fn pty_handoff_finish(
        window: WebviewWindow,
        state: State<'_, PtyManager>,
        id: String,
    ) -> HandoffRelease {
        state.set_owner(&id, window.label());
        state.handoff_finish(&id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_main_and_numbered_term_labels_are_terminal_windows() {
        assert!(is_terminal_label("main"));
        assert!(is_terminal_label("term-2"));
        assert!(is_terminal_label("term-130"));
        for other in [
            "music-pip",
            "shared-chat",
            "term-",
            "term-x",
            "term-2a",
            "main2",
            "",
        ] {
            assert!(!is_terminal_label(other), "{other:?}");
        }
    }

    #[test]
    fn labels_are_unique_and_match_the_capability_glob() {
        let a = next_label();
        let b = next_label();
        assert_ne!(a, b);
        assert!(a.starts_with("term-") && is_terminal_label(&a));
    }

    #[test]
    fn only_the_last_terminal_window_ends_the_app() {
        assert!(closing_ends_app(1));
        assert!(closing_ends_app(0));
        assert!(!closing_ends_app(2));
    }

    #[test]
    fn a_seed_is_handed_over_exactly_once_and_only_to_its_window() {
        let seeds = WindowSeeds::default();
        seeds
            .put("term-2", serde_json::json!({ "title": "api" }))
            .unwrap();
        assert!(seeds.take("term-3").is_none());
        assert_eq!(seeds.take("term-2").unwrap()["title"], "api");
        assert!(seeds.take("term-2").is_none());
    }

    #[test]
    fn incoming_tabs_queue_per_window_and_are_taken_once() {
        let tabs = IncomingTabs::default();
        tabs.push("main", serde_json::json!({ "title": "a" }))
            .unwrap();
        tabs.push("main", serde_json::json!({ "title": "b" }))
            .unwrap();
        tabs.push("term-2", serde_json::json!({ "title": "c" }))
            .unwrap();
        let got = tabs.take_all("main");
        assert_eq!(got.len(), 2);
        assert_eq!(got[0]["title"], "a");
        assert_eq!(got[1]["title"], "b");
        assert!(tabs.take_all("main").is_empty());
        tabs.discard("term-2");
        assert!(tabs.take_all("term-2").is_empty());
    }

    #[test]
    fn a_drop_point_finds_the_other_window_under_it() {
        let rect = |x, y| ScreenRect {
            x,
            y,
            width: 800.0,
            height: 600.0,
        };
        let windows = vec![
            ("term-2".to_string(), rect(0.0, 0.0)),
            ("main".to_string(), rect(1000.0, 0.0)),
        ];
        assert_eq!(window_at(&windows, "term-2", 1200.0, 300.0), Some("main"));
        // Its own window never counts.
        assert_eq!(window_at(&windows, "term-2", 100.0, 100.0), None);
        assert_eq!(window_at(&windows, "main", 100.0, 100.0), Some("term-2"));
        // Between and outside the windows.
        assert_eq!(window_at(&windows, "term-2", 900.0, 100.0), None);
        assert_eq!(window_at(&windows, "term-2", 1200.0, 600.0), None);
        assert_eq!(window_at(&windows, "term-2", f64::NAN, 10.0), None);
    }

    #[test]
    fn a_discarded_seed_is_gone() {
        let seeds = WindowSeeds::default();
        seeds.put("term-4", serde_json::json!(1)).unwrap();
        seeds.discard("term-4");
        assert!(seeds.take("term-4").is_none());
    }
}
