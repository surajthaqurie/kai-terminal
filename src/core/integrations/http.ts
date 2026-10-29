import { IntegrationError } from "./types";

/**
 * One small HTTP client for every provider: bounded time and size, retry on
 * throttling, and errors that never carry request headers or credentials.
 */
export interface HttpRequest {
  url: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: unknown;
  accept?: string;
  timeoutMs?: number;
  maxBytes?: number;
  /** Strings that must never appear in an error message (tokens, passwords). */
  redact?: string[];
  /** What to tell the user when the credential is rejected (the provider knows its own login command). */
  authHint?: string;
}

export interface HttpResponse {
  status: number;
  text: string;
  json<T>(): T;
}

export interface HttpDeps {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const MAX_RETRIES = 2;
const MAX_RETRY_WAIT_MS = 8_000;
const RETRYABLE = new Set([429, 502, 503, 504]);

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function redactSecrets(text: string, secrets: readonly string[] = []): string {
  let out = text;
  for (const s of secrets) {
    if (s.length >= 4) out = out.split(s).join("[redacted]");
  }
  return out;
}

function retryDelayMs(res: Response, attempt: number): number {
  const header = Number(res.headers.get("retry-after"));
  const base = Number.isFinite(header) && header > 0 ? header * 1000 : 500 * 2 ** attempt;
  return Math.min(base, MAX_RETRY_WAIT_MS);
}

/** Pull a human message out of a provider error body without echoing arbitrary markup. */
function messageFrom(text: string, secrets: readonly string[]): string {
  let msg = "";
  try {
    const parsed = JSON.parse(text) as { message?: unknown };
    if (typeof parsed.message === "string") msg = parsed.message;
  } catch {
    // not JSON: stay silent rather than echo HTML
  }
  return redactSecrets(msg.replace(/\s+/g, " ").trim(), secrets).slice(0, 300);
}

export async function httpRequest(req: HttpRequest, deps: HttpDeps = {}): Promise<HttpResponse> {
  const doFetch = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? defaultSleep;
  const maxBytes = req.maxBytes ?? DEFAULT_MAX_BYTES;
  const secrets = req.redact ?? [];

  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), req.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    let res: Response;
    try {
      res = await doFetch(req.url, {
        method: req.method ?? "GET",
        headers: {
          accept: req.accept ?? "application/json",
          ...(req.body !== undefined ? { "content-type": "application/json" } : {}),
          ...req.headers,
        },
        body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
        redirect: "manual",
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      const aborted = err instanceof Error && err.name === "AbortError";
      throw new IntegrationError(
        "network",
        aborted
          ? "The request timed out."
          : `Could not reach the server: ${redactSecrets(err instanceof Error ? err.message : String(err), secrets)}`,
        "Check the network connection and the organization URL."
      );
    }

    if (RETRYABLE.has(res.status) && attempt < MAX_RETRIES) {
      clearTimeout(timer);
      await sleep(retryDelayMs(res, attempt));
      continue;
    }

    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) {
      clearTimeout(timer);
      throw new IntegrationError("bad_request", "The response is too large to read safely.");
    }
    let text: string;
    try {
      text = await res.text();
    } catch {
      throw new IntegrationError("network", "The connection dropped while reading the response.");
    } finally {
      clearTimeout(timer);
    }
    if (text.length > maxBytes) {
      throw new IntegrationError("bad_request", "The response is too large to read safely.");
    }

    // Azure DevOps answers a bad or expired credential with a redirect or an
    // HTML sign-in page (often HTTP 203) instead of a clean 401.
    const contentType = res.headers.get("content-type") ?? "";
    if (
      res.status === 401 ||
      res.status === 203 ||
      (res.status >= 300 && res.status < 400) ||
      (res.ok &&
        contentType.includes("text/html") &&
        (req.accept ?? "application/json").includes("json"))
    ) {
      throw new IntegrationError(
        "auth",
        "The server did not accept the credential (sign-in required).",
        req.authHint ?? "Sign in again."
      );
    }
    if (res.status === 403) {
      throw new IntegrationError(
        "forbidden",
        `Access denied. ${messageFrom(text, secrets)}`.trim(),
        "The token may lack the needed scope (read for work items, code and build)."
      );
    }
    if (res.status === 404) {
      throw new IntegrationError(
        "not_found",
        `Not found. ${messageFrom(text, secrets)}`.trim(),
        "Check the organization, project, repository and id."
      );
    }
    if (res.status === 429) {
      throw new IntegrationError(
        "rate_limited",
        "The server is throttling requests.",
        "Retry shortly."
      );
    }
    if (!res.ok) {
      const detail = messageFrom(text, secrets);
      throw new IntegrationError(
        res.status >= 500 ? "network" : "bad_request",
        `HTTP ${res.status}${detail ? `: ${detail}` : ""}`
      );
    }

    return {
      status: res.status,
      text,
      json<T>(): T {
        try {
          return JSON.parse(text) as T;
        } catch {
          throw new IntegrationError("bad_request", "The server returned an unreadable response.");
        }
      },
    };
  }
}
