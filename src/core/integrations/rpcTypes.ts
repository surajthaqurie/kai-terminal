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
}

export interface DetectedCoordinates {
  org: string;
  project: string;
  repo: string | null;
  baseUrl: string;
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
  | { op: "unbind"; projectDir: string; logout?: boolean };

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
  | { ok: false; error: IntegrationErrorBody };

/** Command-line spelling the app runs: `kai azure rpc`. */
export const INTEGRATION_RPC_SUBCOMMAND = "rpc";
