//! Bridge between the desktop UI and the Node CLI's integration commands.
//!
//! The UI sends ONE JSON request to `kai azure rpc` on stdin and reads ONE JSON
//! line back (see `src/core/integrations/rpcTypes.ts`). The argument list is
//! constant, so no user-supplied value ever reaches a shell or a process
//! listing, and secrets (an access token typed in Settings) travel only
//! through the pipe. The request body is never logged or put in an error.

use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Called with the sign-in address a browser sign-in prints before it waits.
pub type SignInUrlSink = Box<dyn Fn(String) + Send + 'static>;

/// The browser sign-in in progress, if any: setting its flag stops it.
static ACTIVE_SIGN_IN: Mutex<Option<Arc<AtomicBool>>> = Mutex::new(None);

/// Stops a waiting browser sign-in. Returns whether one was running.
pub fn cancel_browser_sign_in() -> bool {
    match ACTIVE_SIGN_IN.lock() {
        Ok(active) => match active.as_ref() {
            Some(flag) => {
                flag.store(true, Ordering::SeqCst);
                true
            }
            None => false,
        },
        Err(_) => false,
    }
}

/// Largest request the bridge forwards. Requests are small by design.
const MAX_REQUEST_BYTES: usize = 64 * 1024;
/// Upper bound on a CLI response we keep in memory.
const MAX_RESPONSE_BYTES: u64 = 1024 * 1024;
/// A login may call `az` and the Azure DevOps API, so allow a generous bound.
const RPC_TIMEOUT: Duration = Duration::from_secs(60);
/// A browser sign-in waits for the person to finish in their browser. The CLI
/// gives up on its own after 5 minutes; this is only the backstop above that.
const BROWSER_LOGIN_TIMEOUT: Duration = Duration::from_secs(6 * 60);

/// How long the request may run: browser sign-in waits on a person, the rest do not.
fn timeout_for(raw: &str) -> Duration {
    match serde_json::from_str::<serde_json::Value>(raw) {
        Ok(v)
            if matches!(
                v.get("op").and_then(|op| op.as_str()),
                Some("login_browser") | Some("teams_login")
            ) =>
        {
            BROWSER_LOGIN_TIMEOUT
        }
        _ => RPC_TIMEOUT,
    }
}

/// Accepts only a JSON object of at most [`MAX_REQUEST_BYTES`].
fn validate_request(raw: &str) -> Result<(), String> {
    if raw.len() > MAX_REQUEST_BYTES {
        return Err("Integration request is too large.".to_string());
    }
    match serde_json::from_str::<serde_json::Value>(raw) {
        Ok(serde_json::Value::Object(_)) => Ok(()),
        _ => Err("Integration request must be a JSON object.".to_string()),
    }
}

/// The URL in a `{"event":"signin_url","url":"https://..."}` progress line.
fn sign_in_url_of(line: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(line.trim()).ok()?;
    if value.get("event")?.as_str()? != "signin_url" {
        return None;
    }
    let url = value.get("url")?.as_str()?;
    (url.starts_with("https://") && url.len() <= 8192).then(|| url.to_string())
}

fn is_event_line(line: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(line)
        .ok()
        .is_some_and(|v| v.get("event").is_some())
}

/// The response: the last non-empty stdout line that is not a progress event.
fn last_non_empty_line(text: &str) -> Option<String> {
    text.lines()
        .map(str::trim)
        .rfind(|line| !line.is_empty() && !is_event_line(line))
        .map(str::to_string)
}

/// Program and arguments that run `<launcher> azure rpc`. On Windows the npm
/// shims (`.cmd`/`.bat`/`.ps1`) cannot be started by `CreateProcess` directly,
/// so they go through their interpreter; everything else is spawned as is.
fn launch_plan_with(launcher: &str, windows: bool, tail: &[&str]) -> (String, Vec<String>) {
    if windows {
        let lower = launcher.to_lowercase();
        if lower.ends_with(".cmd") || lower.ends_with(".bat") {
            let mut args = vec!["/c".to_string(), launcher.to_string()];
            args.extend(tail.iter().map(|s| s.to_string()));
            return ("cmd".to_string(), args);
        }
        if lower.ends_with(".ps1") {
            // PowerShell single-quote escaping: double any embedded quote.
            let quoted = launcher.replace('\'', "''");
            return (
                "powershell".to_string(),
                vec![
                    "-NoProfile".to_string(),
                    "-NonInteractive".to_string(),
                    "-Command".to_string(),
                    format!("& '{}' {}", quoted, tail.join(" ")),
                ],
            );
        }
    }
    (
        launcher.to_string(),
        tail.iter().map(|s| s.to_string()).collect(),
    )
}

/// Reads stdout (capped), passing each sign-in URL to `sink` as it arrives.
fn read_stdout<R: Read + Send + 'static>(
    stream: R,
    sink: Option<SignInUrlSink>,
) -> std::thread::JoinHandle<String> {
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stream.take(MAX_RESPONSE_BYTES));
        let mut out = String::new();
        let mut buf = Vec::new();
        loop {
            buf.clear();
            match reader.read_until(b'\n', &mut buf) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    let line = String::from_utf8_lossy(&buf);
                    if let (Some(sink), Some(url)) = (sink.as_ref(), sign_in_url_of(&line)) {
                        sink(url);
                    }
                    out.push_str(&line);
                }
            }
        }
        out
    })
}

fn read_capped<R: Read + Send + 'static>(mut stream: R) -> std::thread::JoinHandle<String> {
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = (&mut stream).take(MAX_RESPONSE_BYTES).read_to_end(&mut buf);
        String::from_utf8_lossy(&buf).into_owned()
    })
}

/// Runs one integration request through the installed `kai` CLI.
pub fn run_integration_rpc(request_json: &str) -> Result<String, String> {
    run_integration_rpc_with(request_json, None, None)
}

/// The CLI that ships inside the desktop app: Node.js plus its `index.js`.
pub struct BundledCli {
    pub node: String,
    pub script: std::path::PathBuf,
}

/// Prefers the app's bundled CLI (always matches the app) over `kai` on PATH.
fn command_for(bundled: Option<&BundledCli>) -> Result<(String, Vec<String>), String> {
    command_with_tail(bundled, &["azure", "rpc"])
}

/// The program and arguments that run `kai <tail...>`: the bundled CLI when the
/// app ships one, otherwise the `kai` launcher found on this PC.
pub(crate) fn command_with_tail(
    bundled: Option<&BundledCli>,
    tail: &[&str],
) -> Result<(String, Vec<String>), String> {
    if let Some(cli) = bundled {
        let mut args = vec![cli.script.to_string_lossy().into_owned()];
        args.extend(tail.iter().map(|s| s.to_string()));
        return Ok((cli.node.clone(), args));
    }
    let launcher = crate::ai_cli::get_kai_cli_launch()?
        .into_iter()
        .next()
        .ok_or_else(|| "kai CLI not found.".to_string())?;
    Ok(launch_plan_with(
        &launcher,
        cfg!(target_os = "windows"),
        tail,
    ))
}

/// [`run_integration_rpc`] with an optional bundled CLI and sign-in URL callback.
pub fn run_integration_rpc_with(
    request_json: &str,
    bundled: Option<&BundledCli>,
    on_url: Option<SignInUrlSink>,
) -> Result<String, String> {
    validate_request(request_json)?;
    let (program, args) = command_for(bundled)?;

    let mut command = Command::new(program);
    command
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command
        .spawn()
        .map_err(|_| "Could not start the kai CLI.".to_string())?;

    // Written on its own thread so a child that never reads cannot block the
    // timeout below; dropping the handle closes the pipe.
    let stdin_writer = child.stdin.take().map(|mut stdin| {
        let body = request_json.as_bytes().to_vec();
        std::thread::spawn(move || {
            let _ = stdin.write_all(&body);
        })
    });
    let stdout_reader = child.stdout.take().map(|out| read_stdout(out, on_url));
    let stderr_reader = child.stderr.take().map(read_capped);

    let timeout = timeout_for(request_json);
    let cancel = (timeout == BROWSER_LOGIN_TIMEOUT).then(|| {
        let flag = Arc::new(AtomicBool::new(false));
        if let Ok(mut active) = ACTIVE_SIGN_IN.lock() {
            *active = Some(flag.clone());
        }
        flag
    });
    let started = Instant::now();
    let mut cancelled = false;
    let mut lost = false;
    let timed_out = loop {
        if cancel.as_ref().is_some_and(|f| f.load(Ordering::SeqCst)) {
            let _ = child.kill();
            let _ = child.wait();
            cancelled = true;
            break false;
        }
        match child.try_wait() {
            Ok(Some(_)) => break false,
            Ok(None) if started.elapsed() >= timeout => {
                let _ = child.kill();
                let _ = child.wait();
                break true;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(_) => {
                lost = true;
                break false;
            }
        }
    };
    if let (Some(flag), Ok(mut active)) = (cancel.as_ref(), ACTIVE_SIGN_IN.lock()) {
        if active.as_ref().is_some_and(|a| Arc::ptr_eq(a, flag)) {
            *active = None;
        }
    }
    if lost {
        return Err("Lost the kai CLI process.".to_string());
    }

    if let Some(writer) = stdin_writer {
        let _ = writer.join();
    }
    let stdout = stdout_reader
        .and_then(|h| h.join().ok())
        .unwrap_or_default();
    // Drained so the child never blocks on a full pipe; its text is not
    // forwarded because it may echo arguments.
    let _ = stderr_reader.and_then(|h| h.join().ok());

    if cancelled {
        return Err("Sign-in was cancelled.".to_string());
    }
    if timed_out {
        return Err("The integration request timed out.".to_string());
    }
    let line = last_non_empty_line(&stdout)
        .ok_or_else(|| "The kai CLI returned no response.".to_string())?;
    match serde_json::from_str::<serde_json::Value>(&line) {
        Ok(serde_json::Value::Object(_)) => Ok(line),
        _ => Err("The kai CLI returned an unexpected response.".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_sign_in_address_and_skips_it_as_a_response() {
        let event = r#"{"event":"signin_url","url":"https://login.microsoftonline.com/x"}"#;
        assert_eq!(
            sign_in_url_of(event).as_deref(),
            Some("https://login.microsoftonline.com/x")
        );
        assert_eq!(
            sign_in_url_of(r#"{"event":"signin_url","url":"file:///etc"}"#),
            None
        );
        assert_eq!(sign_in_url_of(r#"{"ok":true}"#), None);
        assert_eq!(sign_in_url_of("not json"), None);
        let stdout = format!("{event}\n{{\"ok\":true}}\n");
        assert_eq!(
            last_non_empty_line(&stdout).as_deref(),
            Some(r#"{"ok":true}"#)
        );
        // Killed while waiting: only the event was printed, so there is no response.
        assert_eq!(last_non_empty_line(&format!("{event}\n")), None);
    }

    #[test]
    fn prefers_the_bundled_cli() {
        let cli = BundledCli {
            node: "node".to_string(),
            script: std::path::PathBuf::from("/app/_up_/dist/cli/index.js"),
        };
        let (program, args) = command_for(Some(&cli)).unwrap();
        assert_eq!(program, "node");
        assert_eq!(args[1..], ["azure".to_string(), "rpc".to_string()]);
        assert!(args[0].ends_with("index.js"));
    }

    #[test]
    fn cancelling_with_nothing_running_is_a_no_op() {
        assert!(!cancel_browser_sign_in());
    }

    #[test]
    fn accepts_a_small_json_object() {
        assert!(validate_request(r#"{"op":"status","projectDir":"C:\\x"}"#).is_ok());
    }

    #[test]
    fn only_browser_sign_in_gets_the_long_timeout() {
        assert_eq!(
            timeout_for(r#"{"op":"login_browser"}"#),
            BROWSER_LOGIN_TIMEOUT
        );
        assert_eq!(
            timeout_for(r#"{"op":"teams_login","channels":true}"#),
            BROWSER_LOGIN_TIMEOUT
        );
        assert_eq!(timeout_for(r#"{"op":"teams_verify"}"#), RPC_TIMEOUT);
        assert_eq!(
            timeout_for(r#"{"op":"status","projectDir":"/p"}"#),
            RPC_TIMEOUT
        );
        assert_eq!(timeout_for("{not json"), RPC_TIMEOUT);
        assert!(BROWSER_LOGIN_TIMEOUT > Duration::from_secs(5 * 60));
    }

    #[test]
    fn rejects_non_objects_and_garbage() {
        for raw in ["", "[]", "42", "\"op\"", "null", "{not json", "op=status"] {
            assert!(validate_request(raw).is_err(), "should reject {raw:?}");
        }
    }

    #[test]
    fn rejects_oversized_requests() {
        let big = format!(r#"{{"pat":"{}"}}"#, "x".repeat(MAX_REQUEST_BYTES));
        assert!(validate_request(&big).is_err());
        let ok = format!(r#"{{"pat":"{}"}}"#, "x".repeat(1024));
        assert!(validate_request(&ok).is_ok());
    }

    #[test]
    fn errors_never_echo_the_request() {
        let secret = "s3cret-token";
        let err = validate_request(&format!("{{bad {secret}")).unwrap_err();
        assert!(!err.contains(secret));
    }

    #[test]
    fn takes_the_last_non_empty_line() {
        assert_eq!(
            last_non_empty_line("warning\n{\"ok\":true}\n\n  \n").as_deref(),
            Some("{\"ok\":true}")
        );
        assert_eq!(
            last_non_empty_line("  {\"ok\":false}  ").as_deref(),
            Some("{\"ok\":false}")
        );
        assert_eq!(last_non_empty_line("\n \n"), None);
        assert_eq!(last_non_empty_line(""), None);
    }

    #[test]
    fn spawns_real_launchers_directly() {
        let (program, args) = launch_plan_with("/usr/local/bin/kai", false, &["azure", "rpc"]);
        assert_eq!(program, "/usr/local/bin/kai");
        assert_eq!(args, ["azure", "rpc"]);
        let (program, args) = launch_plan_with("C:\\kai\\kai.exe", true, &["azure", "rpc"]);
        assert_eq!(program, "C:\\kai\\kai.exe");
        assert_eq!(args, ["azure", "rpc"]);
    }

    #[test]
    fn routes_windows_shims_through_their_interpreter() {
        let (program, args) =
            launch_plan_with("C:\\Users\\me\\.kai\\bin\\kai.cmd", true, &["azure", "rpc"]);
        assert_eq!(program, "cmd");
        assert_eq!(
            args,
            ["/c", "C:\\Users\\me\\.kai\\bin\\kai.cmd", "azure", "rpc"]
        );

        let (program, args) = launch_plan_with("C:\\o'neil\\kai.ps1", true, &["azure", "rpc"]);
        assert_eq!(program, "powershell");
        assert_eq!(args[..3], ["-NoProfile", "-NonInteractive", "-Command"]);
        assert_eq!(args[3], "& 'C:\\o''neil\\kai.ps1' azure rpc");
    }

    #[test]
    fn shim_extensions_are_ignored_off_windows() {
        let (program, args) = launch_plan_with("/home/me/kai.cmd", false, &["azure", "rpc"]);
        assert_eq!(program, "/home/me/kai.cmd");
        assert_eq!(args, ["azure", "rpc"]);
    }
}
