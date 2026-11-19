//! Local relay page that lets the music player control the YouTube embed on
//! macOS and Linux.
//!
//! The YouTube embed accepts postMessage commands (play, pause, seek...) only
//! from the web origin it was given, and reports its state only to it. The
//! desktop app's page has one on Windows (`http://tauri.localhost`), but on
//! macOS and Linux it is `tauri://localhost`, which YouTube rejects. So there
//! the player loads this page from `http://localhost:<port>` instead: it hosts
//! the embed with its own (valid) origin and passes the app's commands to it and
//! the embed's reports back to the app (see `musicService.ts`, `setMusicRelay`).
//!
//! The host name must be `localhost`: YouTube refuses to play inside a page
//! addressed by IP (`127.0.0.1`), answering error 150 ("embedding not allowed").
//! `localhost` may resolve to IPv4 or IPv6, so the server listens on both
//! loopback addresses (one random port). It serves one static page (no data,
//! no state, nothing else), and answers only requests addressed to
//! `localhost:<port>` (a DNS-rebinding page cannot reach it under another name).

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::OnceLock;
use std::time::Duration;

pub const RELAY_PATH: &str = "/youtube-relay.html";

/// The relay page. It embeds the YouTube URL from its `src` query parameter
/// (YouTube embed URLs only), with this page's origin as the embed origin.
pub const RELAY_HTML: &str = r#"<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="referrer" content="strict-origin-when-cross-origin">
<title>Kai music</title>
<style>html,body{margin:0;height:100%;background:#000;overflow:hidden}iframe{border:0;width:100%;height:100%;display:block}</style>
</head>
<body>
<script>
(function () {
  // Tells the app this page loads inside it (its check before relying on it).
  if (window.parent !== window) window.parent.postMessage("kai-relay-ready", "*");
  var YT = ["https://www.youtube-nocookie.com", "https://www.youtube.com"];
  var url;
  try { url = new URL(new URLSearchParams(location.search).get("src") || ""); } catch (e) { return; }
  if (YT.indexOf(url.origin) < 0 || url.pathname.indexOf("/embed") !== 0) return;
  // Commands are accepted from, and reports sent to, this page's origin.
  url.searchParams.set("origin", location.origin);
  url.searchParams.set("widget_referrer", location.origin);
  var frame = document.createElement("iframe");
  frame.allow = "autoplay; encrypted-media; picture-in-picture; fullscreen";
  frame.setAttribute("allowfullscreen", "");
  frame.referrerPolicy = "strict-origin-when-cross-origin";
  var ready = false;
  var queue = [];
  function send(m) { if (frame.contentWindow) frame.contentWindow.postMessage(m, url.origin); }
  frame.addEventListener("load", function () { ready = true; queue.splice(0).forEach(send); });
  window.addEventListener("message", function (e) {
    // App -> embed: commands and the "listening" handshake (strings only).
    if (e.source === window.parent && e.source !== window) {
      if (typeof e.data !== "string") return;
      if (ready) send(e.data); else if (queue.length < 100) queue.push(e.data);
      return;
    }
    // Embed -> app: its state reports.
    if (e.source === frame.contentWindow && YT.indexOf(e.origin) >= 0) {
      window.parent.postMessage(e.data, "*");
    }
  });
  frame.src = url.toString();
  document.body.appendChild(frame);
})();
</script>
</body>
</html>
"#;

const CSP: &str = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; \
frame-src https://www.youtube-nocookie.com https://www.youtube.com";

static RELAY_PORT: OnceLock<Result<u16, String>> = OnceLock::new();

/// The relay page's URL, starting the server on first use.
pub fn relay_url() -> Result<String, String> {
    let port = RELAY_PORT.get_or_init(start).clone()?;
    Ok(format!("http://localhost:{port}{RELAY_PATH}"))
}

fn start() -> Result<u16, String> {
    let v4 = TcpListener::bind(("127.0.0.1", 0)).map_err(|e| e.to_string())?;
    let port = v4.local_addr().map_err(|e| e.to_string())?.port();
    serve(v4, port)?;
    // Same port on IPv6 loopback, where `localhost` resolves there first.
    // Optional: a system without IPv6 still has the IPv4 listener.
    if let Ok(v6) = TcpListener::bind(("::1", port)) {
        let _ = serve(v6, port);
    }
    Ok(port)
}

fn serve(listener: TcpListener, port: u16) -> Result<(), String> {
    std::thread::Builder::new()
        .name("kai-music-relay".into())
        .spawn(move || {
            for stream in listener.incoming().flatten() {
                let _ = std::thread::Builder::new()
                    .name("kai-music-relay-conn".into())
                    .spawn(move || handle(stream, port));
            }
        })
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// The response for a raw HTTP request (the request line and headers).
pub fn respond(request: &str, port: u16) -> Vec<u8> {
    let mut lines = request.split("\r\n");
    let first = lines.next().unwrap_or("");
    let mut parts = first.split(' ');
    let method = parts.next().unwrap_or("");
    let target = parts.next().unwrap_or("");
    let path = target.split('?').next().unwrap_or("");
    let expected_host = format!("localhost:{port}");
    let host_ok = lines.any(|l| {
        l.split_once(':').is_some_and(|(k, v)| {
            k.trim().eq_ignore_ascii_case("host") && v.trim().eq_ignore_ascii_case(&expected_host)
        })
    });
    if method != "GET" || path != RELAY_PATH || !host_ok {
        return b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            .to_vec();
    }
    let mut out = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\n\
Cache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\n\
Referrer-Policy: strict-origin-when-cross-origin\r\nContent-Security-Policy: {CSP}\r\n\
Connection: close\r\n\r\n",
        RELAY_HTML.len()
    )
    .into_bytes();
    out.extend_from_slice(RELAY_HTML.as_bytes());
    out
}

fn handle(mut stream: TcpStream, port: u16) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(5)));
    let mut buf = Vec::with_capacity(1024);
    let mut chunk = [0u8; 1024];
    // Read the request head only (it carries no body we need), bounded.
    while buf.len() < 16 * 1024 && !buf.windows(4).any(|w| w == b"\r\n\r\n") {
        match stream.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
        }
    }
    let request = String::from_utf8_lossy(&buf);
    let _ = stream.write_all(&respond(&request, port));
    let _ = stream.flush();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn get(path: &str, host: &str) -> String {
        String::from_utf8(respond(
            &format!("GET {path} HTTP/1.1\r\nHost: {host}\r\n\r\n"),
            4321,
        ))
        .unwrap()
    }

    #[test]
    fn serves_only_the_relay_page_to_its_own_host() {
        let ok = get("/youtube-relay.html?src=x", "localhost:4321");
        assert!(ok.starts_with("HTTP/1.1 200 OK"));
        assert!(ok.contains("Content-Security-Policy: default-src 'none'"));
        assert!(ok.ends_with(RELAY_HTML));
        assert!(get("/other", "localhost:4321").starts_with("HTTP/1.1 404"));
        // Only the name YouTube accepts.
        assert!(get("/youtube-relay.html", "127.0.0.1:4321").starts_with("HTTP/1.1 404"));
        // DNS rebinding: another host name pointing at the loopback address.
        assert!(get("/youtube-relay.html", "evil.example:4321").starts_with("HTTP/1.1 404"));
        let post = respond(
            "POST /youtube-relay.html HTTP/1.1\r\nHost: localhost:4321\r\n\r\n",
            4321,
        );
        assert!(String::from_utf8(post).unwrap().starts_with("HTTP/1.1 404"));
    }

    #[test]
    fn the_real_server_answers_on_loopback() {
        let url = relay_url().unwrap();
        let port: u16 = url
            .trim_start_matches("http://localhost:")
            .split('/')
            .next()
            .unwrap()
            .parse()
            .unwrap();
        let fetch = |addr: &str| {
            let mut s = TcpStream::connect((addr, port)).unwrap();
            write!(
                s,
                "GET {RELAY_PATH} HTTP/1.1\r\nHost: localhost:{port}\r\n\r\n"
            )
            .unwrap();
            let mut body = String::new();
            s.read_to_string(&mut body).unwrap();
            body
        };
        let body = fetch("127.0.0.1");
        assert!(body.starts_with("HTTP/1.1 200 OK"));
        assert!(body.contains("youtube-nocookie"));
        // IPv6 loopback too, where the system has it.
        if TcpStream::connect(("::1", port)).is_ok() {
            assert!(fetch("::1").starts_with("HTTP/1.1 200 OK"));
        }
        // Same server on a second call.
        assert_eq!(relay_url().unwrap(), url);
    }
}
