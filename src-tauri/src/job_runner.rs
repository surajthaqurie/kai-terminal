//! Windows Job Object helper for `kai run` (see `runExternalAgentCommand` in
//! `src/core/codeModeWorkflow.ts`).
//!
//! On Windows a process that detaches from its parent (`DETACHED_PROCESS`, or
//! one whose launcher already exited) is not reachable by `taskkill /T`, and
//! Windows offers no way to find it by its environment (the Linux / macOS
//! sweep). A Job Object does: every process created by a process in the job
//! joins it too, however it was started, and the whole job can be stopped at
//! once. Node cannot create one, so the desktop binary does it:
//!
//! * `kai.exe --kai-job-probe` prints [`PROTOCOL`]: the CLI checks this before
//!   relying on the helper (an older desktop binary does not have it).
//! * `kai.exe --kai-job-run <job name> <command line>` creates the named job,
//!   starts the command suspended inside it, resumes it, waits for it and
//!   exits with its exit code. The command line is taken verbatim from this
//!   process's own command line, so the CLI's quoting reaches the child as is.
//! * `kai.exe --kai-job-kill <job name>` stops every process still in that job
//!   and exits 0 once none is left (2: no such job, 3: some still running).
//!
//! The job is not "kill on close": a command that exits normally may leave a
//! background process it started on purpose, as on Linux and macOS. Only a
//! timeout or an abort stops the job. A program may still explicitly ask to
//! leave the job (`CREATE_BREAKAWAY_FROM_JOB`); that stays allowed so such
//! programs keep working, and only those can escape.
//!
//! These flags are handled in `main` before anything else (the CLI-collision
//! guard, the window, the single-instance check), so the helper never opens a
//! window.

use std::process::exit;

pub const PROBE_FLAG: &str = "--kai-job-probe";
pub const RUN_FLAG: &str = "--kai-job-run";
pub const KILL_FLAG: &str = "--kai-job-kill";
/// What `--kai-job-probe` prints; the CLI compares it exactly.
pub const PROTOCOL: &str = "kai-job 1";

/// Job names the CLI generates: `kai-run-` and a UUID. Anything else is refused.
pub fn is_valid_job_name(name: &str) -> bool {
    match name.strip_prefix("kai-run-") {
        Some(id) => {
            !id.is_empty()
                && id.len() <= 64
                && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
        }
        None => false,
    }
}

/// Splits this process's raw command line into the job name and the child's
/// command line (everything after the name, verbatim).
pub fn split_run_command_line(raw: &str) -> Option<(String, String)> {
    let marker = format!(" {RUN_FLAG} ");
    let at = raw.find(&marker)? + marker.len();
    let (name, command) = raw[at..].split_once(' ')?;
    if !is_valid_job_name(name) || command.trim().is_empty() {
        return None;
    }
    Some((name.to_string(), command.to_string()))
}

/// The program at the start of a Windows command line, without its quotes.
pub fn program_token(command: &str) -> String {
    let s = command.trim_start();
    match s.strip_prefix('"') {
        Some(rest) => rest.split('"').next().unwrap_or("").to_string(),
        None => s.split([' ', '\t']).next().unwrap_or("").to_string(),
    }
}

/// Runs the helper when this process was started as one; returns otherwise.
pub fn handle_job_helper_args() {
    let mut args = std::env::args().skip(1);
    let Some(first) = args.next() else { return };
    match first.as_str() {
        PROBE_FLAG => {
            println!("{PROTOCOL}");
            exit(0);
        }
        RUN_FLAG => exit(imp::run()),
        KILL_FLAG => exit(imp::kill(&args.next().unwrap_or_default())),
        _ => {}
    }
}

#[cfg(not(windows))]
mod imp {
    pub fn run() -> i32 {
        eprintln!("kai: the job helper exists only on Windows");
        1
    }
    pub fn kill(_name: &str) -> i32 {
        1
    }
}

#[cfg(windows)]
mod imp {
    use super::{is_valid_job_name, program_token, split_run_command_line};
    use std::ffi::OsString;
    use std::os::windows::ffi::{OsStrExt, OsStringExt};
    use std::path::Path;
    use std::ptr::{null, null_mut};
    use windows_sys::core::BOOL;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, TRUE, WAIT_OBJECT_0};
    use windows_sys::Win32::System::Console::{
        AttachConsole, GetStdHandle, SetConsoleCtrlHandler, ATTACH_PARENT_PROCESS,
        STD_ERROR_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE,
    };
    use windows_sys::Win32::System::Environment::GetCommandLineW;
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectBasicAccountingInformation,
        JobObjectExtendedLimitInformation, OpenJobObjectW, QueryInformationJobObject,
        SetInformationJobObject, TerminateJobObject, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_BREAKAWAY_OK,
    };
    use windows_sys::Win32::System::Threading::{
        CreateProcessW, GetExitCodeProcess, ResumeThread, TerminateProcess, WaitForSingleObject,
        CREATE_NO_WINDOW, CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT, INFINITE,
        PROCESS_INFORMATION, STARTF_USESTDHANDLES, STARTUPINFOW,
    };

    // Job access rights (winnt.h); not exported by windows-sys.
    const JOB_OBJECT_QUERY: u32 = 0x0004;
    const JOB_OBJECT_TERMINATE: u32 = 0x0008;

    fn wide(s: &str) -> Vec<u16> {
        std::ffi::OsStr::new(s)
            .encode_wide()
            .chain(Some(0))
            .collect()
    }

    fn job_path(name: &str) -> Vec<u16> {
        wide(&format!("Local\\{name}"))
    }

    fn raw_command_line() -> String {
        unsafe {
            let p = GetCommandLineW();
            if p.is_null() {
                return String::new();
            }
            let mut len = 0usize;
            while *p.add(len) != 0 {
                len += 1;
            }
            OsString::from_wide(std::slice::from_raw_parts(p, len))
                .to_string_lossy()
                .into_owned()
        }
    }

    /// Ctrl+C / Ctrl+Break reach every process on the console. The command
    /// decides what they mean; this helper only waits for it, so it must not
    /// die of them (that would orphan the command from `kai run`). A handler
    /// routine, unlike "ignore Ctrl+C", is not inherited by the command.
    unsafe extern "system" fn ignore_ctrl(_ctrl_type: u32) -> BOOL {
        TRUE
    }

    pub fn run() -> i32 {
        let raw = raw_command_line();
        let Some((name, command)) = split_run_command_line(&raw) else {
            eprintln!("kai: invalid job helper invocation");
            return 1;
        };
        unsafe {
            // Taken before attaching: these are the handles `kai run` gave us.
            let stdin = GetStdHandle(STD_INPUT_HANDLE);
            let stdout = GetStdHandle(STD_OUTPUT_HANDLE);
            let stderr = GetStdHandle(STD_ERROR_HANDLE);
            // The desktop binary is a GUI program with no console of its own;
            // join `kai run`'s, so the command runs in the same terminal.
            // (A console build is attached already: that fails with access denied.)
            let has_console = AttachConsole(ATTACH_PARENT_PROCESS) != 0
                || std::io::Error::last_os_error().raw_os_error() == Some(5);
            SetConsoleCtrlHandler(Some(ignore_ctrl), TRUE);

            let job = CreateJobObjectW(null(), job_path(&name).as_ptr());
            if job.is_null() {
                eprintln!("kai: could not create the job for the command");
                return 1;
            }
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_BREAKAWAY_OK;
            SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const _,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );

            let mut si: STARTUPINFOW = std::mem::zeroed();
            si.cb = std::mem::size_of::<STARTUPINFOW>() as u32;
            si.dwFlags = STARTF_USESTDHANDLES;
            si.hStdInput = stdin;
            si.hStdOutput = stdout;
            si.hStdError = stderr;
            let mut pi: PROCESS_INFORMATION = std::mem::zeroed();
            // An absolute program path is passed as the application name, so
            // Windows does not look for it next to this binary first.
            let program = program_token(&command);
            let app = if Path::new(&program).is_absolute() && Path::new(&program).is_file() {
                Some(wide(&program))
            } else {
                None
            };
            let mut cmd = wide(&command);
            let mut flags = CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT;
            if !has_console {
                // No terminal to share: never pop up a console window.
                flags |= CREATE_NO_WINDOW;
            }
            let ok = CreateProcessW(
                app.as_ref().map_or(null(), |a| a.as_ptr()),
                cmd.as_mut_ptr(),
                null(),
                null(),
                TRUE,
                flags,
                null(),
                null(),
                &si,
                &mut pi,
            );
            if ok == 0 {
                let err = std::io::Error::last_os_error();
                eprintln!("kai: could not start {program}: {err}");
                CloseHandle(job);
                return 1;
            }
            if AssignProcessToJobObject(job, pi.hProcess) == 0 {
                // Without the job the command would run unguarded, which `kai
                // run` would then report wrongly as fully stoppable.
                let err = std::io::Error::last_os_error();
                eprintln!("kai: could not put the command in a job: {err}");
                TerminateProcess(pi.hProcess, 1);
                close_all(&[pi.hThread, pi.hProcess, job]);
                return 1;
            }
            ResumeThread(pi.hThread);
            let mut code: u32 = 1;
            if WaitForSingleObject(pi.hProcess, INFINITE) == WAIT_OBJECT_0 {
                GetExitCodeProcess(pi.hProcess, &mut code);
            }
            close_all(&[pi.hThread, pi.hProcess, job]);
            code as i32
        }
    }

    unsafe fn close_all(handles: &[HANDLE]) {
        for h in handles {
            if !h.is_null() {
                CloseHandle(*h);
            }
        }
    }

    fn active_processes(job: HANDLE) -> Option<u32> {
        unsafe {
            let mut info: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = std::mem::zeroed();
            let ok = QueryInformationJobObject(
                job,
                JobObjectBasicAccountingInformation,
                &mut info as *mut _ as *mut _,
                std::mem::size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                null_mut(),
            );
            (ok != 0).then_some(info.ActiveProcesses)
        }
    }

    pub fn kill(name: &str) -> i32 {
        if !is_valid_job_name(name) {
            return 1;
        }
        unsafe {
            let job = OpenJobObjectW(
                JOB_OBJECT_TERMINATE | JOB_OBJECT_QUERY,
                0,
                job_path(name).as_ptr(),
            );
            if job.is_null() {
                // The helper and its job are already gone: nothing left to stop.
                return 2;
            }
            TerminateJobObject(job, 1);
            // Termination is asynchronous; wait (bounded) until the job is empty.
            let mut empty = false;
            for _ in 0..40 {
                if active_processes(job) == Some(0) {
                    empty = true;
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(25));
            }
            CloseHandle(job);
            if empty {
                0
            } else {
                3
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_generated_job_names() {
        assert!(is_valid_job_name(
            "kai-run-0f6c2a1e-1b2c-4d5e-8f90-123456789abc"
        ));
        assert!(!is_valid_job_name("kai-run-"));
        assert!(!is_valid_job_name("other-0f6c"));
        assert!(!is_valid_job_name("kai-run-..\\Global\\x"));
        assert!(!is_valid_job_name(&format!("kai-run-{}", "a".repeat(65))));
    }

    #[test]
    fn splits_the_child_command_line_verbatim() {
        let raw = r#"C:\Program Files\Kai\kai.exe --kai-job-run kai-run-ab12 "C:\a b\claude.exe" --x "y z""#;
        let (name, cmd) = split_run_command_line(raw).unwrap();
        assert_eq!(name, "kai-run-ab12");
        assert_eq!(cmd, r#""C:\a b\claude.exe" --x "y z""#);
        assert!(split_run_command_line("kai.exe --kai-job-run bad-name cmd").is_none());
        assert!(split_run_command_line("kai.exe --kai-job-run kai-run-ab12 ").is_none());
        assert!(split_run_command_line("kai.exe code .").is_none());
    }

    #[test]
    fn finds_the_program_token() {
        assert_eq!(program_token(r#""C:\a b\x.exe" --y"#), r"C:\a b\x.exe");
        assert_eq!(program_token(r"C:\tools\x.exe --y"), r"C:\tools\x.exe");
        assert_eq!(
            program_token("powershell.exe -File s.ps1"),
            "powershell.exe"
        );
    }
}
