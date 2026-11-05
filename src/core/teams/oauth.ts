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
import { ADMIN_APPROVAL_MESSAGE, isGuid } from "../integrations/oauthRegistration";
import { IntegrationError } from "../integrations/types";
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

/** A Teams-only client ID baked into a build. Empty on purpose; see `teamsClientId`. */
export const KAI_TEAMS_CLIENT_ID = "";

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

/**
 * The Entra app id: `KAI_TEAMS_CLIENT_ID`, else the registration Azure DevOps sign-in
 * uses (`KAI_AZURE_CLIENT_ID`, or the app built into Kai).
 */
export function teamsClientId(env: NodeJS.ProcessEnv = process.env): string {
  const own = (env.KAI_TEAMS_CLIENT_ID?.trim() || KAI_TEAMS_CLIENT_ID).trim();
  if (own) {
    if (isGuid(own)) return own;
    throw new IntegrationError(
      "config",
      "KAI_TEAMS_CLIENT_ID is not a valid client ID.",
      "Set it to the Application (client) ID (a GUID), or remove it to use the Azure DevOps registration."
    );
  }
  try {
    return clientIdFrom(env);
  } catch (err) {
    // A malformed KAI_AZURE_* value is its own problem; do not hide it as "not set up".
    if (err instanceof IntegrationError && /^KAI_AZURE_/.test(err.message)) throw err;
    throw new IntegrationError(
      "config",
      "Microsoft Teams sign-in is not set up in this build of Kai.",
      "This build has no Microsoft Entra app ID yet. Set KAI_TEAMS_CLIENT_ID (or KAI_AZURE_CLIENT_ID) to try one now (see docs/teams-sign-in.md)."
    );
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
