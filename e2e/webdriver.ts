import { spawnSync } from "node:child_process";
import { readdirSync, readlinkSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Minimal W3C WebDriver client for driving the real Kai window through `tauri-driver` (CI-04).
 *
 * The protocol is plain HTTP + JSON, so this is a few dozen lines of `fetch` instead of a
 * WebdriverIO dependency tree. Only what the end-to-end specs use is implemented.
 */

const ELEMENT = "element-6066-11e4-a52e-4f735466cecf";

/** WebDriver key codes (W3C "keys" table). */
export const Key = {
  Enter: "",
  Escape: "",
  Shift: "",
  Control: "",
  Alt: "",
} as const;

export type ElementRef = { [ELEMENT]: string };

export class WebDriverError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(`${code}: ${message}`);
  }
}

export class Session {
  constructor(
    private readonly base: string,
    readonly id: string
  ) {}

  /**
   * Starts the app. Retried: on a cold start (the runtime and the debug binary read from a cold
   * disk) the driver can give up before the window is up.
   *
   * Every attempt starts from no running copy of the app under test: a copy left by an attempt
   * that failed (or by an earlier test) holds the app's single-instance lock, so the next launch
   * is handed to it and exits at once ("Chrome instance exited"), and every later test fails the
   * same way. Each attempt is also bounded, so a launch that never attaches fails here instead of
   * using up the whole hook timeout.
   */
  static async create(
    base: string,
    application: string,
    attempts = 3,
    attemptTimeoutMs = SESSION_TIMEOUT_MS
  ): Promise<Session> {
    let lastError: unknown;
    for (let i = 0; i < attempts; i++) {
      killApp(application);
      const started = Date.now();
      try {
        const value = await call<{ sessionId: string }>(
          base,
          "POST",
          "/session",
          { capabilities: { alwaysMatch: { "tauri:options": { application } } } },
          attemptTimeoutMs
        );
        return new Session(base, value.sessionId);
      } catch (err) {
        lastError = err;
        const retryable =
          err instanceof WebDriverError &&
          (err.code === "session not created" || err.code === "timeout");
        console.warn(
          `[e2e] session attempt ${i + 1}/${attempts} failed after ${Date.now() - started} ms: ` +
            (err instanceof Error ? err.message : String(err))
        );
        if (!retryable) break;
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    killApp(application);
    throw lastError;
  }

  private cmd<T>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<T> {
    return call<T>(this.base, method, `/session/${this.id}${path}`, body);
  }

  async quit(): Promise<void> {
    await this.cmd("DELETE", "");
  }

  /** Handles of the app's open windows. */
  windowHandles(): Promise<string[]> {
    return this.cmd<string[]>("GET", "/window/handles");
  }

  /** Sends the following commands to the window `handle`. */
  async switchToWindow(handle: string): Promise<void> {
    await this.cmd("POST", "/window", { handle });
  }

  execute<T>(script: string, ...args: unknown[]): Promise<T> {
    return this.cmd<T>("POST", "/execute/sync", { script, args });
  }

  async findAll(css: string): Promise<ElementRef[]> {
    return this.cmd<ElementRef[]>("POST", "/elements", { using: "css selector", value: css });
  }

  async find(css: string): Promise<ElementRef> {
    return this.cmd<ElementRef>("POST", "/element", { using: "css selector", value: css });
  }

  async click(el: ElementRef): Promise<void> {
    await this.cmd("POST", `/element/${el[ELEMENT]}/click`, {});
  }

  async type(el: ElementRef, text: string): Promise<void> {
    // WebKitWebDriver (Linux) rejects an empty `text` as missing; use `focus` to just focus.
    if (text === "") throw new Error("Session.type needs text; use Session.focus to focus");
    await this.cmd("POST", `/element/${el[ELEMENT]}/value`, { text });
  }

  /** Focuses `el` (for keyboard shortcuts that go to the focused element). */
  async focus(el: ElementRef): Promise<void> {
    await this.execute("arguments[0].focus();", el);
  }

  async text(el: ElementRef): Promise<string> {
    return this.cmd<string>("GET", `/element/${el[ELEMENT]}/text`);
  }

  async attribute(el: ElementRef, name: string): Promise<string | null> {
    return this.cmd<string | null>("GET", `/element/${el[ELEMENT]}/attribute/${name}`);
  }

  /** Presses `keys` together (modifiers first) and releases them in reverse order. */
  async chord(...keys: string[]): Promise<void> {
    const down = keys.map((value) => ({ type: "keyDown", value }));
    const up = [...keys].reverse().map((value) => ({ type: "keyUp", value }));
    await this.cmd("POST", "/actions", {
      actions: [{ type: "key", id: "keyboard", actions: [...down, ...up] }],
    });
    await this.cmd("DELETE", "/actions");
  }
}

/** How long one session start may take (msedgedriver itself gives up attaching after 60 s). */
export const SESSION_TIMEOUT_MS = 75_000;
/** Any other command: a hung webview must fail the probe, not block the test until its timeout. */
const COMMAND_TIMEOUT_MS = 30_000;

async function call<T>(
  base: string,
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown,
  timeoutMs = COMMAND_TIMEOUT_MS
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new WebDriverError(0, "timeout", `${method} ${path} had no answer in ${timeoutMs} ms`);
    }
    throw err;
  }
  const json = (await res.json().catch(() => ({}))) as {
    value?: T & { error?: string; message?: string };
  };
  const value = json.value;
  if (!res.ok || (value && typeof value === "object" && "error" in value && value.error)) {
    throw new WebDriverError(res.status, value?.error ?? "unknown error", value?.message ?? "");
  }
  return value as T;
}

/** Polls `probe` until it returns a truthy value or `timeoutMs` passes. */
export async function waitFor<T>(
  what: string,
  probe: () => Promise<T | null | undefined | false>,
  timeoutMs = 20_000,
  intervalMs = 200
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (err) {
      last = err;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  const reason = last instanceof Error ? last.message : last ? JSON.stringify(last) : "";
  throw new Error(
    `Timed out after ${timeoutMs} ms waiting for ${what}${reason ? ` (${reason})` : ""}`
  );
}

/**
 * Ends every running copy of the app under test, matched by its full executable path, so a Kai
 * the developer is running (another binary) is never touched. Synchronous and best effort.
 */
export function killApp(application: string): void {
  const target = resolve(application);
  if (process.platform === "win32") {
    // The path goes in through the environment: no quoting of it inside the script.
    spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath -ieq $env:KAI_E2E_KILL } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
      ],
      { env: { ...process.env, KAI_E2E_KILL: target }, stdio: "ignore", timeout: 30_000 }
    );
    return;
  }
  let pids: string[];
  try {
    pids = readdirSync("/proc").filter((d) => /^\d+$/.test(d));
  } catch {
    return; // no /proc (macOS): there is no WebDriver there anyway
  }
  for (const pid of pids) {
    try {
      if (readlinkSync(`/proc/${pid}/exe`) === target) process.kill(Number(pid), "SIGKILL");
    } catch {
      // gone already, or not ours to read
    }
  }
}
