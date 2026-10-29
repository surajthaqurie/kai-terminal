//! Bridge between the desktop UI and the Node CLI's integration commands.
//!
//! The UI sends ONE JSON request to `kai azure rpc` on stdin and reads ONE JSON
//! line back (see `src/core/integrations/rpcTypes.ts`). The argument list is
//! constant, so no user-supplied value ever reaches a shell or a process
//! listing, and secrets (an access token typed in Settings) travel only
//! through the pipe. The request body is never logged or put in an error.

use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// Largest request the bridge forwards. Requests are small by design.
const MAX_REQUEST_BYTES: usize = 64 * 1024;
/// Upper bound on a CLI response we keep in memory.
const MAX_RESPONSE_BYTES: u64 = 1024 * 1024;
/// A login may call `az` and the Azure DevOps API, so allow a generous bound.
const RPC_TIMEOUT: Duration = Duration::from_secs(60);

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

/// The last non-empty line of the CLI's stdout: the response line, even if a
/// shim or a warning printed something before it.
fn last_non_empty_line(text: &str) -> Option<String> {
    text.lines()
        .map(str::trim)
        .rfind(|line| !line.is_empty())
        .map(str::to_string)
}

/// Program and arguments that run `<launcher> azure rpc`. On Windows the npm
/// shims (`.cmd`/`.bat`/`.ps1`) cannot be started by `CreateProcess` directly,
/// so they go through their interpreter; everything else is spawned as is.
fn launch_plan(launcher: &str, windows: bool) -> (String, Vec<String>) {
    let tail = ["azure", "rpc"];
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
                    format!("& '{}' azure rpc", quoted),
                ],
            );
        }
    }
    (
        launcher.to_string(),
        tail.iter().map(|s| s.to_string()).collect(),
    )
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
    validate_request(request_json)?;
    let launcher = crate::ai_cli::get_kai_cli_launch()?
        .into_iter()
        .next()
        .ok_or_else(|| "kai CLI not found.".to_string())?;
    let (program, args) = launch_plan(&launcher, cfg!(target_os = "windows"));

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
    let stdout_reader = child.stdout.take().map(read_capped);
    let stderr_reader = child.stderr.take().map(read_capped);

    let started = Instant::now();
    let timed_out = loop {
        match child.try_wait() {
            Ok(Some(_)) => break false,
            Ok(None) if started.elapsed() >= RPC_TIMEOUT => {
                let _ = child.kill();
                let _ = child.wait();
                break true;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(_) => return Err("Lost the kai CLI process.".to_string()),
        }
    };

    if let Some(writer) = stdin_writer {
        let _ = writer.join();
    }
    let stdout = stdout_reader
        .and_then(|h| h.join().ok())
        .unwrap_or_default();
    // Drained so the child never blocks on a full pipe; its text is not
    // forwarded because it may echo arguments.
    let _ = stderr_reader.and_then(|h| h.join().ok());

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
    fn accepts_a_small_json_object() {
        assert!(validate_request(r#"{"op":"status","projectDir":"C:\\x"}"#).is_ok());
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
        let (program, args) = launch_plan("/usr/local/bin/kai", false);
        assert_eq!(program, "/usr/local/bin/kai");
        assert_eq!(args, ["azure", "rpc"]);
        let (program, args) = launch_plan("C:\\kai\\kai.exe", true);
        assert_eq!(program, "C:\\kai\\kai.exe");
        assert_eq!(args, ["azure", "rpc"]);
    }

    #[test]
    fn routes_windows_shims_through_their_interpreter() {
        let (program, args) = launch_plan("C:\\Users\\me\\.kai\\bin\\kai.cmd", true);
        assert_eq!(program, "cmd");
        assert_eq!(
            args,
            ["/c", "C:\\Users\\me\\.kai\\bin\\kai.cmd", "azure", "rpc"]
        );

        let (program, args) = launch_plan("C:\\o'neil\\kai.ps1", true);
        assert_eq!(program, "powershell");
        assert_eq!(args[..3], ["-NoProfile", "-NonInteractive", "-Command"]);
        assert_eq!(args[3], "& 'C:\\o''neil\\kai.ps1' azure rpc");
    }

    #[test]
    fn shim_extensions_are_ignored_off_windows() {
        let (program, args) = launch_plan("/home/me/kai.cmd", false);
        assert_eq!(program, "/home/me/kai.cmd");
        assert_eq!(args, ["azure", "rpc"]);
    }
}
