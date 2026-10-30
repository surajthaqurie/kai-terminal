import fs from "fs";
import path from "path";
import { IntegrationError, type IntegrationAccount } from "../../types";
import { runProcess, secretKeyFor, type Runner, type SecretStore } from "../../secretStore";
import {
  parseTokenSet,
  refreshTokenSet,
  serializeTokenSet,
  TOKEN_EXPIRY_MARGIN_MS,
  type OAuthDeps,
} from "./oauth";

/** The Azure DevOps resource id Entra tokens are requested for. */
export const ADO_RESOURCE_ID = "499b84ac-1321-427f-aa17-267ca6975798";

/** Refresh a cached Azure CLI token this long before it expires. */
const EXPIRY_MARGIN_MS = 5 * 60 * 1000;
const FALLBACK_TOKEN_LIFETIME_MS = 30 * 60 * 1000;

export interface AuthDeps {
  run?: Runner;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
  oauth?: OAuthDeps;
}

export interface AuthHeader {
  header: string;
  /** The raw secret, so callers can redact it from anything they log. */
  secret: string;
}

const azTokens = new Map<string, { token: string; expiresAt: number }>();
const inFlightAzTokens = new Map<string, Promise<string>>();
const inFlightOAuth = new Map<string, Promise<string>>();

/** Test seam: drop cached Azure CLI tokens. */
export function resetAzTokenCache(): void {
  azTokens.clear();
  inFlightAzTokens.clear();
  inFlightOAuth.clear();
}

export const LOGIN_HINT = "Run `kai integration azure` to sign in again.";

/**
 * Azure DevOps rejects a token that lacks a scope exactly like a bad one, so a
 * token account that signed in fine but is refused later most likely needs a scope.
 */
export const TOKEN_SCOPE_HINT =
  "Run `kai integration azure` to sign in again. If sign-in works but this keeps failing, the token is missing a scope: create a new one with Work Items, Code, Build and Project and Team (all Read).";

export function loginHintFor(account: IntegrationAccount): string {
  return account.authMethod === "pat" ? TOKEN_SCOPE_HINT : LOGIN_HINT;
}

/** True for Azure DevOps Services (`dev.azure.com`, `<org>.visualstudio.com`); false for a Server install. */
export function isCloudBaseUrl(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === "dev.azure.com" || host.endsWith(".visualstudio.com");
  } catch {
    return false;
  }
}

/** True when an `az` executable is on PATH. A file-stat walk: it never starts a process. */
export function azCliOnPath(env: NodeJS.ProcessEnv = process.env): boolean {
  const names = process.platform === "win32" ? ["az.cmd", "az.exe", "az.bat"] : ["az"];
  const dirs = (env.PATH ?? env.Path ?? "").split(path.delimiter).filter(Boolean);
  return dirs.some((dir) => names.some((n) => fs.existsSync(path.join(dir, n))));
}

async function azAccessToken(account: IntegrationAccount, deps: AuthDeps): Promise<string> {
  const now = (deps.now ?? Date.now)();
  const cached = azTokens.get(account.id);
  if (cached && cached.expiresAt - EXPIRY_MARGIN_MS > now) return cached.token;

  const inFlight = inFlightAzTokens.get(account.id);
  if (inFlight) return inFlight;

  const fetchPromise = (async () => {
    try {
      const run = deps.run ?? runProcess;
      const azArgs = [
        "account",
        "get-access-token",
        "--resource",
        ADO_RESOURCE_ID,
        "--output",
        "json",
      ];
      // `az` is a .cmd shim on Windows, which Node will not spawn directly.
      const result =
        process.platform === "win32"
          ? await run("cmd.exe", ["/d", "/s", "/c", "az", ...azArgs], { timeoutMs: 30_000 })
          : await run("az", azArgs, { timeoutMs: 30_000 });

      if (result.spawnError && result.code === null) {
        throw new IntegrationError(
          "auth",
          "The Azure CLI (az) could not be started.",
          "Install it from https://aka.ms/installazurecli, or sign in with an access token: `kai integration azure --pat-stdin`."
        );
      }
      if (result.code !== 0) {
        throw new IntegrationError(
          "auth",
          "The Azure CLI is not signed in.",
          "Run `az login`, then retry."
        );
      }
      let parsed: { accessToken?: unknown; expires_on?: unknown };
      try {
        parsed = JSON.parse(result.stdout);
      } catch {
        throw new IntegrationError("auth", "The Azure CLI returned an unreadable token response.");
      }
      if (typeof parsed.accessToken !== "string" || !parsed.accessToken) {
        throw new IntegrationError("auth", "The Azure CLI returned no access token.");
      }
      const expiresOn = Number(parsed.expires_on);
      const expiresAt =
        Number.isFinite(expiresOn) && expiresOn > 0
          ? expiresOn * 1000
          : now + FALLBACK_TOKEN_LIFETIME_MS;
      azTokens.set(account.id, { token: parsed.accessToken, expiresAt });
      return parsed.accessToken;
    } finally {
      inFlightAzTokens.delete(account.id);
    }
  })();

  inFlightAzTokens.set(account.id, fetchPromise);
  return fetchPromise;
}

/** A browser sign-in's access token, refreshed (and the rotated refresh token saved) when it is about to expire. */
async function oauthAccessToken(
  account: IntegrationAccount,
  secrets: SecretStore,
  deps: AuthDeps
): Promise<string> {
  const key = secretKeyFor(account.id);
  const tokens = parseTokenSet(await secrets.get(key));
  if (!tokens) {
    throw new IntegrationError(
      "auth",
      `Not signed in to ${account.org}.`,
      "Connect again from Kai's Integrations tab, or run `kai integration azure`."
    );
  }
  const now = (deps.oauth?.now ?? Date.now)();
  if (tokens.expiresAt - TOKEN_EXPIRY_MARGIN_MS > now) return tokens.accessToken;

  const pending = inFlightOAuth.get(account.id);
  if (pending) return pending;
  const refresh = (async () => {
    try {
      const next = await refreshTokenSet(tokens, { env: deps.env, ...deps.oauth });
      await secrets.set(key, serializeTokenSet(next));
      return next.accessToken;
    } finally {
      inFlightOAuth.delete(account.id);
    }
  })();
  inFlightOAuth.set(account.id, refresh);
  return refresh;
}

/**
 * The Authorization header for an account. `KAI_ADO_PAT` overrides the stored
 * token for PAT accounts, which keeps headless runs working without a store.
 * `patOverride` is used at login, before anything has been saved.
 */
export async function authHeaderFor(
  account: IntegrationAccount,
  secrets: SecretStore,
  deps: AuthDeps = {},
  patOverride?: string
): Promise<AuthHeader> {
  if (account.authMethod === "oauth") {
    const token = await oauthAccessToken(account, secrets, deps);
    return { header: `Bearer ${token}`, secret: token };
  }
  if (account.authMethod === "az") {
    const token = await azAccessToken(account, deps);
    return { header: `Bearer ${token}`, secret: token };
  }
  const env = deps.env ?? process.env;
  const pat =
    patOverride ?? env.KAI_ADO_PAT?.trim() ?? (await secrets.get(secretKeyFor(account.id)));
  if (!pat) {
    const target = isCloudBaseUrl(account.baseUrl)
      ? `--org ${account.org}`
      : `--server-url ${account.baseUrl}`;
    throw new IntegrationError(
      "auth",
      `No stored token for ${account.id}.`,
      `Run \`kai integration azure ${target} --pat-stdin\`.`
    );
  }
  return { header: `Basic ${Buffer.from(`:${pat}`).toString("base64")}`, secret: pat };
}
