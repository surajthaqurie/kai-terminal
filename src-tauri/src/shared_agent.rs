//! Supervises the Shared Agent engine: one long-lived Node process
//! (`dist/cli/shared-agent.js`, shipped next to the bundled CLI) that owns the
//! host server, the joined PCs and the chats. It is internal to the app: there
//! is no `kai` command for it, everything is driven from the UI.
//!
//! The desktop app talks to it in JSON lines. A request gets a numeric `id`
//! added here and is written to the service's stdin; the answer is the stdout
//! line carrying that `id`. Any other stdout line with an `"event"` key is
//! pushed to the UI through the event sink. The webview never reaches the LAN
//! itself (its CSP forbids it): all networking happens inside the Node service.
//!
//! The service starts on the first request and is stopped, gracefully first,
//! when the app exits. If the app dies without stopping it, the closed pipe
//! ends the service on its own, which stops sharing and ends every run.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::integrations::BundledCli;

/// A chat message can be 20,000 characters (up to 4 bytes each) plus its envelope.
const MAX_REQUEST_BYTES: usize = 256 * 1024;
/// The longest single line the service may send us (a chat chunk, a status).
const MAX_LINE_BYTES: u64 = 4 * 1024 * 1024;
/// Every request is quick: chats stream through events, not through the answer.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(45);
/// How long a stopping service gets to end its runs before it is killed. Short:
/// the app is closing, and the closed pipe ends a straggler on its own.
const STOP_GRACE: Duration = Duration::from_millis(1000);

/// The engine's file name, next to the bundled CLI's `index.js`.
const ENGINE_SCRIPT: &str = "shared-agent.js";
const ENGINE_MISSING: &str =
    "Shared Agent is not available in this installation (its engine file is missing). Reinstall Kai Terminal.";

/// Receives one JSON line per pushed event.
pub type EventSink = Arc<dyn Fn(String) + Send + Sync + 'static>;

type Pending = Arc<Mutex<HashMap<u64, Sender<String>>>>;

struct Running {
    child: Child,
    /// Shared so a request can write to it WITHOUT holding the `running` lock: a service that
    /// stops reading would otherwise block `stop()` and every other request behind a full pipe
    /// (REL-12). `stop()` kills the service, which makes a blocked write fail.
    stdin: Arc<Mutex<ChildStdin>>,
    pending: Pending,
}

#[derive(Default)]
pub struct SharedAgentService {
    running: Mutex<Option<Running>>,
    next_id: AtomicU64,
}

/// What one stdout line from the service is.
#[derive(Debug, PartialEq)]
enum Line {
    Response(u64),
    Event,
    Other,
}

fn classify(line: &str) -> Line {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(line.trim()) else {
        return Line::Other;
    };
    if let Some(id) = value.get("id").and_then(|v| v.as_u64()) {
        return Line::Response(id);
    }
    if value.get("event").is_some() {
        return Line::Event;
    }
    Line::Other
}

/// The request as one compact line carrying `id`. Accepts only a JSON object of bounded size.
fn with_request_id(raw: &str, id: u64) -> Result<String, String> {
    if raw.len() > MAX_REQUEST_BYTES {
        return Err("Shared Agent request is too large.".to_string());
    }
    match serde_json::from_str::<serde_json::Value>(raw) {
        Ok(serde_json::Value::Object(mut map)) => {
            map.insert("id".to_string(), serde_json::Value::from(id));
            serde_json::to_string(&map).map_err(|_| "Could not encode the request.".to_string())
        }
        _ => Err("Shared Agent request must be a JSON object.".to_string()),
    }
}

fn read_lines<R: Read + Send + 'static>(
    stream: R,
    pending: Pending,
    sink: EventSink,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stream);
        let mut buf = Vec::new();
        loop {
            buf.clear();
            // Capped per line, so a runaway service cannot exhaust memory.
            match (&mut reader)
                .take(MAX_LINE_BYTES)
                .read_until(b'\n', &mut buf)
            {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    let line = String::from_utf8_lossy(&buf).trim().to_string();
                    match classify(&line) {
                        Line::Response(id) => {
                            let sender = pending.lock().ok().and_then(|mut p| p.remove(&id));
                            if let Some(tx) = sender {
                                let _ = tx.send(line);
                            }
                        }
                        Line::Event => sink(line),
                        Line::Other => {}
                    }
                }
            }
        }
        // The service ended: waiting callers see their channel close, and the UI is told.
        if let Ok(mut p) = pending.lock() {
            p.clear();
        }
        sink(r#"{"event":"service_exit"}"#.to_string());
    })
}

fn drain<R: Read + Send + 'static>(mut stream: R) {
    std::thread::spawn(move || {
        let mut sink = [0u8; 4096];
        while matches!(stream.read(&mut sink), Ok(n) if n > 0) {}
    });
}

fn spawn_service(program: &str, args: &[String], sink: EventSink) -> Result<Running, String> {
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
        .map_err(|_| "Could not start the Shared Agent service.".to_string())?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "The Shared Agent service has no input.".to_string())?;
    let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
    if let Some(out) = child.stdout.take() {
        read_lines(out, pending.clone(), sink);
    }
    if let Some(err) = child.stderr.take() {
        // Drained so the service never blocks on a full pipe. Its text is not
        // forwarded: it could echo a request.
        drain(err);
    }
    Ok(Running {
        child,
        stdin: Arc::new(Mutex::new(stdin)),
        pending,
    })
}

/// Node and the engine script that ships beside the bundled CLI.
fn engine_command(bundled: Option<&BundledCli>) -> Result<(String, Vec<String>), String> {
    let cli = bundled.ok_or_else(|| ENGINE_MISSING.to_string())?;
    let script = cli.script.with_file_name(ENGINE_SCRIPT);
    if !script.is_file() {
        return Err(ENGINE_MISSING.to_string());
    }
    Ok((
        cli.node.clone(),
        vec![script.to_string_lossy().into_owned()],
    ))
}

impl SharedAgentService {
    /// Sends one request and waits for its answer. Starts the service if needed.
    pub fn request(
        &self,
        raw: &str,
        bundled: Option<&BundledCli>,
        sink: EventSink,
    ) -> Result<String, String> {
        let (program, args) = engine_command(bundled)?;
        self.request_with(raw, move |sink| spawn_service(&program, &args, sink), sink)
    }

    /// [`request`](Self::request) with the way to start the service supplied (tests use a stand-in).
    fn request_with<F>(&self, raw: &str, start: F, sink: EventSink) -> Result<String, String>
    where
        F: FnOnce(EventSink) -> Result<Running, String>,
    {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst) + 1;
        let line = with_request_id(raw, id)?;
        let (tx, rx) = mpsc::channel::<String>();
        let (stdin, pending) = {
            let mut guard = self
                .running
                .lock()
                .map_err(|_| "The Shared Agent service is unavailable.".to_string())?;
            // A service that has exited is replaced by a fresh one.
            let dead = match guard.as_mut() {
                Some(r) => !matches!(r.child.try_wait(), Ok(None)),
                None => true,
            };
            if dead {
                *guard = Some(start(sink)?);
            }
            let running = guard
                .as_mut()
                .ok_or("The Shared Agent service is unavailable.")?;
            running
                .pending
                .lock()
                .map_err(|_| "The Shared Agent service is unavailable.".to_string())?
                .insert(id, tx);
            (running.stdin.clone(), running.pending.clone())
        };
        // Written outside the `running` lock (see `Running::stdin`). Requests still reach the
        // service one whole line at a time: the stdin lock is held for the entire line.
        let written = match stdin.lock() {
            Ok(mut w) => w
                .write_all(line.as_bytes())
                .and_then(|_| w.write_all(b"\n"))
                .and_then(|_| w.flush()),
            Err(_) => Err(std::io::Error::other("stdin lock poisoned")),
        };
        if written.is_err() {
            if let Ok(mut p) = pending.lock() {
                p.remove(&id);
            }
            return Err("Lost the Shared Agent service.".to_string());
        }
        match rx.recv_timeout(REQUEST_TIMEOUT) {
            Ok(answer) => Ok(answer),
            Err(mpsc::RecvTimeoutError::Timeout) => {
                self.forget(id);
                Err("The Shared Agent request timed out.".to_string())
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                Err("The Shared Agent service stopped.".to_string())
            }
        }
    }

    fn forget(&self, id: u64) {
        if let Ok(guard) = self.running.lock() {
            if let Some(r) = guard.as_ref() {
                if let Ok(mut p) = r.pending.lock() {
                    p.remove(&id);
                }
            }
        }
    }

    /// Stops the service: closes its input so it can end its runs, then kills it
    /// if it has not exited within [`STOP_GRACE`]. Returns whether one was running.
    pub fn stop(&self) -> bool {
        let taken = self.running.lock().ok().and_then(|mut g| g.take());
        let Some(Running {
            mut child, stdin, ..
        }) = taken
        else {
            return false;
        };
        drop(stdin);
        let started = Instant::now();
        while started.elapsed() < STOP_GRACE {
            if matches!(child.try_wait(), Ok(Some(_))) {
                return true;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        let _ = child.kill();
        let _ = child.wait();
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tells_responses_from_events() {
        assert_eq!(classify(r#"{"id":7,"ok":true}"#), Line::Response(7));
        assert_eq!(classify(r#"{"event":"hosts","hosts":[]}"#), Line::Event);
        // A response wins even if it also mentions an event field.
        assert_eq!(classify(r#"{"id":3,"event":"x"}"#), Line::Response(3));
        assert_eq!(classify("not json"), Line::Other);
        assert_eq!(classify(r#"{"ok":true}"#), Line::Other);
        assert_eq!(classify(""), Line::Other);
    }

    #[test]
    fn adds_the_id_and_keeps_the_request_on_one_line() {
        let line = with_request_id(r#"{"op":"ping"}"#, 9).unwrap();
        let v: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(v["id"], 9);
        assert_eq!(v["op"], "ping");
        assert!(!line.contains('\n'));
        // A multi-line chat message stays one line (the newline is escaped).
        let line = with_request_id("{\"op\":\"chat_send\",\"message\":\"a\\nb\"}", 1).unwrap();
        assert!(!line.contains('\n'));
    }

    #[test]
    fn rejects_non_objects_garbage_and_oversize() {
        for raw in ["", "[]", "42", "\"op\"", "null", "{not json"] {
            assert!(with_request_id(raw, 1).is_err(), "should reject {raw:?}");
        }
        let big = format!(r#"{{"message":"{}"}}"#, "x".repeat(MAX_REQUEST_BYTES));
        assert!(with_request_id(&big, 1).is_err());
        assert!(with_request_id(&format!(r#"{{"message":"{}"}}"#, "x".repeat(1024)), 1).is_ok());
    }

    #[test]
    fn errors_never_echo_the_request() {
        let secret = "s3cret-invite-key";
        let err = with_request_id(&format!("{{bad {secret}"), 1).unwrap_err();
        assert!(!err.contains(secret));
    }

    #[test]
    fn runs_the_engine_beside_the_bundled_cli_and_nothing_else() {
        let dir = std::env::temp_dir().join(format!("kai-engine-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let cli = BundledCli {
            node: "node".to_string(),
            script: dir.join("index.js"),
        };
        // No `kai` fallback: without the bundled CLI, or without the engine file, it says why.
        assert_eq!(engine_command(None).unwrap_err(), ENGINE_MISSING);
        assert_eq!(engine_command(Some(&cli)).unwrap_err(), ENGINE_MISSING);
        std::fs::write(dir.join(ENGINE_SCRIPT), "").unwrap();
        let (program, args) = engine_command(Some(&cli)).unwrap();
        assert_eq!(program, "node");
        assert_eq!(
            args,
            vec![dir.join(ENGINE_SCRIPT).to_string_lossy().into_owned()]
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn stopping_with_nothing_running_is_a_no_op() {
        assert!(!SharedAgentService::default().stop());
    }

    /// A stand-in service in Node: answers each request with its id, and pushes
    /// one event first, so routing and event forwarding are both exercised.
    /// Returns None (the test is skipped) when Node is not installed.
    fn node_stand_in(events: Arc<Mutex<Vec<String>>>) -> Option<Running> {
        let script = r#"
            const rl = require('readline').createInterface({ input: process.stdin });
            rl.on('line', (l) => {
              const r = JSON.parse(l);
              console.log(JSON.stringify({ event: 'hosts', seen: r.op }));
              console.log(JSON.stringify({ id: r.id, ok: true, echo: r.op }));
            });
            rl.on('close', () => process.exit(0));
        "#;
        let check = Command::new("node").arg("--version").output().ok()?;
        if !check.status.success() {
            return None;
        }
        let sink: EventSink = Arc::new(move |line| events.lock().unwrap().push(line));
        spawn_service("node", &["-e".to_string(), script.to_string()], sink).ok()
    }

    #[test]
    fn routes_answers_by_id_forwards_events_and_stops_cleanly() {
        let _guard = crate::test_support::lock_test_env();
        let events = Arc::new(Mutex::new(Vec::<String>::new()));
        let Some(running) = node_stand_in(events.clone()) else {
            eprintln!("node not available: skipping");
            return;
        };
        let service = SharedAgentService::default();
        *service.running.lock().unwrap() = Some(running);
        let sink: EventSink = Arc::new(|_| {});

        let a = service
            .request_with(
                r#"{"op":"one"}"#,
                |_| Err("must not restart".into()),
                sink.clone(),
            )
            .unwrap();
        let b = service
            .request_with(r#"{"op":"two"}"#, |_| Err("must not restart".into()), sink)
            .unwrap();
        let (a, b): (serde_json::Value, serde_json::Value) = (
            serde_json::from_str(&a).unwrap(),
            serde_json::from_str(&b).unwrap(),
        );
        assert_eq!(a["echo"], "one");
        assert_eq!(b["echo"], "two");
        assert_ne!(a["id"], b["id"]);

        // Events are pushed from the reader thread; give it a moment to deliver both.
        let deadline = Instant::now() + Duration::from_secs(5);
        while events.lock().unwrap().len() < 2 && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        let seen = events.lock().unwrap().clone();
        assert_eq!(seen.len(), 2, "one event per request: {seen:?}");
        assert!(seen[0].contains("one"));

        assert!(service.stop());
        assert!(!service.stop(), "already stopped");
    }

    /// A service that never reads its input (hung, or busy forever).
    fn deaf_service() -> Option<Running> {
        let check = Command::new("node").arg("--version").output().ok()?;
        if !check.status.success() {
            return None;
        }
        let script = "setInterval(() => {}, 1000);";
        let sink: EventSink = Arc::new(|_| {});
        spawn_service("node", &["-e".to_string(), script.to_string()], sink).ok()
    }

    #[test]
    fn a_service_that_stops_reading_cannot_block_stop() {
        let _guard = crate::test_support::lock_test_env();
        let Some(running) = deaf_service() else {
            eprintln!("node not available: skipping");
            return;
        };
        let service = Arc::new(SharedAgentService::default());
        *service.running.lock().unwrap() = Some(running);

        // A request (just under the size cap) far larger than any pipe buffer: its write blocks, the service never reads.
        let big = format!(r#"{{"op":"x","pad":"{}"}}"#, "A".repeat(250 * 1024));
        let requester = {
            let service = service.clone();
            std::thread::spawn(move || {
                let sink: EventSink = Arc::new(|_| {});
                service.request_with(&big, |_| Err("must not restart".into()), sink)
            })
        };
        std::thread::sleep(Duration::from_millis(500)); // the writer is now stuck in write_all

        // Stopping must not wait for that write: it takes the service away and kills it.
        let (done_tx, done_rx) = mpsc::channel();
        let stopper = {
            let service = service.clone();
            std::thread::spawn(move || {
                let started = service.stop();
                let _ = done_tx.send(started);
            })
        };
        let stopped = done_rx
            .recv_timeout(Duration::from_secs(10))
            .expect("stop() must not be blocked by a request stuck writing");
        assert!(stopped);
        stopper.join().unwrap();

        // Killing the service breaks the pipe, so the stuck request fails instead of hanging.
        let result = requester.join().unwrap();
        assert!(result.is_err(), "the stuck request must fail: {result:?}");
    }
}
