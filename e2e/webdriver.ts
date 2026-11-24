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
   * Starts the app. Retried: on a cold start (a brand-new WebView2 profile is being created)
   * msedgedriver can give up attaching with "DevToolsActivePort file doesn't exist".
   */
  static async create(base: string, application: string, attempts = 3): Promise<Session> {
    let lastError: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        const value = await call<{ sessionId: string }>(base, "POST", "/session", {
          capabilities: { alwaysMatch: { "tauri:options": { application } } },
        });
        return new Session(base, value.sessionId);
      } catch (err) {
        lastError = err;
        if (!(err instanceof WebDriverError) || err.code !== "session not created") throw err;
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    throw lastError;
  }

  private cmd<T>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<T> {
    return call<T>(this.base, method, `/session/${this.id}${path}`, body);
  }

  async quit(): Promise<void> {
    await this.cmd("DELETE", "");
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
    await this.cmd("POST", `/element/${el[ELEMENT]}/value`, { text });
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

async function call<T>(
  base: string,
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown
): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as {
    value?: T & { error?: string; message?: string };
  };
  const value = json.value as (T & { error?: string; message?: string }) | undefined;
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
  throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}${last ? ` (${last})` : ""}`);
}
