import { invoke } from "@tauri-apps/api/core";
import { isTauriAvailable } from "./ptyService";
import type {
  IntegrationAccountView,
  IntegrationBindingView,
  IntegrationErrorBody,
  IntegrationProjectView,
  IntegrationRepoView,
  IntegrationRpcRequest,
  IntegrationRpcResponse,
  IntegrationStatusView,
  IntegrationUser,
  TeamsAccessView,
  TeamsStatusView,
} from "../core/integrations/rpcTypes";
import type { WorkflowRules } from "../core/integrations/workflowRules";

type Failure = { ok: false; error: IntegrationErrorBody };

function unavailable(message: string): Failure {
  return { ok: false, error: { code: "unavailable", message } };
}

function isFailure(value: unknown): value is Failure {
  if (typeof value !== "object" || value === null) return false;
  const v = value as { ok?: unknown; error?: { code?: unknown; message?: unknown } };
  return (
    v.ok === false && typeof v.error?.code === "string" && typeof v.error?.message === "string"
  );
}

/**
 * Sends one request to `kai azure rpc` through the desktop shell. The CLI owns
 * every integration rule; this only moves JSON. It never throws: outside the
 * desktop app, on an IPC failure or on a malformed reply it resolves with an
 * `unavailable` error the UI can show.
 */
export async function integrationRpc(req: IntegrationRpcRequest): Promise<IntegrationRpcResponse> {
  if (!isTauriAvailable()) {
    return unavailable(
      "Integrations are managed by the desktop app. Use `kai integration azure` in a Kai Terminal tab."
    );
  }
  let raw: string;
  try {
    raw = await invoke<string>("run_integration_rpc_cmd", { requestJson: JSON.stringify(req) });
  } catch (err) {
    // The Rust side never includes the request in its messages.
    const message = typeof err === "string" && err ? err : "Could not reach the kai CLI.";
    // An older `kai` earlier on PATH does not know `azure rpc` and prints nothing usable.
    if (/returned no response|unexpected response/i.test(message)) {
      return unavailable(
        "The kai CLI did not understand the request. An older kai may be first on PATH: update it (npm i -g kai-terminal) or run `kai doctor`."
      );
    }
    return unavailable(message);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return unavailable("The kai CLI returned an unreadable response.");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as { ok?: unknown }).ok !== "boolean"
  ) {
    return unavailable("The kai CLI returned an unexpected response.");
  }
  if ((parsed as { ok: boolean }).ok === false && !isFailure(parsed)) {
    return unavailable("The kai CLI reported an error without details.");
  }
  return parsed as IntegrationRpcResponse;
}

export type RpcResult<T> = { ok: true; value: T } | Failure;

function pick<T>(
  res: IntegrationRpcResponse,
  guard: (r: Record<string, unknown>) => boolean,
  map: (r: Record<string, unknown>) => T
): RpcResult<T> {
  if (!res.ok) return res;
  const body = res as unknown as Record<string, unknown>;
  if (!guard(body)) return unavailable("The kai CLI returned an unexpected response.");
  return { ok: true, value: map(body) };
}

export async function getIntegrationStatus(
  projectDir: string
): Promise<RpcResult<IntegrationStatusView>> {
  const res = await integrationRpc({ op: "status", projectDir });
  return pick(
    res,
    (r) => typeof r.status === "object" && r.status !== null,
    (r) => r.status as IntegrationStatusView
  );
}

/**
 * Sign in through the browser. The CLI opens the sign-in page, waits for the
 * redirect and saves an account for every organization the user belongs to, so
 * nothing is typed. This call returns once the user has finished (or gave up).
 */
export async function loginWithBrowser(): Promise<
  RpcResult<{ accounts: IntegrationAccountView[]; user: IntegrationUser }>
> {
  const res = await integrationRpc({ op: "login_browser" });
  return pick(
    res,
    (r) => Array.isArray(r.accounts) && typeof r.user === "object",
    (r) => ({
      accounts: r.accounts as IntegrationAccountView[],
      user: r.user as IntegrationUser,
    })
  );
}

/**
 * Sign in to an Azure DevOps Server with an access token. The CLI verifies the
 * token against the server first and stores it in the OS secret store only when
 * the server accepts it. The token travels in the request on the CLI's stdin
 * (never in an argument list) and is never echoed back. `baseUrl` must already
 * be validated (`validateServerForm`); the CLI checks it again.
 */
export async function loginWithToken(input: {
  baseUrl: string;
  token: string;
}): Promise<RpcResult<{ account: IntegrationAccountView; user: IntegrationUser }>> {
  const res = await integrationRpc({
    op: "login",
    // Unused for a Server: its account is named by the address.
    org: "",
    authMethod: "pat",
    pat: input.token,
    baseUrl: input.baseUrl,
  });
  return pick(
    res,
    (r) => typeof r.account === "object" && r.account !== null && typeof r.user === "object",
    (r) => ({ account: r.account as IntegrationAccountView, user: r.user as IntegrationUser })
  );
}

/** The account's projects. A network call: only ask when the user opens a picker. */
export async function listProjects(account: string): Promise<RpcResult<IntegrationProjectView[]>> {
  const res = await integrationRpc({ op: "projects", account });
  return pick(
    res,
    (r) => Array.isArray(r.projects),
    (r) => r.projects as IntegrationProjectView[]
  );
}

/** Repositories of one project of the account (also a network call). */
export async function listRepos(
  account: string,
  project: string
): Promise<RpcResult<IntegrationRepoView[]>> {
  const res = await integrationRpc({ op: "repos", account, project });
  return pick(
    res,
    (r) => Array.isArray(r.repos),
    (r) => r.repos as IntegrationRepoView[]
  );
}

export async function verifyIntegration(account: string): Promise<RpcResult<IntegrationUser>> {
  const res = await integrationRpc({ op: "verify", account });
  return pick(
    res,
    (r) => typeof r.user === "object" && r.user !== null,
    (r) => r.user as IntegrationUser
  );
}

export async function logoutIntegration(account: string): Promise<RpcResult<true>> {
  const res = await integrationRpc({ op: "logout", account });
  return pick(
    res,
    (r) => r.done === true,
    () => true as const
  );
}

export async function bindIntegration(input: {
  projectDir: string;
  account?: string;
  project?: string;
  repo?: string | null;
  replace?: boolean;
}): Promise<RpcResult<IntegrationBindingView>> {
  const res = await integrationRpc({ op: "bind", ...input });
  return pick(
    res,
    (r) => typeof r.binding === "object" && r.binding !== null,
    (r) => r.binding as IntegrationBindingView
  );
}

/** Saves the project's workflow rules (omitted fields reset to their defaults). */
export async function setIntegrationRules(
  projectDir: string,
  rules: Partial<WorkflowRules>
): Promise<RpcResult<IntegrationBindingView>> {
  const res = await integrationRpc({ op: "set_rules", projectDir, rules });
  return pick(
    res,
    (r) => typeof r.binding === "object" && r.binding !== null,
    (r) => r.binding as IntegrationBindingView
  );
}

// ---------------------------------------------------------------------------
// Microsoft Teams: the person's own account, not tied to a folder.
// ---------------------------------------------------------------------------

const isTeamsStatus = (r: Record<string, unknown>) =>
  typeof r.teams === "object" && r.teams !== null;

export async function getTeamsStatus(): Promise<RpcResult<TeamsStatusView>> {
  const res = await integrationRpc({ op: "teams_status" });
  return pick(res, isTeamsStatus, (r) => r.teams as TeamsStatusView);
}

/**
 * Sign in to Microsoft Teams through the browser. The CLI opens the sign-in page,
 * waits for the redirect and keeps the token in the OS secret store; this call
 * returns once the person has finished (or gave up). Permission to read channel
 * messages is asked for too; the returned status says whether it was granted.
 */
export async function teamsLogin(): Promise<RpcResult<TeamsStatusView>> {
  const res = await integrationRpc({ op: "teams_login" });
  return pick(res, isTeamsStatus, (r) => r.teams as TeamsStatusView);
}

export async function verifyTeams(): Promise<RpcResult<TeamsAccessView>> {
  const res = await integrationRpc({ op: "teams_verify" });
  return pick(
    res,
    (r) => typeof r.access === "object" && r.access !== null,
    (r) => r.access as TeamsAccessView
  );
}

export async function teamsLogout(): Promise<RpcResult<TeamsStatusView>> {
  const res = await integrationRpc({ op: "teams_logout" });
  return pick(res, isTeamsStatus, (r) => r.teams as TeamsStatusView);
}

export async function unbindIntegration(
  projectDir: string,
  logout = false
): Promise<RpcResult<true>> {
  const res = await integrationRpc({ op: "unbind", projectDir, logout });
  return pick(
    res,
    (r) => r.done === true,
    () => true as const
  );
}
