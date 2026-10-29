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
} from "../core/integrations/rpcTypes";
import type { IntegrationAuthMethod } from "../core/integrations/providerCatalog";

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

export async function loginIntegration(input: {
  org: string;
  authMethod: IntegrationAuthMethod;
  pat?: string;
  baseUrl?: string;
}): Promise<RpcResult<{ account: IntegrationAccountView; user: IntegrationUser }>> {
  const res = await integrationRpc({ op: "login", ...input });
  return pick(
    res,
    (r) => typeof r.account === "object" && typeof r.user === "object",
    (r) => ({
      account: r.account as IntegrationAccountView,
      user: r.user as IntegrationUser,
    })
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
