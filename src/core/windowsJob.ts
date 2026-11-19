import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

/**
 * Windows Job Object support for `kai run` (the Windows counterpart of
 * `processSweep.ts`).
 *
 * A Windows process that detached from the command (`DETACHED_PROCESS`, or one
 * whose launcher already exited) is out of reach of `taskkill /T`, and Windows
 * cannot find it by its environment. A Job Object catches it: every process a
 * process in the job creates joins the job, and the whole job can be stopped
 * at once. Node cannot create one, so the desktop binary does
 * (`src-tauri/src/job_runner.rs`):
 *
 *   kai.exe --kai-job-probe                    prints JOB_HELPER_PROTOCOL
 *   kai.exe --kai-job-run <name> <command line> runs the command in job <name>
 *   kai.exe --kai-job-kill <name>              stops everything still in it
 *
 * Without the desktop app (a CLI installed from npm only) the helper is
 * missing and `kai run` keeps the old `taskkill /T` behavior.
 */
export const JOB_HELPER_PROTOCOL = "kai-job 1";

export function newJobName(): string {
  return `kai-run-${randomUUID()}`;
}

/**
 * Quote one argument for a Windows command line so the program's C runtime
 * splits it back exactly (the same rules libuv uses for `child_process`).
 */
export function quoteWindowsArg(arg: string): string {
  if (arg === "") return '""';
  if (!/[\s"]/.test(arg)) return arg;
  let out = '"';
  let backslashes = 0;
  for (const ch of arg) {
    if (ch === "\\") {
      backslashes++;
      continue;
    }
    if (ch === '"') {
      // Backslashes before a quote are doubled, and the quote is escaped.
      out += "\\".repeat(backslashes * 2 + 1) + '"';
    } else {
      out += "\\".repeat(backslashes) + ch;
    }
    backslashes = 0;
  }
  // Trailing backslashes are doubled so they do not escape the closing quote.
  return out + "\\".repeat(backslashes * 2) + '"';
}

/**
 * The full command line for `command` + `args`. With `verbatim` the args are
 * already quoted for the OS (a `cmd.exe /c` line) and are joined as they are;
 * the program path is always quoted.
 */
export function windowsCommandLine(command: string, args: string[], verbatim = false): string {
  const program = quoteWindowsArg(command);
  const rest = verbatim ? args : args.map(quoteWindowsArg);
  return [program, ...rest].join(" ");
}

/** How `--kai-job-kill` ended. */
export type JobKillResult = "stopped" | "no-such-job" | "still-running" | "failed";

export interface JobHelperDeps {
  run?: typeof spawnSync;
}

/** True when `helper` is a desktop binary that speaks this protocol. */
export function probeJobHelper(helper: string, deps: JobHelperDeps = {}): boolean {
  try {
    const r = (deps.run ?? spawnSync)(helper, ["--kai-job-probe"], {
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return r.status === 0 && String(r.stdout ?? "").trim() === JOB_HELPER_PROTOCOL;
  } catch {
    return false;
  }
}

/** Stops every process still in job `name`. */
export function killJob(helper: string, name: string, deps: JobHelperDeps = {}): JobKillResult {
  try {
    const r = (deps.run ?? spawnSync)(helper, ["--kai-job-kill", name], {
      timeout: 10000,
      windowsHide: true,
      stdio: "ignore",
    });
    switch (r.status) {
      case 0:
        return "stopped";
      case 2:
        return "no-such-job";
      case 3:
        return "still-running";
      default:
        return "failed";
    }
  } catch {
    return "failed";
  }
}
