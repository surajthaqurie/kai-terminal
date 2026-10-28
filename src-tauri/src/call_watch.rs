//! "Is the user on a call?" detection, so Music Time can pause itself.
//!
//! A call is a known call app (Teams, Zoom, Meet in a browser, WhatsApp,
//! Phone Link, ...) holding the microphone. Requiring a *known* app keeps
//! voice dictation, recorders and other mic users from pausing the music.
//!
//! - Windows: every app with the microphone open is listed under
//!   `HKCU\...\CapabilityAccessManager\ConsentStore\microphone`; its
//!   `LastUsedTimeStop` is `0` while the microphone is live. Read through
//!   `reg.exe` like `autostart.rs`, so no new crates are needed.
//! - Linux: `pactl list source-outputs` names the app behind each live
//!   (not corked) recording stream.
//! - macOS: CoreAudio can say the default input is running but not which app
//!   uses it, so a call is "input running while a native call app is open".
//!   Browser calls (Meet) are not detected there: a browser is always open.
//! - Other platforms report "no call".

use std::sync::{Mutex, OnceLock};

/// Event the watcher emits to the frontend when the call state flips.
pub const CALL_STATE_EVENT: &str = "kai-call-state";

/// Consecutive "no call" polls required before a call counts as ended, so a
/// call app briefly releasing the microphone does not resume the music.
const POLLS_TO_END_CALL: u32 = 2;

/// Lowercase fragments that identify a call app in a registry key (Windows),
/// a PulseAudio stream's properties (Linux) or a process name (macOS).
const CALL_APPS: &[&str] = &[
    "msteams",
    "ms-teams",
    "microsoft.teams",
    "microsoft teams",
    "#teams.exe",
    "zoom",
    "skype",
    "webex",
    "slack",
    "discord",
    "whatsapp",
    "telegram",
    "signal",
    "viber",
    "wechat",
    "dingtalk",
    "feishu",
    "lark",
    "wemeet",
    "ringcentral",
    "bluejeans",
    "gotomeeting",
    "jitsi",
    "linphone",
    "zoiper",
    "lync",
    "yourphone",
    "facetime",
];

/// Browsers carry web calls (Meet, Teams on the web) but hold the microphone
/// for web dictation too. Counted on Windows and Linux, where the stream is
/// attributed to the browser; skipped on macOS, where a browser is always open.
const BROWSERS: &[&str] = &[
    "chrome",
    "chromium",
    "msedge",
    "microsoft edge",
    "firefox",
    "brave",
    "opera",
    "vivaldi",
    "webrtc voiceengine",
];

/// Limits on the user's extra call apps (Settings). Mirrored by
/// `sanitizeCallApps` in `src/services/callAppsService.ts`.
const MAX_EXTRA_CALL_APPS: usize = 32;
/// Shorter fragments would match almost every app name.
const MIN_EXTRA_APP_LEN: usize = 3;
const MAX_EXTRA_APP_LEN: usize = 64;

/// Extra call-app fragments from Settings, lowercase, on top of [`CALL_APPS`].
fn extra_call_apps() -> &'static Mutex<Vec<String>> {
    static EXTRA: OnceLock<Mutex<Vec<String>>> = OnceLock::new();
    EXTRA.get_or_init(|| Mutex::new(Vec::new()))
}

/// Trim, lowercase, de-duplicate and bound a user-supplied list: control
/// characters, too-short and too-long entries are dropped, at most 32 kept.
#[cfg_attr(not(any(feature = "tauri", test)), allow(dead_code))]
fn sanitize_extra_call_apps(raw: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for entry in raw {
        let app = entry.trim().to_ascii_lowercase();
        let len = app.chars().count();
        if !(MIN_EXTRA_APP_LEN..=MAX_EXTRA_APP_LEN).contains(&len)
            || app.chars().any(char::is_control)
            || out.contains(&app)
        {
            continue;
        }
        out.push(app);
        if out.len() >= MAX_EXTRA_CALL_APPS {
            break;
        }
    }
    out
}

/// Replace the extra call apps (called by the frontend at startup and on every
/// Settings change). Takes effect on the next poll.
#[cfg_attr(not(any(feature = "tauri", test)), allow(dead_code))]
pub fn set_extra_call_apps(raw: &[String]) {
    let cleaned = sanitize_extra_call_apps(raw);
    if let Ok(mut guard) = extra_call_apps().lock() {
        *guard = cleaned;
    }
}

#[cfg_attr(
    not(any(target_os = "windows", target_os = "linux", target_os = "macos", test)),
    allow(dead_code)
)]
fn is_call_app(identity: &str, with_browsers: bool) -> bool {
    let identity = identity.to_ascii_lowercase();
    let hit = |list: &[&str]| list.iter().any(|app| identity.contains(app));
    hit(CALL_APPS)
        || (with_browsers && hit(BROWSERS))
        || extra_call_apps()
            .lock()
            .is_ok_and(|extra| extra.iter().any(|app| identity.contains(app.as_str())))
}

/// Seconds between polls.
#[cfg(feature = "tauri")]
const POLL_INTERVAL_SECS: u64 = 3;

/// True when `reg query ... /s /v LastUsedTimeStop` output shows a call app
/// holding the microphone (`LastUsedTimeStop` equal to 0). Non-packaged apps
/// are keyed by their exe path with `\` turned into `#`.
#[cfg_attr(not(any(target_os = "windows", test)), allow(dead_code))]
fn parse_mic_in_use(reg_output: &str) -> bool {
    let mut current_key = "";
    for raw in reg_output.lines() {
        let line = raw.trim();
        if line.starts_with("HKEY_") {
            current_key = line;
            continue;
        }
        let mut parts = line.split_whitespace();
        if parts.next() != Some("LastUsedTimeStop") {
            continue;
        }
        let in_use = parts
            .nth(1)
            .and_then(|v| v.strip_prefix("0x"))
            .and_then(|v| u64::from_str_radix(v, 16).ok())
            == Some(0);
        if !in_use {
            continue;
        }
        if is_call_app(current_key, true) {
            return true;
        }
    }
    false
}

/// True when `pactl list source-outputs` shows a live (not corked) recording
/// stream from a call app. Meters (`Peak detect`, pavucontrol) are not calls.
#[cfg_attr(not(any(target_os = "linux", test)), allow(dead_code))]
fn parse_pactl_recording(output: &str) -> bool {
    output.split("Source Output #").skip(1).any(|block| {
        let live = block
            .lines()
            .any(|l| l.trim().eq_ignore_ascii_case("Corked: no"));
        let meter = block.contains("Peak detect") || block.contains("pavucontrol");
        live && !meter && is_call_app(block, true)
    })
}

/// CoreAudio: is the default input device running in any process?
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
mod coreaudio {
    use std::ffi::c_void;

    #[repr(C)]
    struct PropertyAddress {
        selector: u32,
        scope: u32,
        element: u32,
    }

    #[cfg_attr(target_os = "macos", link(name = "CoreAudio", kind = "framework"))]
    extern "C" {
        fn AudioObjectGetPropertyData(
            object: u32,
            address: *const PropertyAddress,
            qualifier_size: u32,
            qualifier: *const c_void,
            data_size: *mut u32,
            data: *mut c_void,
        ) -> i32;
    }

    const SYSTEM_OBJECT: u32 = 1;
    /// `kAudioHardwarePropertyDefaultInputDevice` ('dIn ').
    const DEFAULT_INPUT_DEVICE: u32 = 0x6449_6E20;
    /// `kAudioDevicePropertyDeviceIsRunningSomewhere` ('gone').
    const IS_RUNNING_SOMEWHERE: u32 = 0x676F_6E65;
    /// `kAudioObjectPropertyScopeGlobal` ('glob').
    const SCOPE_GLOBAL: u32 = 0x676C_6F62;

    fn read_u32(object: u32, selector: u32) -> Option<u32> {
        let address = PropertyAddress {
            selector,
            scope: SCOPE_GLOBAL,
            element: 0,
        };
        let mut value: u32 = 0;
        let mut size = std::mem::size_of::<u32>() as u32;
        // SAFETY: `address`, `size` and `value` outlive the call and `size`
        // is the byte length of `value`, as CoreAudio requires.
        let status = unsafe {
            AudioObjectGetPropertyData(
                object,
                &address,
                0,
                std::ptr::null(),
                &mut size,
                &mut value as *mut u32 as *mut c_void,
            )
        };
        (status == 0).then_some(value)
    }

    pub fn default_input_running() -> bool {
        read_u32(SYSTEM_OBJECT, DEFAULT_INPUT_DEVICE)
            .filter(|device| *device != 0)
            .and_then(|device| read_u32(device, IS_RUNNING_SOMEWHERE))
            == Some(1)
    }
}

/// True when `ps -axco comm` lists a native call app (no browsers).
#[cfg_attr(not(any(target_os = "macos", test)), allow(dead_code))]
fn parse_call_app_running(ps_output: &str) -> bool {
    ps_output.lines().any(|name| is_call_app(name, false))
}

/// True when a known call app currently has the microphone open.
pub fn is_call_active() -> bool {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        let out = std::process::Command::new("reg")
            .args([
                "query",
                r"HKCU\Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone",
                "/s",
                "/v",
                "LastUsedTimeStop",
            ])
            .creation_flags(0x08000000)
            .output();
        match out {
            Ok(out) => parse_mic_in_use(&String::from_utf8_lossy(&out.stdout)),
            Err(_) => false,
        }
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("pactl")
            .args(["list", "source-outputs"])
            .output()
            .is_ok_and(|out| parse_pactl_recording(&String::from_utf8_lossy(&out.stdout)))
    }
    #[cfg(target_os = "macos")]
    {
        coreaudio::default_input_running()
            && std::process::Command::new("ps")
                .args(["-axco", "comm"])
                .output()
                .is_ok_and(|out| parse_call_app_running(&String::from_utf8_lossy(&out.stdout)))
    }
    #[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
    {
        false
    }
}

/// Folds raw poll results into call-started / call-ended transitions.
#[cfg_attr(not(any(feature = "tauri", test)), allow(dead_code))]
#[derive(Default)]
struct CallTracker {
    active: bool,
    quiet_polls: u32,
}

#[cfg_attr(not(any(feature = "tauri", test)), allow(dead_code))]
impl CallTracker {
    /// Returns `Some(new_state)` only when the debounced state changes.
    fn observe(&mut self, mic_in_use: bool) -> Option<bool> {
        if mic_in_use {
            self.quiet_polls = 0;
            if !self.active {
                self.active = true;
                return Some(true);
            }
        } else if self.active {
            self.quiet_polls += 1;
            if self.quiet_polls >= POLLS_TO_END_CALL {
                self.active = false;
                self.quiet_polls = 0;
                return Some(false);
            }
        }
        None
    }
}

/// Polls in the background and emits [`CALL_STATE_EVENT`] on every change.
/// A no-op where there is no detector (anything but Windows, Linux, macOS).
#[cfg(feature = "tauri")]
pub fn spawn_call_watcher(app_handle: tauri::AppHandle) {
    if !cfg!(any(
        target_os = "windows",
        target_os = "linux",
        target_os = "macos"
    )) {
        return;
    }
    use tauri::Emitter;
    std::thread::spawn(move || {
        let mut tracker = CallTracker::default();
        loop {
            if let Some(active) = tracker.observe(is_call_active()) {
                let _ = app_handle.emit(CALL_STATE_EVENT, serde_json::json!({ "active": active }));
            }
            std::thread::sleep(std::time::Duration::from_secs(POLL_INTERVAL_SECS));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: &str = r"HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone";

    fn app(name: &str, stop: &str) -> String {
        format!("{KEY}\\{name}\n    LastUsedTimeStop    REG_QWORD    {stop}\n\n")
    }

    #[test]
    fn detects_call_app_holding_the_microphone() {
        let out = format!(
            "{}{}",
            app("MSTeams_8wekyb3d8bbwe", "0x0"),
            app("Other", "0x1dc1b2a3c4d5e6f")
        );
        assert!(parse_mic_in_use(&out));
        assert!(parse_mic_in_use(&app(
            r"NonPackaged\C:#Users#me#AppData#Roaming#Zoom#bin#Zoom.exe",
            "0x0"
        )));
        assert!(parse_mic_in_use(&app(
            r"NonPackaged\C:#Program Files#Google#Chrome#Application#chrome.exe",
            "0x0"
        )));
    }

    #[test]
    fn dictation_and_recorders_are_not_calls() {
        for key in [
            "Microsoft.WindowsSoundRecorder_8wekyb3d8bbwe",
            r"NonPackaged\C:#Program Files#Audacity#audacity.exe",
            r"NonPackaged\C:#Program Files#obs-studio#bin#64bit#obs64.exe",
            r"NonPackaged\C:#Windows#System32#SpeechRuntime.exe",
        ] {
            assert!(!parse_mic_in_use(&app(key, "0x0")), "{key}");
        }
    }

    #[test]
    fn released_microphone_is_not_a_call() {
        let out = app("MSTeams_8wekyb3d8bbwe", "0x1dc1b2a3c4d5e6f");
        assert!(!parse_mic_in_use(&out));
        assert!(!parse_mic_in_use(""));
        assert!(!parse_mic_in_use(
            "ERROR: The system was unable to find the key"
        ));
    }

    #[test]
    fn pactl_live_recording_stream_is_a_call() {
        let out = "Source Output #7
	Corked: no
	Properties:
		application.name = \"ZOOM VoiceEngine\"
";
        assert!(parse_pactl_recording(out));
        let browser = "Source Output #8\n\tCorked: no\n\t\tapplication.name = \"Firefox\"\n";
        assert!(parse_pactl_recording(browser));
    }

    #[test]
    fn pactl_corked_meter_and_empty_are_not_calls() {
        let corked = "Source Output #7
	Corked: yes
";
        let meter = "Source Output #9
	Corked: no
		media.name = \"Peak detect\"
";
        let recorder = "Source Output #4\n\tCorked: no\n\t\tapplication.name = \"arecord\"\n";
        assert!(!parse_pactl_recording(recorder));
        assert!(!parse_pactl_recording(corked));
        assert!(!parse_pactl_recording(meter));
        assert!(!parse_pactl_recording(""));
    }

    #[test]
    fn macos_needs_a_native_call_app_not_a_browser() {
        assert!(parse_call_app_running("launchd\nzoom.us\nFinder\n"));
        assert!(parse_call_app_running("Microsoft Teams\n"));
        assert!(!parse_call_app_running("Google Chrome\nSafari\nTerminal\n"));
    }

    #[test]
    fn extra_call_apps_are_sanitized() {
        let mut raw: Vec<String> = ["  GoToMeet ", "gotomeet", "ab", "", "bad\u{7}name"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        raw.push("x".repeat(MAX_EXTRA_APP_LEN + 1));
        raw.push("Mumble".to_string());
        assert_eq!(sanitize_extra_call_apps(&raw), vec!["gotomeet", "mumble"]);
        let many: Vec<String> = (0..100).map(|i| format!("app-number-{i}")).collect();
        assert_eq!(sanitize_extra_call_apps(&many).len(), MAX_EXTRA_CALL_APPS);
    }

    #[test]
    fn extra_call_apps_extend_the_built_in_list() {
        // A token no other test or built-in entry contains, so the shared
        // setting cannot affect the parallel tests above.
        let key = format!("{KEY}\\NonPackaged\\C:#Apps#kai-test-callapp#talk.exe");
        let out = format!("{key}\n    LastUsedTimeStop    REG_QWORD    0x0\n\n");
        assert!(!parse_mic_in_use(&out));
        set_extra_call_apps(&["Kai-Test-CallApp".to_string()]);
        assert!(parse_mic_in_use(&out));
        assert!(parse_call_app_running("launchd\nKAI-TEST-CALLAPP\n"));
        // The built-in list is untouched and browsers still need `with_browsers`.
        assert!(is_call_app("zoom.us", false));
        assert!(!is_call_app("chrome", false));
        set_extra_call_apps(&[]);
        assert!(!parse_mic_in_use(&out));
    }

    #[test]
    fn tracker_starts_at_once_and_ends_after_quiet_polls() {
        let mut t = CallTracker::default();
        assert_eq!(t.observe(false), None);
        assert_eq!(t.observe(true), Some(true));
        assert_eq!(t.observe(true), None);
        assert_eq!(t.observe(false), None);
        // A blip back to "in use" resets the countdown.
        assert_eq!(t.observe(true), None);
        assert_eq!(t.observe(false), None);
        assert_eq!(t.observe(false), Some(false));
        assert_eq!(t.observe(false), None);
    }
}
