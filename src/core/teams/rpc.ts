import { defaultSecretStore, type SecretStore } from "../integrations/secretStore";
import { asIntegrationError, IntegrationError } from "../integrations/types";
import type {
  TeamsAccessView,
  TeamsRpcRequest,
  TeamsRpcResponse,
  TeamsStatusView,
} from "../integrations/rpcTypes";
import { clearTeamsAccount, getTeamsAccount, teamsSecretKey, type TeamsAccount } from "./config";
import { GraphClient } from "./graph";
import { assertNotAgentSession } from "./guard";
import { CHANNEL_READ_SCOPE, signInToTeams, teamsClientId } from "./oauth";
import { storeTeamsSignIn, TeamsSession } from "./session";

/**
 * The desktop app's side of Microsoft Teams: the Integrations tab asks the CLI to
 * sign in, check access and sign out, exactly like `kai integration teams`.
 *
 * The same rules as the command line apply. The sign-in belongs to the person, so
 * every operation refuses to run inside an AI agent's session. The access token is
 * never returned: the tab only ever learns who is signed in and what was granted.
 */

export interface TeamsRpcDeps {
  env?: NodeJS.ProcessEnv;
  secrets?: SecretStore;
  /** Throws when an AI agent is running this command. Test seam. */
  agentGuard?: () => Promise<void>;
  /** Test seams: the browser sign-in and the Graph client. */
  signIn?: typeof signInToTeams;
  connect?: (account: TeamsAccount) => { graph: GraphClient; session: TeamsSession };
}

function connectDefault(
  account: TeamsAccount,
  secrets?: SecretStore
): { graph: GraphClient; session: TeamsSession } {
  const session = new TeamsSession({ account, ...(secrets ? { secrets } : {}) });
  return { graph: new GraphClient(() => session.accessToken()), session };
}

/** Whether this build has a Microsoft app to sign in with (no network, no secret). */
function isConfigured(env: NodeJS.ProcessEnv): boolean {
  try {
    teamsClientId(env);
    return true;
  } catch {
    return false;
  }
}

export function teamsStatus(env: NodeJS.ProcessEnv = process.env): TeamsStatusView {
  const account = getTeamsAccount();
  return {
    configured: isConfigured(env),
    account: account
      ? {
          id: account.id,
          name: account.name,
          ...(account.email ? { email: account.email } : {}),
          signedInAt: account.signedInAt,
        }
      : null,
    channelHistory: account ? account.scopes.includes(CHANNEL_READ_SCOPE) : false,
  };
}

async function signedInAccount(): Promise<TeamsAccount> {
  const account = getTeamsAccount();
  if (!account) {
    throw new IntegrationError(
      "no_account",
      "You are not signed in to Microsoft Teams.",
      "Connect Microsoft Teams first."
    );
  }
  return account;
}

async function checkAccess(deps: TeamsRpcDeps): Promise<TeamsAccessView> {
  const account = await signedInAccount();
  const { graph, session } = (deps.connect ?? ((a) => connectDefault(a, deps.secrets)))(account);
  const who = await graph.me();
  const teams = await graph.joinedTeams();
  let chats: number | null = null;
  let chatsError: string | undefined;
  try {
    chats = (await graph.chats(account.id)).length;
  } catch (err) {
    chatsError = asIntegrationError(err).message;
  }
  return {
    user: { name: who.name, ...(who.email ? { email: who.email } : {}) },
    teams: teams.length,
    chats,
    ...(chatsError ? { chatsError } : {}),
    channelHistory: session.canReadChannels,
  };
}

/**
 * Browser sign-in. Channel messages are asked for by default (and dropped automatically
 * when the organization needs an administrator to approve them). Fails before opening a
 * browser when the build has no Microsoft app.
 */
async function login(deps: TeamsRpcDeps): Promise<TeamsStatusView> {
  const env = deps.env ?? process.env;
  if (!deps.signIn) teamsClientId(env);
  const signedIn = await (deps.signIn ?? signInToTeams)({}, { env });
  await storeTeamsSignIn(signedIn, deps.secrets);
  return teamsStatus(env);
}

async function logout(deps: TeamsRpcDeps): Promise<void> {
  const account = getTeamsAccount();
  if (!account) return;
  await (deps.secrets ?? defaultSecretStore()).delete(teamsSecretKey(account.id));
  clearTeamsAccount();
}

export async function handleTeamsRpc(
  request: TeamsRpcRequest,
  deps: TeamsRpcDeps = {}
): Promise<TeamsRpcResponse> {
  await (deps.agentGuard ?? (() => assertNotAgentSession(deps.env)))();
  switch (request.op) {
    case "teams_status":
      return { ok: true, teams: teamsStatus(deps.env) };
    case "teams_login":
      return { ok: true, teams: await login(deps) };
    case "teams_verify":
      return { ok: true, access: await checkAccess(deps) };
    case "teams_logout":
      await logout(deps);
      return { ok: true, teams: teamsStatus(deps.env) };
    default:
      throw new IntegrationError("bad_request", "Unknown operation.");
  }
}
