import {
  authorizeInBrowser,
  clientIdFrom,
  requestToken,
  serializeTokenSet,
  type BrowserLoginOptions,
  type OAuthApp,
  type OAuthDeps,
  type TokenSet,
} from "../integrations/providers/azure-devops/oauth";
import { ADMIN_APPROVAL_MESSAGE, isUsableClientId } from "../integrations/oauthRegistration";
import { IntegrationError } from "../integrations/types";
import { getSavedTeamsClientId } from "./config";
import { GRAPH_BASE, graphRequest, type GraphDeps } from "./graph";

/**
 * Browser sign-in for Microsoft Teams: the same OAuth 2.0 code + PKCE flow as
 * Azure DevOps (a public client, no secret shipped), asking Microsoft Graph for
 * chat permissions instead.
 *
 * Scopes are split on purpose. The base set is what any user may consent to;
 * reading CHANNEL history (`ChannelMessage.Read.All`) needs an administrator's
 * approval in most organizations, and asking for it in the first sign-in would
 * block everyone whose admin has not approved it. It is requested only when the
 * user passes `--channels`.
 */

/**
 * A Teams-only client ID baked into a build from `KAI_BUILD_TEAMS_CLIENT_ID`. Empty unless
 * the build sets it: Teams then shares the Azure DevOps app. See `teamsClientId`.
 */
export const KAI_TEAMS_CLIENT_ID: string =
  typeof __KAI_BUILD_TEAMS_CLIENT_ID__ === "string" ? __KAI_BUILD_TEAMS_CLIENT_ID__ : "";

export const BASE_SCOPES = [
  "User.Read",
  "Team.ReadBasic.All",
  "Channel.ReadBasic.All",
  "Chat.ReadWrite",
  "ChannelMessage.Send",
  "Files.ReadWrite",
  "offline_access",
] as const;

/** Needs administrator consent in most tenants. */
export const CHANNEL_READ_SCOPE = "ChannelMessage.Read.All";

export function scopesFor(withChannelHistory: boolean): string[] {
  return withChannelHistory ? [...BASE_SCOPES, CHANNEL_READ_SCOPE] : [...BASE_SCOPES];
}

export function teamsApp(withChannelHistory: boolean): OAuthApp {
  return {
    scope: scopesFor(withChannelHistory)
      .map((s) => (s === "offline_access" ? s : `https://graph.microsoft.com/${s}`))
      .join(" "),
    product: "Microsoft Teams",
    reconnect: "Run `kai integration teams` to sign in again.",
  };
}

/** What to do when no Microsoft app is known: one place, so every surface says the same thing. */
export const TEAMS_SETUP_HINT =
  "Register a Microsoft Entra app (docs/teams-sign-in.md), then run: kai integration teams --client-id <Application (client) ID>";

/**
 * The Entra app id, first match wins:
 *  1. `KAI_TEAMS_CLIENT_ID` in the environment (CI, testing);
 *  2. the ID saved on this computer by `kai integration teams --client-id`;
 *  3. a Teams-only ID built into Kai;
 *  4. the registration Azure DevOps sign-in uses (`KAI_AZURE_CLIENT_ID`, or built in).
 */
export function teamsClientId(env: NodeJS.ProcessEnv = process.env): string {
  const envId = env.KAI_TEAMS_CLIENT_ID?.trim();
  if (envId && !isUsableClientId(envId)) {
    throw new IntegrationError(
      "config",
      "KAI_TEAMS_CLIENT_ID is not a valid client ID.",
      "Set it to the Application (client) ID of your Entra app (a GUID, not an example value), or remove it to use the saved or built-in app."
    );
  }
  if (envId) return envId;

  const saved = readSavedClientId();
  if (saved) return saved;

  const built = KAI_TEAMS_CLIENT_ID.trim();
  if (built) {
    if (isUsableClientId(built)) return built;
    throw new IntegrationError("config", "The Teams client ID built into Kai is not valid.");
  }
  try {
    return clientIdFrom(env);
  } catch (err) {
    // A malformed KAI_AZURE_* value is its own problem; do not hide it as "not set up".
    if (err instanceof IntegrationError && /^KAI_AZURE_/.test(err.message)) throw err;
    throw new IntegrationError(
      "config",
      "Microsoft Teams sign-in is not set up yet: Kai has no Microsoft Entra app ID.",
      TEAMS_SETUP_HINT
    );
  }
}

/**
 * The saved ID when it is usable; a damaged, malformed or example value (an older Kai saved
 * whatever was typed) reads as "none saved", so the person is asked again instead of being
 * sent to a Microsoft error page.
 */
function readSavedClientId(): string | null {
  try {
    const saved = getSavedTeamsClientId();
    return saved && isUsableClientId(saved) ? saved : null;
  } catch {
    return null;
  }
}

/** The `scp` (granted permissions) claim of an access token; [] when unreadable. */
export function scopesFromAccessToken(jwt: string): string[] {
  try {
    const payload = jwt.split(".")[1];
    if (!payload) return [];
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      scp?: unknown;
    };
    return typeof claims.scp === "string" ? claims.scp.split(/\s+/).filter(Boolean) : [];
  } catch {
    return [];
  }
}

export interface TeamsSignIn {
  /** Serialized token set for the secret store. */
  secret: string;
  user: { id: string; name: string; email?: string };
  scopes: string[];
}

export interface TeamsSignInDeps extends OAuthDeps {
  graph?: GraphDeps;
}

/**
 * Open the browser, wait for the redirect, and read who signed in.
 *
 * Reading channel messages is asked for by default: it is part of Teams, so nobody
 * should have to turn it on. Most organizations need an administrator to approve that
 * one permission. When Microsoft says so, the sign-in is repeated once without it, so
 * chats and sending to channels still work; the account then reads as "channel
 * messages: no" until an administrator approves and the person connects again.
 * `channelHistory: false` skips asking for it at all.
 */
export async function signInToTeams(
  opts: BrowserLoginOptions & { channelHistory?: boolean } = {},
  deps: TeamsSignInDeps = {}
): Promise<TeamsSignIn> {
  const asked = opts.channelHistory !== false;
  try {
    return await signInWith(asked, opts, deps);
  } catch (err) {
    const adminOnly = err instanceof IntegrationError && err.message === ADMIN_APPROVAL_MESSAGE;
    if (!asked || !adminOnly) throw err;
    return signInWith(false, opts, deps);
  }
}

async function signInWith(
  withChannelHistory: boolean,
  opts: BrowserLoginOptions,
  deps: TeamsSignInDeps
): Promise<TeamsSignIn> {
  const clientId = teamsClientId(deps.env);
  const app = teamsApp(withChannelHistory);
  const callback = await authorizeInBrowser(clientId, deps, opts, app.scope);
  const tokens: TokenSet = await requestToken(
    clientId,
    {
      grant_type: "authorization_code",
      code: callback.code,
      redirect_uri: callback.redirectUri,
      code_verifier: callback.verifier,
    },
    deps,
    [callback.code, callback.verifier],
    app
  );
  const me = await graphRequest<{
    id?: string;
    displayName?: string;
    mail?: string;
    userPrincipalName?: string;
  }>(tokens.accessToken, "GET", `${GRAPH_BASE}/me`, undefined, deps.graph ?? {});
  if (!me.id) throw new IntegrationError("bad_request", "Microsoft did not return a profile.");
  const email = me.mail ?? me.userPrincipalName;
  return {
    secret: serializeTokenSet(tokens),
    user: {
      id: me.id,
      name: me.displayName ?? email ?? "signed-in user",
      ...(email ? { email } : {}),
    },
    scopes: scopesFromAccessToken(tokens.accessToken),
  };
}

/** Trade the stored refresh token for fresh tokens (keeping the scopes the account has). */
export function refreshTeamsTokens(
  current: TokenSet,
  withChannelHistory: boolean,
  deps: OAuthDeps = {}
): Promise<TokenSet> {
  return requestToken(
    teamsClientId(deps.env),
    { grant_type: "refresh_token", refresh_token: current.refreshToken },
    deps,
    [current.refreshToken, current.accessToken],
    teamsApp(withChannelHistory)
  );
}
