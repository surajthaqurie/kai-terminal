# Reliability and Security Audit

Repository `kai-terminal` @ `50f4c8c`, audited 2026-11-23. No source file was changed. The project's documented security model and non-goals (no telemetry, no SSH, no credential persistence in config, no remote execution; Shared Agent listening on the LAN and the `kai <agent>` feature are intended) were read first (`SECURITY.md`, `KNOWN_LIMITATIONS.md`, `README.md`) and **are not flagged as defects**.
Host for all measurements: Windows 11 build 26300. **Nothing was run on macOS or Linux**; Unix findings are code-traced (*Likely*).

Format of each finding: **Category / Severity / Confidence** · **Location** · **Root cause** · **Repro** · **Impact (user / technical)** · **Fix (complexity)** · **Verify**. † = the lead auditor re-read the cited code.

## 1. Concurrency and lifecycle audit (brief §9) — summary

| Topic | Result |
|---|---|
| Concurrent PTY reads/writes | **Good.** Per-session writer mutex; the 1 MiB paste never holds the manager lock; input is byte-exact, chunked, rejected not truncated; unit-tested. |
| Create/close/resize races | **Two lock-scope defects:** REL-01 (lock held while dropping the master) and REL-02 (lock held across native resize). `close_pty` and `close_all` do it correctly (remove under lock, kill outside). |
| Event subscription lifecycle | **Good.** One shared `listen` per event per window with ref-counting; `listenersCancelled` pattern; no StrictMode; effects idempotent. Gap: spawn is not ordered after Tauri-side listener registration (REL-09). |
| Stale async callbacks | **Good.** `initSeqRef` supersedes in-flight spawns/adopts and reaps orphaned PTYs; `createPty` 20 s timeout reaps a late session; old exit ignored after respawn. |
| Out-of-order events | cwd events can replay stale values (PERF-03); output vs exit ordering is guaranteed (reader→coalescer join before `pty-exit`); hand-off ordering held by `HandoffGate` + frontend early-event replay. |
| State updates after unmount | No instance found by trace. |
| Duplicate handlers | One real instance: the search shortcut is handled by both the xterm key handler and the window handler (FUNC-01). |
| Deadlocks | One potential (REL-01). No lock is held across an `.await` (all `std::sync::Mutex`). |
| Lock contention | Global `sessions` mutex (REL-01/02); tokio worker saturation by blocking commands (PERF-05). |
| Mutex poisoning | **Good.** Non-test lock sites map the poison error or use `into_inner`; release `panic="abort"` means no poisoning; remaining panic sources are in vendored deps (`portable-pty` `lock().unwrap()`), guarded by the ConPTY build check. |
| Shutdown races | **Good.** Hide windows → reap on a worker thread bounded by 1.5 s (`finish_within`, unit-tested incl. a panicking job) → `process::exit(0)`; `Destroyed` closes sessions off the event thread. |
| Process ownership / orphans | **Measured on Windows:** foreground children die on `close_pty`/`close_all` (`test_15/15b` poll real PIDs); hard-killing the host removed the console-attached `cmd`+`ping` tree; a `Start-Process` child survives tab close (no Job Object for tab shells — same as Windows Terminal; document it, REL-11). |

## 2. Reliability findings

### REL-01† — Global `sessions` mutex is held while the PTY master is dropped (`ClosePseudoConsole`)
- **Reliability / High (potential) / Likely** — code re-read and confirmed; the blocking behaviour of `ClosePseudoConsole` is asserted by the repo's own comments (`shutdown.rs:10-13`, `lib.rs:84-86`) and could not be reproduced because this host (build 26300) is newer than the builds where it blocks.
- **Location:** `src-tauri/src/pty.rs:709-717` (waiter thread in `create_pty`); reader lock sites `pty.rs:637,666`.
- **Root cause:** `let mut sessions = sessions_map.lock().ok(); if let Some(mut session) = sessions.as_mut().and_then(|s| s.remove(id)) { session.status = …; }` — `session` (owning `master`) is dropped at the end of the `if let` block while the `MutexGuard` declared outside it is still alive. On Windows, dropping `master` calls `ClosePseudoConsole`, which can wait for output to be drained. The drainer is the reader thread, which blocks if it is at `sessions_map_ref.lock()` (taken whenever an OSC cwd differs from `last_emitted_cwd`, which PERF-03 makes frequent).
- **Repro (on Windows 10 / 11 ≤ 23H2 VM):** PowerShell tab, run `cd ..; exit` in a loop while other tabs type. Natural trigger: typing `exit` right after `cd` (final bytes contain an OSC 9;9 report).
- **Impact:** user — permanent loss of input/resize/create/close for **every** tab until the app is restarted (quit still works because of the 1.5 s reap budget); technical — deadlock cycle waiter→ClosePseudoConsole→reader→lock.
- **Fix (S):** remove the entry under the lock, drop the guard, then drop the session: `let removed = sessions_map.lock().ok().and_then(|mut s| s.remove(id)); drop(removed);` (the pattern `close_pty` already uses, `pty.rs:847-863`).
- **Verify:** unit test with an injected master whose `Drop` blocks, asserting `list_sessions()` still returns; the VM repro above.

### REL-02 — `resize_pty` holds the global lock across the native resize
- **Reliability / Low / Confirmed.** `pty.rs:806-832`: `master.resize` (`ResizePseudoConsole`/`TIOCSWINSZ`) under the manager-wide mutex, so a drag-resize (150 ms per pane) briefly blocks every other session's write lookup/create/close. **Fix (S):** wrap master in `Arc<Mutex<…>>`, clone under the map lock, resize outside (same lesson already applied to the writer). **Verify:** unit test with a master whose `resize` sleeps.

### REL-03 — A spurious `pty-exit` (code 1) follows every explicit close
- **Reliability / Low / Confirmed (measured).** `pty.rs:706-727`: the waiter always emits `pty-exit`, even after `close_pty`/`close_all`/window destroy removed the session; the code is the `TerminateProcess(…, 1)` value, indistinguishable from a real `exit 1` (`probe2.rs`: `[Some(1)]`). The frontend filters by backend id and `useSessionExit` is idempotent, so impact is minimal (a recycled tab id could mis-handle it; it also feeds the crash-loop counter, FUNC-09). **Fix (S):** `closed_by_user: Arc<AtomicBool>`; skip or flag the event. **Verify:** unit test that an explicit close emits no crash-coded exit.

### REL-04 — On Unix, `close_pty` sends only SIGHUP and never escalates
- **Reliability / Low–Medium / Likely** (not run on Unix). `pty.rs:855-858` → portable-pty `ProcessSignaller::kill` = `libc::kill(pid, SIGHUP)`; no SIGKILL, no process-group kill, no wait. **Impact:** a shell or foreground job that traps/ignores SIGHUP survives after the entry has been removed (UI thinks it is closed; shell, three threads and fds linger until app exit). **Fix (M):** after a ~500 ms grace period off-thread, `killpg(pgid, SIGKILL)` via `master.process_group_leader()`. **Verify:** Linux test with `trap '' HUP; sleep 300`, then `close_pty`, assert the process is gone.

### REL-05 — Any read error, `Interrupted` included, ends the reader
- **Reliability / Low / Needs measurement.** `pty.rs:680` (`Err(_) => break`). EINTR is unlikely (SA_RESTART) but would silently stop output while the shell keeps running. **Fix (S):** `Err(e) if e.kind() == Interrupted => continue`. **Verify:** simulated-reader unit test.

### REL-06 — Invalid byte mid-buffer corrupts a legitimately split multibyte character
- **Reliability / Low / Confirmed (trace).** `split_valid_utf8` (`pty.rs:1640-1644`): on `error_len() == Some` the whole buffer including a valid split trailing sequence is lossy-converted and cleared, so the split char becomes two U+FFFD across batches. Design limit: output is always lossy-decoded (non-UTF-8 byte streams cannot round-trip). **Fix (S):** lossy-convert only up to the last incomplete sequence. **Verify:** invalid-byte-then-split unit test.

### REL-07 — Unix: the login-shell PATH lookup blocks startup and can hang forever
- **Reliability / Medium / Likely** (no macOS/Linux host).
- **Location:** `src-tauri/src/login_path.rs:64-121`, called synchronously at `lib.rs:767` before the window exists (GUI launches).
- **Root cause:** `$SHELL -ilc` runs the user's full interactive rc on the main thread; the 5 s limit bounds the *shell process* only — afterwards `reader.join()` (`:97`) waits for EOF on stdout, so an rc that backgrounds a process inheriting stdout (`foo &`, `emacs --daemon`) keeps the pipe open and startup never proceeds; `child.kill()` kills only the shell.
- **Repro:** rc containing `sleep 30 &` then measure time to first window.
- **Impact:** user — app appears not to start, or starts seconds late on nvm-heavy shells; technical — side effects of an interactive rc (prompts, `exec tmux`) on every launch.
- **Fix (S):** run on a background thread and merge PATH when ready (or `recv_timeout` and abandon the reader), cache the result on disk and revalidate in the background, prefer `-lc` before `-i`.
- **Verify:** the `sleep 30 &` rc test; time-to-window with an nvm-heavy zshrc.

### REL-08 — Tab hand-off rough edges
- **Reliability / Low / Needs measurement.** Fixed 60 ms "output in flight" settle (`tabHandoff.ts:117,216`); snapshot carries ≤4,000 rows even if scrollback is larger (`TerminalView.tsx:147,449-451`); if adoption fails, Retry spawns a **new** shell while the moved session keeps running with no UI (`:1287-1292,1578-1581,1355`); closing the tab mid-move lets the old pane's unmount close the PTY before `handoffRelease` (`useTabDetach.ts:51-52`); `adoptSession` can call `handleExit` twice (`:1282-1283`), double-counting a crash. **Good:** ordered protocol, rollback, bounded 8 MiB hold gate. **Fix (S–M):** per-item; **Verify:** hand-off failure/close-mid-move tests with the real `TerminalView`.

### REL-09 — Spawn is not ordered after Tauri-side listener registration
- **Reliability / Low–Medium / Needs measurement.** `TerminalView.tsx:1159-1196` registers listeners fire-and-forget while the spawn starts at 60 ms (`:1317-1320`); `ptyEarlyEvents` covers the gap between spawn start and the `create_pty` reply, not a gap before the Tauri-side listener exists, so on a cold start with a busy main thread the first prompt could be lost (blank pane until a key). **Fix (S):** `await Promise.all` of the three subscription promises before the first `create_pty`. **Verify:** delay `listen` by 150 ms in a test and check that the first prompt arrives.

### REL-10 — `std::env::set_var` from a startup thread on Unix
- **Reliability / Medium–Low / Likely.** `kai_cli.rs:326` (`prepend_current_process_path`) and `login_path.rs:119`: mutating the process environment while other threads (WebKitGTK/GLib, `Command` spawns) read it is undefined-behaviour territory (`set_var` is `unsafe` in Rust 2024). **Fix (S):** apply PATH only to spawned children via `cmd.env("PATH", …)`, or before any thread starts. **Verify:** thread-sanitizer run on Linux (optional).

### REL-11 — Windows tab shells are not in a Job Object (document, don't change)
- **Reliability / Low (informational) / Confirmed (measured).** A `Start-Process ping -Hidden` child survived `close_pty` (ping.exe count 2→1); foreground children died. Matches Windows Terminal and respects deliberately detached servers; adding `KILL_ON_JOB_CLOSE` would kill them. **Action (S):** state it in `USER_MANUAL.md`. Job Object code in `job_runner.rs` (used by `kai run`) was reviewed and is sound.

### REL-12 — A mutex is held across blocking pipe I/O in `SharedAgentService`
- **Reliability / Low / Likely.** `shared_agent.rs:~236-254` writes to the child's stdin while holding `running`; a Node process that stops reading blocks `stop()` and other requests (the exit path runs `stop()` on its own thread, so quitting is safe). **Fix (S):** write outside the lock or with a timeout. **Verify:** stuck-child test.

## 3. Security findings

### SEC-01 — Windows: `noCwdLookupEnv()` does not stop the cwd binary lookup; a planted exe in the project folder runs
- **Security / High / Confirmed (reproduced on this host).** † mitigation code re-read.
- **Location:** `src/core/spawnSafety.ts:15-17`; affected call sites: `core/integrations/providers/azure-devops/auth.ts:94-102`, `cli/desktopApp.ts:116,127,254,289-301`, `cli/commands/integration.ts:194`, `core/githooks.ts:83,94,108`, `core/integrations/config.ts:128`, `core/agents.ts:835`, `core/integrations/service.ts:85`, `core/codeModeWorkflow.ts:1664,1837`, `cli/teams/open.ts:17`, `azure-devops/oauth.ts:200`, `core/sharedAgent/agentRunner.ts:219`.
- **Root cause:** the mitigation sets `NoDefaultCurrentDirectoryInExePath=1` in the **child's** environment. For a direct `spawn("name")`, libuv resolves the executable inside the **parent** (in the cwd first) and honours that variable only when it is set in the parent's own environment. A bare `spawn("cmd.exe")`, `spawn("powershell")`, `execFileSync("git")`, `spawnSync("taskkill")` or `rundll32` still finds a same-named `.exe` in the current folder; `execSync("where kai.exe")` goes through `cmd.exe`, which resolves `where` in the cwd.
- **Repro:** a throw-away Node script (a throw-away script, not kept in the repository) (planted exe = a copy of `hostname.exe`, harmless): with the parent variable **unset**, planted `cmd.exe`, `az.exe`, `powershell.exe`, `where.exe` ran even with the variable in the child env; with it set in the parent the real tool ran. *This harness exports the variable for tool processes, which hides the bug under Claude Code; a normal terminal or GUI launch does not.*
- **Impact:** user — cloning or unzipping an untrusted repo containing `cmd.exe`/`git.exe`/`where.exe`/`taskkill.exe`/`powershell.exe` and running `kai code .`, `kai run`, `kai integration azure`, or letting an agent start `kai mcp` there executes it with the user's rights; technical — RES-02 makes the MCP case automatic and repeated (a planted `git.exe` runs every 2 s); a planted `az` can forge token output.
- **Fix (S–M):** (1) at CLI/MCP startup on win32 set `process.env.NoDefaultCurrentDirectoryInExePath = "1"` in the **parent** and keep the child copy; (2) absolute paths for fixed system tools (`%SystemRoot%\System32\{cmd,taskkill,where,rundll32}.exe`, the WindowsPowerShell path as `secretStore.ts:164` already does); (3) resolve `git` once with a PATH-only walk (`isCommandAvailable` style, which never looks in cwd) and spawn the absolute path; (4) a Windows CI test that plants an exe in cwd and asserts it is not run.
- **Verify:** rerun the experiments with `env -u NoDefaultCurrentDirectoryInExePath`; unit-test the resolver. Rust `Command::new` on Windows does not search cwd (confirmed good).

### SEC-02 — The updater runs a downloaded installer with no signature or hash check, from a predictable temp path
- **Security / High (Linux root path) / Medium (Windows, macOS) / Confirmed (code).**
- **Location:** `src-tauri/src/updater.rs:111-113` (`temp_dir()/kai-update-<name>`), `:195-292` (download; `File::create` `:230`; redirect limit 10 `:211`, redirect hosts not re-validated), `:316-332,:459-484` (Windows `Start-Process … /S`, `msiexec /qn` via `powershell -ExecutionPolicy Bypass -File`), `:362-367` (Linux `pkexec sh -c 'apt-get install -y "$1" || dpkg -i "$1"'`), `:338-355` (macOS: swap `.app`, `xattr -dr com.apple.quarantine`).
- **Root cause:** trust rests on TLS to github.com, a repo-prefix allow-list (`validate_update_asset_url`), and an unauthenticated GitHub API read in the webview. `release.yml` signs Windows/macOS only when secrets exist and **nothing in the app verifies a signature**; `TAURI_SIGNING_PRIVATE_KEY` is handed to the bundler but the app does not use the Tauri updater plugin.
- **Repro:** Linux: pre-create `/tmp/kai-update-<name>.deb` as a symlink or swap it between download and the `pkexec` click (not exploited here).
- **Impact:** user — Linux: a local unprivileged user can swap the file (TOCTOU) or use a pre-planted symlink for an arbitrary-file overwrite as the victim; a compromised release/token delivers a silent installer; any caller of `download_update_asset_cmd` can choose an older release (no anti-downgrade); macOS: quarantine stripped from what was just downloaded; technical — `schedule_app_exit` kills the app 2 s after spawning the helper regardless of helper success.
- **Fix (M):** publish `SHA256SUMS` + a detached signature (minisign/ed25519) with an embedded public key; download into a per-user `0700` directory with `create_new`; verify hash+signature before launch and re-verify path ownership at launch; enforce version > current in Rust; add a size cap and re-validate each redirect hop. Alternatively adopt `tauri-plugin-updater`.
- **Verify:** tamper test (one flipped byte must be refused); Linux pre-created-symlink test; CI check that release assets carry a valid signature.

### SEC-03 — Automatic `git status` on `cd` executes repo-configured commands (`core.fsmonitor`)
- **Security / Medium / Confirmed (reproduced, git 2.43.0.windows.1).**
- **Location:** `src-tauri/src/git.rs:153-157` (`status --porcelain`), `:573-651` (`run_git_bounded`); triggered from `useGitStatus.ts` on every directory change (300 ms dwell), focus and after each submitted command.
- **Root cause:** git is run in the user's current folder honouring that folder's `.git/config`; `core.fsmonitor` (and `diff.external`/textconv, `core.pager`) name programs git executes; `safe.directory` only protects against a different owner and an extracted/copied folder is owned by the user.
- **Repro:** `git init r; git config core.fsmonitor 'sh -c "echo pwned > ../pwned.txt; exit 0"'; git -c core.quotepath=off status --porcelain` creates `pwned.txt`. Kai issues that command as soon as a pane enters the folder.
- **Impact:** user — `cd` into a downloaded repo with a crafted `.git/config` runs attacker code without a prompt (many prompt tools share this; VS Code gates it behind Workspace Trust); technical — arbitrary code execution as the user.
- **Fix (S):** add `-c core.fsmonitor=false -c core.untrackedCache=false --no-optional-locks` to all background probes; `--no-ext-diff --no-textconv` for diffs; optionally a one-time trust prompt per repo.
- **Verify:** rerun the reproduction against the fixed command; no file written.

### SEC-04 — App commands are not capability-gated (no app ACL manifest), contrary to `SECURITY.md`
- **Security / Medium / Confirmed.**
- **Location:** `src-tauri/build.rs:35-40` (`Attributes::new()` with no `AppManifest`), `gen/schemas/acl-manifests.json` (zero `__app-acl__` entries), `capabilities/{default,music-pip,shared-chat}.json` (only `core:*`), `lib.rs:885-949` (60+ handlers).
- **Root cause:** Tauri restricts app-defined commands only when `tauri_build::AppManifest::new().commands(&[…])` is declared. All handlers (`create_pty`, `write_to_pty`, `run_integration_rpc_cmd`, `setup_agent_mcp_cmd`, `download_update_asset_cmd`, `launch_update_installer_cmd`, `read_clipboard_attachments_cmd`, …) are callable from **every** window that loads the bundle, including `music-pip` (hosts a third-party YouTube iframe, always on top) and `shared-chat`. `SECURITY.md` §2 says capabilities restrict IPC to the main window — true only for core/plugin permissions.
- **Repro:** from the `music-pip` window DevTools, `__TAURI_INTERNALS__.invoke("create_pty", …)` should be rejected (today it is not). Whether a nested remote iframe can invoke app commands depends on Tauri 2.12.2's frame origin check (not verified).
- **Impact:** user — any script-execution bug in a secondary window is arbitrary process execution; technical — the real boundary is webview script integrity (`script-src 'self'`; no `eval`/`innerHTML` found in non-test `src`), so this is defence in depth.
- **Fix (S–M):** declare the command list in `build.rs`, define permission sets, grant only `get_app_version`, `music_relay_url`, window-drag etc. to `music-pip`/`shared-chat`; keep `create_pty`, installers and integration RPC to `main`/`term-*`.
- **Verify:** the DevTools invoke test before/after.

### SEC-05 — Sensitive-file filter is keyed on the symlink's own name
- **Security / Medium / Likely** (code-traced; file symlinks could not be created on this host).
- **Location:** `src/core/indexer.ts:699,893` (`isSensitiveFile(entry.name)` on the directory entry), `src/core/mcpTools.ts:182-196` (`checkRelativePath`: name/basename, then only realpath **confinement** to the project root).
- **Root cause:** an in-project `notes.txt -> .env` (or `-> id_rsa`, `credentials.json`) passes the name test, stays inside the project, and is indexed and readable via `kai_read_range`/`kai_get_context`; only the content scan remains, which judges key-like values, not ordinary passwords.
- **Repro:** Linux/macOS: create `notes.txt -> .env`, index, call `kai_read_range`.
- **Impact:** user — a repository that commits such an alias can put secrets into an agent's context, contradicting `SECURITY.md`/`KNOWN_LIMITATIONS` ("cannot be retrieved by MCP tools"); technical — filter bypass.
- **Fix (S):** apply `isSensitiveFile` to the basename of the **resolved realpath** in both the scan and `checkRelativePath`; optionally skip file symlinks.
- **Verify:** Linux CI test asserting index omission and `kai_read_range` refusal.

### SEC-06† — Every typed line is recorded in `localStorage` for a feature nothing uses
- **Security/Privacy / Medium / Confirmed (†).**
- **Location:** `src/components/TerminalView.tsx:258-300` (`trackInputData`/`commitLine`), `:264-265` (`recordCommand` + `saveCommandHistory` on Enter), `:916-980`; `src/services/autocomplete.ts:119-172`; `cacheJanitor.ts:35` explicitly preserves the key.
- **Root cause:** the line is reconstructed from raw `onData` with no knowledge of echo state or the alternate screen, so anything typed then Enter is committed: a passphrase typed at a no-echo prompt, text typed into a TUI/AI-CLI chat, a pasted secret. `recordCommand` only filters `password|secret|token|api_key = value` assignments. The plaintext list (200 entries, `kai_cmd_history_v1`) is rewritten synchronously on every Enter. `getCompletions`/`completionRemainder` are referenced only by tests (the in-code comment says suggestions are intentionally not shown). Each pane loads its own copy at mount and overwrites the whole key, so panes clobber each other's entries.
- **Repro:** `sudo -k; sudo ls`, type a password, inspect `localStorage["kai_cmd_history_v1"]` in DevTools.
- **Impact:** user — secrets at rest in unencrypted WebView storage; technical — a synchronous `localStorage` write + `JSON.stringify` per Enter for dead data.
- **Fix (S):** delete the recording path (keep `autocomplete.ts` only if a UI ships); if kept: skip on the alternate buffer and no-echo prompts, merge-on-write across panes, opt-in.
- **Verify:** the password-prompt repro shows no new entry; existing `autocomplete.test.ts` adjusted.

### SEC-07 — CSP is broader than needed and out of sync with `SECURITY.md`
- **Security / Low–Medium / Confirmed (config).** `src-tauri/tauri.conf.json:27`: `connect-src` allows `*.youtube.com`, `*.youtube-nocookie.com`, `*.googlevideo.com`, `*.google.com` although the webview itself fetches only `api.github.com` and `ipc:`; wildcards under `google.com` include user-hosted surfaces (a post-XSS exfiltration channel); `frame-src http://localhost:*` lets the app frame any local service (needed only for the macOS/Linux music relay, whose port is known at runtime); `style-src 'unsafe-inline'` is required by xterm/React (residual CSS-injection risk). `script-src 'self'`, `default-src 'self'`, no `unsafe-eval` are good. **Fix (S):** drop media/Google hosts from `connect-src`; scope `frame-src` dynamically or document it; update `SECURITY.md`. **Verify:** `tauriCsp.test.ts` extended to the narrow policy.

### SEC-08 — Agent-config auto-wire accepts a webview-supplied launcher and rewrites config files without preserving mode
- **Security / Low–Medium / Confirmed (code).** `lib.rs:440-450` (`setup_agent_mcp_cmd(id, launcher: Vec<String>, …)`), `ai_cli.rs:382-480` (`validate_launcher` checks existence only; any `.js` or runnable binary plus ≤7 args written verbatim), `:815-828,927-936` (temp file written with default permissions then renamed over the original). **Impact:** a compromised webview can persist an arbitrary command into `~/.claude.json`, `~/.codex/config.toml` etc. (defence-in-depth, as the PTY already allows execution); a `0600` config (may hold other MCP servers' API keys) becomes `0644` on Unix; `.kai.bak` is overwritten on every forced re-wire so a second `force` replaces the real original with a modified copy; no `fsync` before rename (the Node side does it right, `agents.ts:1204`). **Fix (S):** ignore `launcher` and resolve it in Rust via `get_kai_cli_launch()`; copy original permissions to the temp file; keep the first backup. **Verify:** unit test on file mode (Unix) and backup preservation.

### SEC-09 — Windows User PATH edited through PowerShell on every launch; Unix rc files edited without consent
- **Security/Reliability / Low–Medium / Likely.** `kai_cli.rs:381-410,531-603`, `lib.rs:836-846`: when `kai` is not on the persisted PATH a read-modify-write `SetEnvironmentVariable('Path',…,'User')` runs; .NET reads a `REG_EXPAND_SZ` PATH expanded and writes `REG_SZ`, flattening `%VAR%` entries (this host's HKCU PATH is `REG_EXPAND_SZ` and contains `%LOCALAPPDATA%\agy\bin`) — **not reproduced** (it would modify the registry; verify on a throw-away profile). Unix `ensure_rc_path` (`:433-476`) appends `export PATH="$HOME/.local/bin:$PATH"` to `.bashrc`, `.zshrc`, `.profile`, putting a user-writable directory ahead of system directories. **Fix (S):** read/write the registry preserving type, make the edit opt-in or one-time (recorded in `~/.kai`), append rather than prepend. **Verify:** throw-away profile with a `REG_EXPAND_SZ` PATH before/after.

### SEC-10 — Git hygiene: optional locks and pathspec magic
- **Security/Reliability / Low / Likely.** `git.rs:579-595` — `GIT_OPTIONAL_LOCKS=0` not set, so Kai's `status` (on focus and after every command) can make a concurrent user `git commit` fail with `index.lock`; `git.rs:232-298` `validate_repo_rel_path` rejects `..`, absolute and leading `-` but not magic pathspecs (`*`, `[id].tsx`, `:(top)`, `.`) — `discard_git_file` with `.` runs `git restore -- .`. **Fix (S):** `--no-optional-locks`, `GIT_LITERAL_PATHSPECS=1`. **Verify:** concurrent commit + probe loop; literal-name test with `[id].tsx`.

### SEC-11 — Shared Agent: unauthenticated session kill by forged cleartext session id
- **Security / Low / Confirmed (code).** `hostServer.ts:793-799`: a sealed call whose AEAD check fails deletes the session (`this.sessions.delete(sid)`); the id is cleartext (documented), so a LAN observer can end it with one forged POST. Availability only; confidentiality/integrity hold. **Fix (S):** count failures and drop after N per session. Other DoS bounds are good (timeouts, body/session/device caps, per-address rate limits); missing `server.maxConnections` and an idle keep-alive tuning. **Verify:** forged-POST test.

### SEC-12 — The cwd is taken from untrusted OSC 7 / 9;9 output without host or existence checks
- **Security / Low / Likely.** `pty.rs:1362-1396,633-646`: any program output (a `cat`'d file, an `ssh` remote emitting OSC 7 with its own hostname — the host part is discarded, `:1373`) overwrites `handle.cwd`, which feeds `get_pty_cwd`, new-tab cwd and the git panel (so SEC-03 can be pointed at an attacker-chosen *existing* local directory). **Fix (S):** accept OSC 7 only when host is empty/`localhost`/the local hostname and the path `is_dir()`. **Verify:** unit tests with a remote host.

### SEC-13 — Secret-handling nits
- **Security / Low / Confirmed.** Windows DPAPI `set` passes the base64 secret in the child PowerShell's **environment** (`KAI_SECRET_B64`, `secretStore.ts:132,217-219`), visible to same-user processes for ~1 s (argv/`ps` exposure is avoided; `SECURITY.md` says "piped on stdin"); the composite store silently falls back to a `0600` plaintext file on any OS-store error (reported to the CLI; `0600` is a no-op on Windows, which inherits the profile ACL); clipboard text is held in a static `Mutex<Option<(u64, String)>>` until the frontend calls `end` (a crash between begin and end leaves it, possibly a password, in memory); `decode()` makes 2–3 copies so a multi-hundred-MB paste can briefly use several times its size (Needs measurement). **Fix (S):** pass the secret via stdin to PowerShell; make the fallback visible in UI; zero/clear clipboard state on a timer. **Verify:** doc and unit checks.

### SEC-14 — Documentation drift
- **Security / Low / Confirmed.** (1) `SECURITY.md` §2 documents the narrow CSP; shipped CSP is broader (SEC-07). (2) "capabilities restrict IPC to the main window" — see SEC-04. (3) The "Exposed IPC Commands" list misses ~25 commands. (4) "token piped on stdin" vs environment variable on Windows (SEC-13). (5) `KNOWN_LIMITATIONS` says "Kai installs no git hooks" while `githooks.ts`/README:159 install a `commit-msg` hook that deletes every `Co-authored-by:` trailer (including human co-authors). (6) `SECURITY.md` says `kai run` `.ps1` runs without `-ExecutionPolicy Bypass` (true) but the updater helper and DPAPI both use it (`updater.rs:464-466`, `secretStore.ts:187`). (7) No threat-model statement for the updater. Also undocumented-in-privacy-statement: Kai edits VS Code/Cursor/VSCodium/Windsurf `settings.json` at startup (README:224; opt-out env var only), and the two launch-time network contacts (RES-07). **Fix (S):** update the docs; add a doc-drift checklist to `RELEASE_GUIDE.md`.

## 4. Unsafe Rust inventory
All `unsafe` is confined to Windows/macOS FFI; none in PTY, git, updater, clipboard or networking.

| File:line | What | Soundness |
|---|---|---|
| `call_watch.rs:196` | CoreAudio `AudioObjectGetPropertyData` (macOS) | Sound; return code checked |
| `job_runner.rs:139-318` | Win32 job objects, `CreateProcessW`, console handlers | Sound; handles closed on all paths; names validated (`kai-run-<hex-uuid>`); notes: `SetInformationJobObject` result ignored, `TerminateProcess` on assign failure |
| `snap_layouts.rs:~200-413` | Windows 11 snap-layouts overlay window proc, `RtlGetVersion`, `SetWindowPos` | Sound with SAFETY comments; risk: callback invoked while holding `NOTIFY` inside the window procedure (re-entrancy would deadlock); a panic there aborts (panic=abort) |
| `autostart.rs:288-308` | `env::set_var/remove_var` in `#[cfg(test)]` | Test-only |
Production `std::env::set_var` (`kai_cli.rs:326`, `login_path.rs:119`) is the equivalent hazard (REL-10).

## 5. Panic, error-handling and persistence hygiene
- Release `panic="abort"`. Non-test `unwrap/expect` in the audited modules: `lib.rs:951` (`expect` while building the app, startup only), `ai_cli.rs:822,895-896` (`serde_json::to_string(...).unwrap()` on `Value`/`Vec<String>` — cannot fail); `pty.rs:1255,1380` indexing after length checks; `flatpak_host_argv` returns non-empty when `Some`. Overall panic hygiene is **good**.
- Persistence: Node side uses `atomicWriteJson` (tmp+rename with Windows retries); `editor_terminal.rs` writes `settings.json` with tmp+rename, a one-time backup, refuses unparseable files; `save_state` for `editor_profiles.json` is a plain `fs::write` (a torn write only re-offers the profile — Low). Invalid JSON configs are handled (agent configs >1 MB or invalid are never rewritten).
- Unbounded growth: PTY channel (PERF-01); `agentRunner.ts` stdout line buffer (trusted binary); clipboard session (documented); `hostServer` maps are capped.
- Threads per event: no unbounded per-event leak found (`run_git_bounded` one short-lived thread per call; `integrations.rs` three per request; music relay one per connection with 5 s timeouts).
- Local servers: music relay is loopback-only with a `Host` check (DNS-rebinding safe), request head 16 KB, 5 s timeouts, **no connection cap** (Low); Shared Agent host is opt-in `0.0.0.0` with X25519 + HKDF + AES-GCM and invite PSK (documented); MCP is stdio only with a 10 MB line cap; no other listening sockets found.

## 6. Dependency security
`npm audit --omit=dev`: 0 vulnerabilities; full `npm audit`: 1 high (`undici` via `jsdom`, test-only); `kai-website` has 2 (next, postcss) and is not in CI; **`cargo audit`/`cargo deny` were not installed, so Rust advisories were not checked** — see CI-03.

## 7. What is done well (do not "fix")
Argv-only spawning everywhere with careful `.cmd` shim quoting and strict URL allow-lists; bounded timeouts with kill-and-reap on every probe; OS-store-first secrets, never in argv; atomic writes; Shared Agent E2EE design (AAD binds session+direction, counter nonces, replay window after authentication, low-order point rejection, constant-time compares); loopback relay with Host check; per-user `0700` paste directory with ownership checks; telemetry that is genuinely local (`metrics.jsonl`, 5 MB rotation); bounded shutdown; no sensitive data logged in the PTY path; `secretStore.ts:162-166` already pins PowerShell by absolute path.
