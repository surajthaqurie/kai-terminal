//! Windows 11 snap-layouts popup for the frameless window's maximize button.
//!
//! The popup only appears when Windows' hit test (`WM_NCHITTEST`) reports the
//! pointer is over a native maximize button (`HTMAXBUTTON`). Kai draws its own
//! buttons inside the WebView (`decorations: false`), and the WebView's own
//! windows live in another process, so they cannot be made to answer the hit
//! test. Instead the frontend reports where the maximize button is
//! ([`set_maximize_button_rect`]) and, on Windows 11, this module keeps an
//! invisible child window of ours stacked over exactly that rectangle. It
//! answers the hit test with `HTMAXBUTTON`, turns the native mouse messages
//! into hover / pressed state for the page, and maximizes / restores on click.
//!
//! The pieces that need no Windows API (rectangle maths, the hover / pressed
//! state machine, the Windows 11 check) are unit-tested on every platform. The
//! Win32 part (`imp`) is compiled on Windows only; elsewhere every entry point
//! is a no-op that reports "not active", and the in-page button works as before.

use serde::{Deserialize, Serialize};

/// A rectangle in physical pixels of the window's client area. `right` and
/// `bottom` are exclusive.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ButtonRect {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

impl ButtonRect {
    /// From a CSS-pixel box (`getBoundingClientRect`) and the window's scale
    /// factor. `None` for anything that is not a sane, non-empty box.
    pub fn from_css(x: f64, y: f64, width: f64, height: f64, scale: f64) -> Option<Self> {
        let finite = [x, y, width, height, scale].iter().all(|v| v.is_finite());
        if !finite || width <= 0.0 || height <= 0.0 || scale <= 0.0 {
            return None;
        }
        // A button is tens of pixels wide; anything huge is a layout glitch,
        // and treating it as the button would swallow the whole window.
        if width > 1024.0 || height > 512.0 {
            return None;
        }
        let rect = ButtonRect {
            left: (x * scale).round() as i32,
            top: (y * scale).round() as i32,
            right: ((x + width) * scale).round() as i32,
            bottom: ((y + height) * scale).round() as i32,
        };
        (rect.right > rect.left && rect.bottom > rect.top).then_some(rect)
    }
}

/// How the maximize button should look, driven by the native mouse messages
/// (the WebView no longer receives the pointer while it is over the button).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ButtonState {
    None,
    Hover,
    Pressed,
}

impl ButtonState {
    pub fn as_str(self) -> &'static str {
        match self {
            ButtonState::None => "none",
            ButtonState::Hover => "hover",
            ButtonState::Pressed => "pressed",
        }
    }
}

/// Native pointer events on the maximize button.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PointerEvent {
    Move,
    Leave,
    Down,
    /// Button released over the maximize button.
    Up,
}

/// Result of one pointer event: the new state and whether to toggle maximize.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Transition {
    pub state: ButtonState,
    pub toggle_maximize: bool,
}

/// Hover / pressed state machine. A click is a press followed by a release on
/// the button; a press that ends elsewhere does nothing.
pub fn transition(state: ButtonState, event: PointerEvent) -> Transition {
    let (state, toggle_maximize) = match (state, event) {
        (_, PointerEvent::Leave) => (ButtonState::None, false),
        (ButtonState::Pressed, PointerEvent::Move) => (ButtonState::Pressed, false),
        (_, PointerEvent::Move) => (ButtonState::Hover, false),
        (_, PointerEvent::Down) => (ButtonState::Pressed, false),
        (ButtonState::Pressed, PointerEvent::Up) => (ButtonState::Hover, true),
        (s, PointerEvent::Up) => (s, false),
    };
    Transition {
        state,
        toggle_maximize,
    }
}

/// First Windows 11 build. Earlier Windows has no snap-layouts popup, so the
/// hook is not installed there and the in-page button keeps handling its own
/// pointer.
pub const WINDOWS_11_MIN_BUILD: u32 = 22000;

pub fn snap_layouts_supported(build: u32) -> bool {
    build >= WINDOWS_11_MIN_BUILD
}

/// Installs the hook on the window (idempotent) and sets or clears the
/// maximize button rectangle. Returns whether the native hit test is active.
/// `notify` is called, from the UI thread, when the button's state changes.
pub fn set_maximize_button_rect(
    hwnd: isize,
    rect: Option<ButtonRect>,
    notify: impl Fn(ButtonState) + Send + Sync + 'static,
) -> bool {
    imp::set_rect(hwnd, rect, notify)
}

#[cfg(not(windows))]
mod imp {
    use super::{ButtonRect, ButtonState};

    pub fn set_rect(
        _hwnd: isize,
        _rect: Option<ButtonRect>,
        _notify: impl Fn(ButtonState) + Send + Sync + 'static,
    ) -> bool {
        false
    }
}

#[cfg(windows)]
mod imp {
    use super::{snap_layouts_supported, transition, ButtonRect, ButtonState, PointerEvent};
    use std::sync::atomic::{AtomicBool, AtomicIsize, AtomicU32, Ordering};
    use std::sync::OnceLock;
    use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::System::SystemInformation::OSVERSIONINFOW;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        TrackMouseEvent, TME_LEAVE, TME_NONCLIENT, TRACKMOUSEEVENT,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, GetParent, IsZoomed, RegisterClassW,
        SetLayeredWindowAttributes, SetWindowPos, ShowWindow, HTMAXBUTTON, HWND_TOP, LWA_ALPHA,
        MA_NOACTIVATE, SWP_NOACTIVATE, SWP_SHOWWINDOW, SW_HIDE, SW_MAXIMIZE, SW_RESTORE,
        WM_ERASEBKGND, WM_MOUSEACTIVATE, WM_NCDESTROY, WM_NCHITTEST, WM_NCLBUTTONDBLCLK,
        WM_NCLBUTTONDOWN, WM_NCLBUTTONUP, WM_NCMOUSELEAVE, WM_NCMOUSEMOVE, WNDCLASSW, WS_CHILD,
        WS_CLIPSIBLINGS, WS_EX_LAYERED, WS_EX_NOACTIVATE,
    };

    // Why a window of our own and not a hook on the WebView: the WebView's
    // windows (`Chrome_WidgetWin_1`, `Chrome_RenderWidgetHostHWND`) belong to
    // the msedgewebview2 process, so this process cannot subclass them or
    // change their hit test. A child window of ours, stacked above them over
    // the maximize button, can: it is invisible, owns the pointer there, and
    // answers the hit test with `HTMAXBUTTON`, which is what makes Windows 11
    // show the snap-layouts popup.

    type Notify = Box<dyn Fn(ButtonState) + Send + Sync>;

    static NOTIFY: OnceLock<Notify> = OnceLock::new();
    static SUPPORTED: OnceLock<bool> = OnceLock::new();
    static OVERLAY: AtomicIsize = AtomicIsize::new(0);
    static STATE: AtomicU32 = AtomicU32::new(0);
    static TRACKING: AtomicBool = AtomicBool::new(false);

    fn state() -> ButtonState {
        match STATE.load(Ordering::Relaxed) {
            1 => ButtonState::Hover,
            2 => ButtonState::Pressed,
            _ => ButtonState::None,
        }
    }

    fn publish(next: ButtonState) {
        let previous = state();
        STATE.store(
            match next {
                ButtonState::None => 0,
                ButtonState::Hover => 1,
                ButtonState::Pressed => 2,
            },
            Ordering::Relaxed,
        );
        if previous != next {
            if let Some(notify) = NOTIFY.get() {
                notify(next);
            }
        }
    }

    /// The Windows build number, from `RtlGetVersion` (not shimmed by manifests).
    fn windows_build() -> u32 {
        #[link(name = "ntdll")]
        extern "system" {
            fn RtlGetVersion(info: *mut OSVERSIONINFOW) -> i32;
        }
        // SAFETY: `info` is a zeroed, correctly sized OSVERSIONINFOW.
        unsafe {
            let mut info: OSVERSIONINFOW = std::mem::zeroed();
            info.dwOSVersionInfoSize = std::mem::size_of::<OSVERSIONINFOW>() as u32;
            if RtlGetVersion(&mut info) == 0 {
                info.dwBuildNumber
            } else {
                0
            }
        }
    }

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn apply(event: PointerEvent) -> bool {
        let t = transition(state(), event);
        publish(t.state);
        t.toggle_maximize
    }

    fn track_leave(hwnd: HWND) {
        if TRACKING.swap(true, Ordering::Relaxed) {
            return;
        }
        let mut tme = TRACKMOUSEEVENT {
            cbSize: std::mem::size_of::<TRACKMOUSEEVENT>() as u32,
            dwFlags: TME_LEAVE | TME_NONCLIENT,
            hwndTrack: hwnd,
            dwHoverTime: 0,
        };
        // SAFETY: `tme` is fully initialised.
        if unsafe { TrackMouseEvent(&mut tme) } == 0 {
            TRACKING.store(false, Ordering::Relaxed);
        }
    }

    unsafe extern "system" fn overlay_proc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        match msg {
            WM_NCHITTEST => return HTMAXBUTTON as LRESULT,
            // A click must not take focus away from the terminal.
            WM_MOUSEACTIVATE => return MA_NOACTIVATE as LRESULT,
            WM_ERASEBKGND => return 1,
            WM_NCMOUSEMOVE => {
                track_leave(hwnd);
                apply(PointerEvent::Move);
                return 0;
            }
            WM_NCMOUSELEAVE => {
                TRACKING.store(false, Ordering::Relaxed);
                apply(PointerEvent::Leave);
                return 0;
            }
            // The press and release are ours: Windows would otherwise run its
            // caption-button tracking, which a window without a caption lacks.
            // The second press of a quick double click arrives as a double click.
            WM_NCLBUTTONDOWN | WM_NCLBUTTONDBLCLK => {
                apply(PointerEvent::Down);
                return 0;
            }
            WM_NCLBUTTONUP => {
                if apply(PointerEvent::Up) {
                    // SAFETY: `hwnd` is our overlay; its parent is the app window.
                    unsafe {
                        let main = GetParent(hwnd);
                        if !main.is_null() {
                            let command = if IsZoomed(main) != 0 {
                                SW_RESTORE
                            } else {
                                SW_MAXIMIZE
                            };
                            ShowWindow(main, command);
                        }
                    }
                }
                return 0;
            }
            WM_NCDESTROY => {
                OVERLAY.store(0, Ordering::Relaxed);
                TRACKING.store(false, Ordering::Relaxed);
                publish(ButtonState::None);
            }
            _ => {}
        }
        // SAFETY: default processing for everything not handled above.
        unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
    }

    /// The overlay window, created on first use as a child of `parent`.
    /// Must run on the thread that pumps `parent`'s messages (the main thread:
    /// Tauri runs plain commands there).
    fn overlay_for(parent: HWND) -> HWND {
        let existing = OVERLAY.load(Ordering::Relaxed);
        if existing != 0 {
            return existing as HWND;
        }
        let class = wide("KaiSnapLayoutsOverlay");
        // SAFETY: plain Win32 class registration and child-window creation with
        // valid, NUL-terminated strings; failures return null / 0 and are handled.
        unsafe {
            let instance = GetModuleHandleW(std::ptr::null());
            let wc = WNDCLASSW {
                style: 0,
                lpfnWndProc: Some(overlay_proc),
                cbClsExtra: 0,
                cbWndExtra: 0,
                hInstance: instance,
                hIcon: std::ptr::null_mut(),
                hCursor: std::ptr::null_mut(),
                hbrBackground: std::ptr::null_mut(),
                lpszMenuName: std::ptr::null(),
                lpszClassName: class.as_ptr(),
            };
            // 0 when already registered (a second call): creation below still works.
            RegisterClassW(&wc);
            let hwnd = CreateWindowExW(
                WS_EX_LAYERED | WS_EX_NOACTIVATE,
                class.as_ptr(),
                std::ptr::null(),
                WS_CHILD | WS_CLIPSIBLINGS,
                0,
                0,
                1,
                1,
                parent,
                std::ptr::null_mut(),
                instance,
                std::ptr::null(),
            );
            if hwnd.is_null() {
                return std::ptr::null_mut();
            }
            // Layered with an alpha of 1/255: invisible, but still hit-tested
            // (a fully transparent pixel would let the pointer fall through).
            SetLayeredWindowAttributes(hwnd, 0, 1, LWA_ALPHA);
            OVERLAY.store(hwnd as isize, Ordering::Relaxed);
            hwnd
        }
    }

    pub fn set_rect(
        hwnd: isize,
        new_rect: Option<ButtonRect>,
        notify: impl Fn(ButtonState) + Send + Sync + 'static,
    ) -> bool {
        let supported = *SUPPORTED.get_or_init(|| snap_layouts_supported(windows_build()));
        if !supported || hwnd == 0 {
            return false;
        }
        let _ = NOTIFY.set(Box::new(notify));
        let parent = hwnd as HWND;
        match new_rect {
            Some(r) => {
                let overlay = overlay_for(parent);
                if overlay.is_null() {
                    return false;
                }
                // Re-stacked on every report: the WebView is restacked when the
                // window is resized, and must not end up above the overlay.
                // SAFETY: `overlay` is our live child window.
                unsafe {
                    SetWindowPos(
                        overlay,
                        HWND_TOP,
                        r.left,
                        r.top,
                        r.right - r.left,
                        r.bottom - r.top,
                        SWP_NOACTIVATE | SWP_SHOWWINDOW,
                    );
                }
                true
            }
            None => {
                let overlay = OVERLAY.load(Ordering::Relaxed);
                if overlay != 0 {
                    // SAFETY: hiding our own child window.
                    unsafe { ShowWindow(overlay as HWND, SW_HIDE) };
                }
                publish(ButtonState::None);
                false
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect() -> ButtonRect {
        ButtonRect {
            left: 100,
            top: 0,
            right: 146,
            bottom: 40,
        }
    }

    #[test]
    fn css_boxes_scale_to_physical_pixels() {
        let r = ButtonRect::from_css(50.0, 0.0, 23.0, 20.0, 2.0).unwrap();
        assert_eq!(r, rect());
        // Fractional scale (125%) rounds to whole pixels.
        let r = ButtonRect::from_css(10.5, 0.0, 46.0, 30.0, 1.25).unwrap();
        assert_eq!((r.left, r.right, r.bottom), (13, 71, 38));
    }

    #[test]
    fn insane_boxes_are_rejected() {
        assert!(ButtonRect::from_css(0.0, 0.0, 0.0, 10.0, 1.0).is_none());
        assert!(ButtonRect::from_css(0.0, 0.0, 10.0, -1.0, 1.0).is_none());
        assert!(ButtonRect::from_css(f64::NAN, 0.0, 10.0, 10.0, 1.0).is_none());
        assert!(ButtonRect::from_css(0.0, 0.0, 10.0, 10.0, 0.0).is_none());
        assert!(ButtonRect::from_css(0.0, 0.0, 10.0, 10.0, f64::INFINITY).is_none());
        assert!(ButtonRect::from_css(0.0, 0.0, 5000.0, 30.0, 1.0).is_none());
    }

    #[test]
    fn hover_press_release_is_a_click() {
        let t = transition(ButtonState::None, PointerEvent::Move);
        assert_eq!(t.state, ButtonState::Hover);
        assert!(!t.toggle_maximize);
        let t = transition(t.state, PointerEvent::Down);
        assert_eq!(t.state, ButtonState::Pressed);
        let t = transition(t.state, PointerEvent::Move);
        assert_eq!(t.state, ButtonState::Pressed);
        let t = transition(t.state, PointerEvent::Up);
        assert_eq!(t.state, ButtonState::Hover);
        assert!(t.toggle_maximize);
    }

    #[test]
    fn a_press_that_leaves_is_not_a_click() {
        let t = transition(ButtonState::Pressed, PointerEvent::Leave);
        assert_eq!(t.state, ButtonState::None);
        assert!(!t.toggle_maximize);
        // A release with no press on the button (press began elsewhere).
        let t = transition(ButtonState::Hover, PointerEvent::Up);
        assert_eq!(t.state, ButtonState::Hover);
        assert!(!t.toggle_maximize);
    }

    #[test]
    fn snap_layouts_need_windows_11() {
        assert!(!snap_layouts_supported(19045)); // Windows 10 22H2
        assert!(!snap_layouts_supported(21999));
        assert!(snap_layouts_supported(22000)); // Windows 11 21H2
        assert!(snap_layouts_supported(26300));
    }

    #[test]
    fn state_names_match_the_frontend_contract() {
        assert_eq!(ButtonState::None.as_str(), "none");
        assert_eq!(ButtonState::Hover.as_str(), "hover");
        assert_eq!(ButtonState::Pressed.as_str(), "pressed");
    }

    #[cfg(not(windows))]
    #[test]
    fn it_is_a_no_op_off_windows() {
        assert!(!set_maximize_button_rect(1, Some(rect()), |_| {}));
    }
}
