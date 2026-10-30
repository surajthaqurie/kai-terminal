import crypto from "crypto";
import http from "http";
import type { AddressInfo } from "net";
import { spawn } from "child_process";
import { httpRequest, redactSecrets, type HttpDeps } from "../../http";
import { IntegrationError, type IntegrationUser } from "../../types";

/**
 * Browser sign-in for Azure DevOps: OAuth 2.0 authorization code + PKCE against
 * Microsoft Entra, with a one-shot loopback listener for the redirect. No secret
 * ships with the app (a public client), and the user never types an organization
 * or a token: the organizations are read from the signed-in account.
 */

/** The Azure DevOps resource id Entra tokens are requested for. */
const ADO_RESOURCE_ID = "499b84ac-1321-427f-aa17-267ca6975798";

/**
 * Kai's Entra app registration (a public client). Set at release time; a build or
 * a developer machine can override it with `KAI_AZURE_CLIENT_ID`.
 * See docs/azure-devops-sign-in.md.
 */
export const KAI_AZURE_CLIENT_ID = "";

const AUTHORITY = "https://login.microsoftonline.com/common/oauth2/v2.0";
const SCOPE = `${ADO_RESOURCE_ID}/user_impersonation offline_access`;
const VSSPS = "https://app.vssps.visualstudio.com";
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DEFAULT_SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 20_000;
/** Refresh an access token this long before it expires. */
export const TOKEN_EXPIRY_MARGIN_MS = 2 * 60 * 1000;

export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

export interface OAuthDeps {
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  /** Test seam: replaces opening the system browser. */
  openUrl?: (url: string) => void;
  signInTimeoutMs?: number;
  http?: HttpDeps;
}

export interface BrowserLoginOptions {
  /** Called with the sign-in address before the browser is opened, so it can be shown as a fallback. */
  onUrl?: (url: string) => void;
}

export interface BrowserLoginResult {
  /** The serialized token set to keep in the secret store. */
  secret: string;
  user: IntegrationUser;
  /** Organization names the signed-in account belongs to. */
  orgs: string[];
}

export function clientIdFrom(env: NodeJS.ProcessEnv = process.env): string {
  const id = (env.KAI_AZURE_CLIENT_ID?.trim() || KAI_AZURE_CLIENT_ID).trim();
  if (!GUID.test(id)) {
    throw new IntegrationError(
      "config",
      "Browser sign-in is not set up in this build of Kai.",
      "Register the Kai app in Microsoft Entra and set KAI_AZURE_CLIENT_ID (see docs/azure-devops-sign-in.md)."
    );
  }
  return id;
}

const b64url = (buf: Buffer): string => buf.toString("base64url");

export function serializeTokenSet(t: TokenSet): string {
  return JSON.stringify(t);
}

export function parseTokenSet(raw: string | null): TokenSet | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<TokenSet>;
    if (
      typeof v.accessToken === "string" &&
      typeof v.refreshToken === "string" &&
      typeof v.expiresAt === "number" &&
      v.accessToken &&
      v.refreshToken
    ) {
      return { accessToken: v.accessToken, refreshToken: v.refreshToken, expiresAt: v.expiresAt };
    }
  } catch {
    // fall through
  }
  return null;
}

/** Opens `url` in the user's browser. Arguments are never passed through a shell. */
export function openInBrowser(url: string, platform: NodeJS.Platform = process.platform): void {
  if (!/^https:\/\//i.test(url)) return;
  const [cmd, args] =
    platform === "win32"
      ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
      : platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true, windowsHide: true });
    child.on("error", () => {
      // No browser available: the caller already showed the address.
    });
    child.unref();
  } catch {
    // Same: the address is shown as a fallback.
  }
}

const PAGE = (title: string, body: string): string =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>` +
  `<style>body{font:16px system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0;color:#222}` +
  `main{text-align:center;max-width:28rem;padding:1rem}</style></head>` +
  `<body><main><h1>${title}</h1><p>${body}</p></main></body></html>`;

interface Callback {
  code: string;
  redirectUri: string;
  verifier: string;
}

/** Start the listener, show/open the sign-in address, and wait for the redirect. */
async function waitForCallback(
  clientId: string,
  deps: OAuthDeps,
  opts: BrowserLoginOptions
): Promise<Callback> {
  const verifier = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  const state = b64url(crypto.randomBytes(24));

  return new Promise<Callback>((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const server = http.createServer();

    const finish = (err: IntegrationError | null, value?: Callback) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      // Let the browser receive the page before the socket goes away.
      setTimeout(() => server.close(), 200).unref();
      server.closeIdleConnections?.();
      if (err) reject(err);
      else resolve(value!);
    };

    server.on("error", () =>
      finish(
        new IntegrationError(
          "network",
          "Could not start the local sign-in listener.",
          "Check that a firewall is not blocking local connections, then try again."
        )
      )
    );

    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      const redirectUri = `http://localhost:${port}/`;

      server.on("request", (req, res) => {
        const url = new URL(req.url ?? "/", redirectUri);
        if (req.method !== "GET" || url.pathname !== "/") {
          res.writeHead(404).end();
          return;
        }
        const error = url.searchParams.get("error");
        const code = url.searchParams.get("code");
        if (url.searchParams.get("state") !== state || (!code && !error)) {
          res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
          res.end(PAGE("Sign-in not recognized", "Go back to Kai and start the sign-in again."));
          return;
        }
        if (error || !code) {
          const detail = redactSecrets(
            (url.searchParams.get("error_description") ?? error ?? "").replace(/\s+/g, " ")
          ).slice(0, 300);
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          res.end(
            PAGE("Sign-in was not completed", "You can close this tab and try again in Kai.")
          );
          finish(
            new IntegrationError(
              "auth",
              error === "access_denied"
                ? "Sign-in was cancelled."
                : `Microsoft did not complete the sign-in${detail ? `: ${detail}` : "."}`,
              "Connect again."
            )
          );
          return;
        }
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(PAGE("You are signed in", "You can close this tab and return to Kai."));
        finish(null, { code, redirectUri, verifier });
      });

      const authUrl = new URL(`${AUTHORITY}/authorize`);
      authUrl.search = new URLSearchParams({
        client_id: clientId,
        response_type: "code",
        redirect_uri: redirectUri,
        response_mode: "query",
        scope: SCOPE,
        state,
        code_challenge: challenge,
        code_challenge_method: "S256",
        prompt: "select_account",
      }).toString();

      timer = setTimeout(
        () =>
          finish(
            new IntegrationError(
              "auth",
              "Sign-in timed out waiting for the browser.",
              "Connect again and finish signing in within a few minutes."
            )
          ),
        deps.signInTimeoutMs ?? DEFAULT_SIGN_IN_TIMEOUT_MS
      );
      timer.unref?.();

      opts.onUrl?.(authUrl.toString());
      (deps.openUrl ?? openInBrowser)(authUrl.toString());
    });
  });
}

async function tokenRequest(
  clientId: string,
  form: Record<string, string>,
  deps: OAuthDeps,
  secrets: string[]
): Promise<TokenSet> {
  const doFetch = deps.fetchImpl ?? fetch;
  const now = (deps.now ?? Date.now)();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res: Response;
  let text: string;
  try {
    res = await doFetch(`${AUTHORITY}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ client_id: clientId, scope: SCOPE, ...form }).toString(),
      signal: controller.signal,
    });
    text = await res.text();
  } catch {
    throw new IntegrationError(
      "network",
      "Could not reach Microsoft to finish signing in.",
      "Check the network connection."
    );
  } finally {
    clearTimeout(timer);
  }

  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // handled below
  }
  if (!res.ok || typeof body.access_token !== "string") {
    const code = typeof body.error === "string" ? body.error : "";
    const detail = redactSecrets(
      String(body.error_description ?? "")
        .replace(/\s+/g, " ")
        .trim(),
      secrets
    ).slice(0, 300);
    if (code === "invalid_grant" || code === "interaction_required") {
      throw new IntegrationError(
        "auth",
        "Your Azure DevOps sign-in has expired.",
        "Connect again from Kai's Integrations tab, or run `kai integration azure`."
      );
    }
    if (code === "invalid_client" || code === "unauthorized_client") {
      throw new IntegrationError(
        "config",
        "Microsoft does not recognize Kai's sign-in app.",
        `Check KAI_AZURE_CLIENT_ID and the app registration (docs/azure-devops-sign-in.md).${detail ? ` ${detail}` : ""}`
      );
    }
    throw new IntegrationError(
      "auth",
      `Microsoft did not accept the sign-in${detail ? `: ${detail}` : "."}`,
      "Connect again."
    );
  }
  const refreshToken =
    typeof body.refresh_token === "string" && body.refresh_token
      ? body.refresh_token
      : (form.refresh_token ?? "");
  if (!refreshToken) {
    throw new IntegrationError(
      "auth",
      "Microsoft returned no way to stay signed in.",
      "Connect again."
    );
  }
  const lifetime = Number(body.expires_in);
  return {
    accessToken: body.access_token,
    refreshToken,
    expiresAt: now + (Number.isFinite(lifetime) && lifetime > 0 ? lifetime : 3600) * 1000,
  };
}

/** Trade a refresh token for a fresh access token (and the rotated refresh token). */
export function refreshTokenSet(current: TokenSet, deps: OAuthDeps = {}): Promise<TokenSet> {
  const clientId = clientIdFrom(deps.env);
  return tokenRequest(
    clientId,
    { grant_type: "refresh_token", refresh_token: current.refreshToken },
    deps,
    [current.refreshToken, current.accessToken]
  );
}

/** The signed-in user and every organization they belong to. */
async function discoverAccount(
  accessToken: string,
  deps: OAuthDeps
): Promise<{ user: IntegrationUser; orgs: string[] }> {
  const request = (url: string) =>
    httpRequest(
      {
        url,
        headers: { authorization: `Bearer ${accessToken}` },
        redact: [accessToken],
        authHint: "Connect again.",
      },
      deps.http
    );
  type Profile = { id?: string; displayName?: string; emailAddress?: string };
  const profile = (
    await request(`${VSSPS}/_apis/profile/profiles/me?api-version=7.1`)
  ).json<Profile>();
  if (!profile.id) {
    throw new IntegrationError("bad_request", "Azure DevOps did not return a profile.");
  }
  const accounts = (
    await request(
      `${VSSPS}/_apis/accounts?memberId=${encodeURIComponent(profile.id)}&api-version=7.1`
    )
  ).json<{ value?: Array<{ accountName?: unknown }> }>();
  const orgs = (accounts.value ?? [])
    .map((a) => a.accountName)
    .filter((n): n is string => typeof n === "string" && n.length > 0);
  if (orgs.length === 0) {
    throw new IntegrationError(
      "not_found",
      "This Microsoft account has no Azure DevOps organizations.",
      "Sign in with the account you use at dev.azure.com."
    );
  }
  return {
    user: {
      name: profile.displayName ?? profile.emailAddress ?? "signed-in user",
      ...(profile.emailAddress ? { email: profile.emailAddress } : {}),
    },
    orgs,
  };
}

/** Open the browser, wait for the redirect, and return what to store plus who signed in. */
export async function signInWithBrowser(
  opts: BrowserLoginOptions = {},
  deps: OAuthDeps = {}
): Promise<BrowserLoginResult> {
  const clientId = clientIdFrom(deps.env);
  const callback = await waitForCallback(clientId, deps, opts);
  const tokens = await tokenRequest(
    clientId,
    {
      grant_type: "authorization_code",
      code: callback.code,
      redirect_uri: callback.redirectUri,
      code_verifier: callback.verifier,
    },
    deps,
    [callback.code, callback.verifier]
  );
  const { user, orgs } = await discoverAccount(tokens.accessToken, deps);
  return { secret: serializeTokenSet(tokens), user, orgs };
}
