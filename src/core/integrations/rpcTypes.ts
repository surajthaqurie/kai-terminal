/**
 * The JSON contract of `kai <provider> rpc`, the one entry point the desktop
 * app uses. The app writes ONE request object to the CLI's stdin and reads ONE
 * JSON line from stdout, so secrets never appear in an argument list and the
 * app holds no integration logic of its own. Errors are in-band
 * (`ok: false`); the process exits 0 whenever it produced a response.
 *
 * Pure types: no Node imports, safe for the UI bundle.
 */
import type { IntegrationAuthMethod } from "./providerCatalog";
import type { WorkflowRules } from "./workflowRules";
import type { OAuthRegistrationView } from "./oauthRegistration";

export type { OAuthRegistrationView } from "./oauthRegistration";

export interface IntegrationAccountView {
  /** Stable id such as `azure-devops:contoso`. */
  id: string;
  provider: string;
  org: string;
  baseUrl: string;
  authMethod: IntegrationAuthMethod;
  /** Display name captured at login; absent for older accounts. */
  user?: string;
  /** False when a PAT account has no stored secret (needs a new login). */
  hasCredential: boolean;
  /** True when this account is bound to the requested project. */
  usedByThisProject: boolean;
}

export interface IntegrationBindingView {
  account: string;
  provider: string;
  project: string;
  repo: string | null;
  boundAt: string;
  /** The workflow rules in force: the user's changes on top of the defaults. */
  rules: WorkflowRules;
  /**
   * True when the user let agents change data in the service for this project
   * (comment, create a pull request, change a state). Off unless turned on.
   */
  writeTools?: boolean;
}

export interface DetectedCoordinates {
  org: string;
  project: string;
  repo: string | null;
  baseUrl: string;
  /**
   * True when `baseUrl` is only a guess derived from an SSH remote of a self-hosted
   * server (SSH and web addresses can differ in port and virtual directory). Ask
   * the person to confirm it before signing in to it; never send a credential to it unasked.
   */
  needsConfirmation?: true;
}

export type ProjectIntegrationState =
  /** Nothing bound. */
  | "none"
  /** Bound and the account has what it needs. */
  | "ready"
  /** Bound, but the account's secret is gone. */
  | "signed_out"
  /** Bound to an account that no longer exists. */
  | "account_missing";

export interface IntegrationStatusView {
  provider: { id: string; label: string };
  accounts: IntegrationAccountView[];
  project: {
    dir: string;
    state: ProjectIntegrationState;
    binding: IntegrationBindingView | null;
    /** Parsed from the git remote; null when the repo has no recognizable remote. */
    detected: DetectedCoordinates | null;
    /** Provider id of a DIFFERENT integration already bound here, if any. */
    otherProvider: string | null;
  };
  /** Whether the Azure CLI (`az`) was found on PATH. */
  azCli: boolean;
  /** Whether browser sign-in can start (this build has a Microsoft Entra app, or an environment override). */
  oauth: OAuthRegistrationView;
}

export type IntegrationErrorCode =
  | "bad_request"
  | "auth"
  | "forbidden"
  | "not_found"
  | "rate_limited"
  | "network"
  | "config"
  | "no_account"
  | "no_remote"
  | "needs_confirmation"
  | "unavailable";

export interface IntegrationErrorBody {
  code: IntegrationErrorCode;
  message: string;
  /** What to do next, phrased as a command or an action. */
  hint?: string;
}

export type IntegrationRpcRequest =
  | { op: "status"; projectDir: string }
  /** Open the browser, sign in, and save an account for every organization reached. */
  | { op: "login_browser" }
  | {
      op: "login";
      org: string;
      /** The command-line fallbacks; browser sign-in is `login_browser`. */
      authMethod: Exclude<IntegrationAuthMethod, "oauth">;
      /** Required for `pat`. Never logged, never echoed back. */
      pat?: string;
      /** Azure DevOps Server only; defaults to https://dev.azure.com/<org>. */
      baseUrl?: string;
    }
  | { op: "verify"; account: string }
  /** Projects the account can reach (network call). */
  | { op: "projects"; account: string }
  /** Repositories of one project (network call). */
  | { op: "repos"; account: string; project: string }
  | { op: "logout"; account: string }
  | {
      op: "bind";
      projectDir: string;
      /** Defaults to the account matching the git remote's org. */
      account?: string;
      /**
       * Defaults to the git remote. When given, it is checked against the
       * account's real projects (and `repo` against that project's repositories)
       * and stored with its canonical spelling: this is how the active project is switched.
       */
      project?: string;
      repo?: string | null;
      /** Replace a different integration already bound here. */
      replace?: boolean;
    }
  | { op: "unbind"; projectDir: string; logout?: boolean }
  /**
   * Replace the project's workflow rules. Omitted fields go back to their
   * default, so `rules: {}` resets everything. Invalid values, and a merge
   * branch the repository does not have, are rejected.
   */
  | { op: "set_rules"; projectDir: string; rules: Partial<WorkflowRules> }
  /**
   * Turn the project's agent WRITE tools on or off. Off by default. Turning them on is
   * refused when an AI agent's session is running the command: only a person decides.
   */
  | { op: "set_write_tools"; projectDir: string; enabled: boolean }
  | TeamsRpcRequest;

/**
 * Microsoft Teams, from the Integrations tab. The account is the person's own, not
 * tied to a folder, so these carry no `projectDir`. No token ever crosses this
 * boundary in either direction.
 */
export type TeamsRpcRequest =
  | { op: "teams_status" }
  /**
   * Open the browser and sign in. Reading channel messages is asked for by default and
   * dropped automatically when the organization needs an administrator to approve it.
   */
  | { op: "teams_login" }
  /** Call Microsoft Graph with the saved sign-in and report what it can reach. */
  | { op: "teams_verify" }
  | { op: "teams_logout" };

export interface TeamsStatusView {
  /** False when this build has no Microsoft Entra app to sign in with. */
  configured: boolean;
  account: { id: string; name: string; email?: string; signedInAt: string } | null;
  /** Permission to read channel messages (needs administrator approval) was granted. */
  channelHistory: boolean;
}

export interface TeamsAccessView {
  user: IntegrationUser;
  teams: number;
  /** null when chats could not be read; see `chatsError`. */
  chats: number | null;
  chatsError?: string;
  channelHistory: boolean;
}

export type TeamsRpcResponse =
  | { ok: true; teams: TeamsStatusView }
  | { ok: true; access: TeamsAccessView }
  | { ok: false; error: IntegrationErrorBody };

export interface IntegrationUser {
  name: string;
  email?: string;
}

export interface IntegrationProjectView {
  name: string;
  description?: string;
}

export interface IntegrationRepoView {
  name: string;
  defaultBranch?: string;
}

export type IntegrationRpcResponse =
  | { ok: true; status: IntegrationStatusView }
  | { ok: true; projects: IntegrationProjectView[] }
  | { ok: true; repos: IntegrationRepoView[] }
  | { ok: true; account: IntegrationAccountView; user: IntegrationUser }
  | { ok: true; accounts: IntegrationAccountView[]; user: IntegrationUser }
  | { ok: true; user: IntegrationUser }
  | { ok: true; binding: IntegrationBindingView }
  | { ok: true; done: true }
  | { ok: true; teams: TeamsStatusView }
  | { ok: true; access: TeamsAccessView }
  | { ok: false; error: IntegrationErrorBody };

/** Command-line spelling the app runs: `kai azure rpc`. */
export const INTEGRATION_RPC_SUBCOMMAND = "rpc";
