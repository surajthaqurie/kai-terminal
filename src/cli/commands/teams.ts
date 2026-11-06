import { defaultSecretStore, type SecretStore } from "../../core/integrations/secretStore";
import { IntegrationError, asIntegrationError } from "../../core/integrations/types";
import { checkClientId, isGuid } from "../../core/integrations/oauthRegistration";
import {
  clearTeamsAccount,
  getTeamsAccount,
  saveTeamsClientId,
  teamsSecretKey,
  type TeamsAccount,
} from "../../core/teams/config";
import { GraphClient } from "../../core/teams/graph";
import { assertNotAgentSession, type GuardDeps } from "../../core/teams/guard";
import {
  CHANNEL_READ_SCOPE,
  signInToTeams,
  TEAMS_SETUP_HINT,
  teamsClientId,
} from "../../core/teams/oauth";
import { storeTeamsSignIn, TeamsSession } from "../../core/teams/session";
import { runChat } from "../teams/app";
import { ask, confirm, isInteractive } from "../prompt";

/**
 * `kai integration teams` (sign in, check access, sign out) and `kai teams`
 * (the chat). The chat is the only thing that uses the sign-in: there is no
 * command that lists, reads or posts without a person at the keyboard, and
 * both commands refuse to run inside an AI agent's session.
 */

function fail(err: unknown): number {
  const e = err instanceof IntegrationError ? err : asIntegrationError(err);
  console.error(`[kai] Error: ${e.message}`);
  if (e.hint) console.error(`  ${e.hint}`);
  return 1;
}

export interface TeamsDeps {
  env?: NodeJS.ProcessEnv;
  interactive?: () => boolean;
  chat?: typeof runChat;
  /** Test seam: build the Graph client for an account. */
  connect?: (account: TeamsAccount) => { graph: GraphClient; session: TeamsSession };
  signIn?: typeof signInToTeams;
  /** Test seam: where the token is kept (default: the OS secret store). */
  secrets?: SecretStore;
  /** Test seam: the processes above this one (default: read from the OS). */
  processes?: GuardDeps["processes"];
}

function connectDefault(account: TeamsAccount): { graph: GraphClient; session: TeamsSession } {
  const session = new TeamsSession({ account });
  return { graph: new GraphClient(() => session.accessToken()), session };
}

// ---------------------------------------------------------------------------
// kai integration teams
// ---------------------------------------------------------------------------

function printSetupHelp(): void {
  console.log(`
Kai Microsoft Teams

Usage:
  kai integration teams            Sign in with Microsoft and check access
  kai integration teams remove     Sign out and forget this account

Options:
  --client-id <ID>  The Microsoft Entra Application (client) ID Kai signs in with. Saved on
                    this computer, so you enter it once. Needed only when this build of Kai
                    has none (see docs/teams-sign-in.md). It is not a secret.
  --channels    Sign in again to add permission to read channel messages, for an account
                that was signed in without it (it is asked for by default; if your
                organization needs an administrator to approve it, Kai signs in without it
                and says so)

Then run: kai teams
`);
}

export async function runTeamsSetup(args: string[], deps: TeamsDeps = {}): Promise<number> {
  try {
    const env = deps.env ?? process.env;
    const { rest, clientId } = takeClientIdOption(args);
    const flags = new Set(rest.filter((a) => a.startsWith("-")));
    const words = rest.filter((a) => !a.startsWith("-"));
    if (flags.has("--help") || flags.has("-h")) {
      printSetupHelp();
      return 0;
    }
    await assertNotAgentSession(env, { processes: deps.processes });
    const unknown = [...flags].filter((f) => f !== "--channels");
    if (unknown.length > 0 || words.length > 1 || (words.length === 1 && words[0] !== "remove")) {
      throw new IntegrationError(
        "bad_request",
        `Unknown option ${[...unknown, ...words.filter((w) => w !== "remove")].join(" ")}.`,
        "Run `kai integration teams --help`."
      );
    }
    if (words[0] === "remove") return await runRemove(deps);

    if (clientId !== undefined) saveClientId(clientId);

    const connect = deps.connect ?? connectDefault;
    const wantChannels = flags.has("--channels");

    console.log(`\nMicrosoft Teams setup\n`);
    console.log(`▸ Sign-in`);
    let account = getTeamsAccount();
    if (account && wantChannels && !account.scopes.includes(CHANNEL_READ_SCOPE)) {
      console.log(`  Signing in again to add permission to read channel messages.`);
      account = null;
    } else if (account) {
      try {
        const who = await connect(account).graph.me();
        console.log(`  ✔ Signed in as ${who.name}${who.email ? ` (${who.email})` : ""}`);
      } catch (err) {
        if (!(err instanceof IntegrationError) || err.code !== "auth") throw err;
        console.log(`  ! The saved sign-in no longer works: ${err.message}`);
        account = null;
      }
    } else {
      console.log(`  Not signed in yet.`);
    }
    if (!account) {
      // Fail before opening a browser when Kai has no Microsoft app to sign in with. At a
      // keyboard, offer to take the ID now instead of sending the person away.
      if (!deps.signIn) await ensureClientId(env, deps);
      console.log(`  Opening your browser to sign in to Microsoft...`);
      const signedIn = await (deps.signIn ?? signInToTeams)(
        {
          onUrl: (url) => console.log(`  If it does not open, visit this address:\n    ${url}`),
        },
        { env }
      );
      const stored = await storeTeamsSignIn(signedIn, deps.secrets);
      account = stored.account;
      console.log(`  ✔ Signed in as ${account.name}${account.email ? ` (${account.email})` : ""}`);
      if (stored.storedIn === "file") {
        console.log(
          `  Note: no OS secret store was available, so the sign-in is kept in a private file under ~/.kai/credentials.`
        );
      }
    }

    console.log(`\n▸ Access`);
    const { graph, session } = connect(account);
    const teams = await graph.joinedTeams();
    console.log(`  ✔ Teams and channels   ${teams.length} team${teams.length === 1 ? "" : "s"}`);
    try {
      const chats = await graph.chats(account.id);
      console.log(`  ✔ Chats                ${chats.length} chat${chats.length === 1 ? "" : "s"}`);
    } catch (err) {
      console.log(`  ✖ Chats                ${asIntegrationError(err).message}`);
    }
    if (session.canReadChannels) {
      console.log(`  ✔ Channel messages     can be read`);
    } else {
      console.log(`  – Channel messages     not approved (chats and sending to channels work)`);
      console.log(`      Your organization needs an administrator to approve Kai for this.`);
      console.log(`      After it is approved, run: kai integration teams --channels`);
    }
    console.log(`\nDone. Run \`kai teams\` to chat.\n`);
    return 0;
  } catch (err) {
    return fail(err);
  }
}

/** Pull `--client-id <ID>` / `--client-id=<ID>` out of the arguments. */
function takeClientIdOption(args: string[]): { rest: string[]; clientId?: string } {
  const rest: string[] = [];
  let clientId: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--client-id") {
      const value = args[i + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new IntegrationError(
          "bad_request",
          "--client-id needs the Application (client) ID.",
          "Example: kai integration teams --client-id <Application (client) ID from your Entra app>"
        );
      }
      clientId = value;
      i++;
    } else if (a.startsWith("--client-id=")) {
      clientId = a.slice("--client-id=".length);
    } else {
      rest.push(a);
    }
  }
  return { rest, ...(clientId !== undefined ? { clientId } : {}) };
}

function saveClientId(raw: string): string {
  const id = raw.trim();
  const problem = checkClientId(id);
  if (problem) {
    throw new IntegrationError(
      "bad_request",
      isGuid(id)
        ? "That is not a real Application (client) ID."
        : "That is not a valid Application (client) ID.",
      problem
    );
  }
  saveTeamsClientId(id);
  console.log(`  ✔ Saved the Microsoft app ID on this computer.`);
  return id;
}

/** Make sure a Microsoft app ID is known; at a keyboard, ask for it and keep it. */
async function ensureClientId(env: NodeJS.ProcessEnv, deps: TeamsDeps): Promise<void> {
  try {
    teamsClientId(env);
    return;
  } catch (err) {
    const notSetUp = err instanceof IntegrationError && err.code === "config";
    const malformedEnv = notSetUp && /^KAI_/.test(err.message);
    if (!notSetUp || malformedEnv || !(deps.interactive ?? isInteractive)()) throw err;
  }
  console.log(`  Kai needs a Microsoft Entra app ID to sign you in (a one-time step).`);
  console.log(`  Where to find it: https://entra.microsoft.com > Identity > Applications >`);
  console.log(`  App registrations > your Kai app > Overview > "Application (client) ID".`);
  console.log(
    `  No app yet? Register one (multi-tenant, public client, redirect http://localhost):`
  );
  console.log(
    `  see docs/teams-sign-in.md. Use the Application ID, not the Directory or Object ID.`
  );
  const answer = (await ask(`  Application (client) ID (Enter to cancel): `)).trim();
  if (!answer)
    throw new IntegrationError("config", "No Microsoft app ID entered.", TEAMS_SETUP_HINT);
  saveClientId(answer);
}

async function runRemove(deps: TeamsDeps): Promise<number> {
  const account = getTeamsAccount();
  if (!account) {
    console.log(`[kai] You are not signed in to Microsoft Teams.`);
    return 0;
  }
  if (!(deps.interactive ?? isInteractive)()) {
    console.error(`[kai] Signing out needs an interactive terminal.`);
    return 1;
  }
  if (!(await confirm(`Sign ${account.name} out of Microsoft Teams?`, true))) {
    console.log(`Cancelled.`);
    return 1;
  }
  await (deps.secrets ?? defaultSecretStore()).delete(teamsSecretKey(account.id));
  clearTeamsAccount();
  console.log(`✔ Signed out of Microsoft Teams. Run \`kai integration teams\` to sign in again.`);
  return 0;
}

// ---------------------------------------------------------------------------
// kai teams
// ---------------------------------------------------------------------------

function printTeamsHelp(): void {
  console.log(`
Kai Teams (Microsoft Teams in your terminal)

Usage:
  kai teams        Open the chat in this tab

First time: kai integration teams

Your teams, channels and chats are on the left, the conversation on the right.
Everything is clickable. Ctrl+V pastes a copied image or file, and pictures others
send appear in the conversation. Press Esc to leave.
`);
}

export async function runTeams(args: string[], deps: TeamsDeps = {}): Promise<number> {
  try {
    const rest = args.slice(1);
    if (rest.some((a) => a === "--help" || a === "-h" || a === "help")) {
      printTeamsHelp();
      return 0;
    }
    await assertNotAgentSession(deps.env ?? process.env, { processes: deps.processes });
    if (rest.length > 0) {
      throw new IntegrationError(
        "bad_request",
        `kai teams takes no options (got "${rest[0]}").`,
        "Just run: kai teams"
      );
    }
    const interactive = deps.interactive ?? isInteractive;
    if (!interactive()) {
      throw new IntegrationError(
        "bad_request",
        "The Teams chat needs an interactive terminal.",
        "Run kai teams yourself in a terminal tab."
      );
    }
    let account = getTeamsAccount();
    if (!account) {
      console.error(`[kai] You are not signed in to Microsoft Teams.`);
      if (!(await confirm(`Sign in now?`, true))) {
        console.error(`  Run: kai integration teams`);
        return 1;
      }
      if ((await runTeamsSetup([], deps)) !== 0) return 1;
      account = getTeamsAccount();
      if (!account) return 1;
    }
    const { graph, session } = (deps.connect ?? connectDefault)(account);
    return await (deps.chat ?? runChat)({
      graph,
      account,
      canReadChannels: session.canReadChannels,
      env: deps.env ?? process.env,
    });
  } catch (err) {
    return fail(err);
  }
}
